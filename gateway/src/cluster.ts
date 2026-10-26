import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** What the provisioner needs to know about a namespace of a store or hosted server. */
export interface NamespaceState {
  /** The owner id label the provisioner put on the namespace; undefined on a namespace it did not create. */
  ownerId?: string;
  terminating: boolean;
}

/** Status of a Helm release, such as 'deployed' or 'pending-install'. */
export type ReleaseStatus = string;

/** A chart the provisioner installs, one release per namespace. */
export interface HelmChart {
  release: string;
  path: string;
  /** Values files applied before the per-release values, such as the image overrides of values-local.yaml. */
  valuesFiles: string[];
}

/** The Kubernetes and Helm operations the provisioner uses, so its logic can be tested without a cluster. */
export interface StoreCluster {
  getNamespace(name: string): Promise<NamespaceState | undefined>;
  createNamespace(name: string, ownerId: string): Promise<void>;
  /** Grants the provisioner the store role inside the namespace. Safe to repeat. */
  grantStoreRole(namespace: string): Promise<void>;
  deleteNamespace(name: string): Promise<void>;
  /** Creates the Secret unless one of that name exists, which is kept as it is. */
  createSecretIfAbsent(namespace: string, name: string, data: Record<string, string>): Promise<void>;
  releaseStatus(namespace: string, release: string): Promise<ReleaseStatus | undefined>;
  uninstallRelease(namespace: string, release: string, signal: AbortSignal): Promise<void>;
  /** Runs helm upgrade --install and waits for the workloads and any hook Jobs. Throws HelmError. */
  installRelease(
    namespace: string,
    chart: HelmChart,
    values: Record<string, unknown>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void>;
}

/** A failed Helm command. The message is Helm's first error line, which names resources but no secrets. */
export class HelmError extends Error {}

/** Labels that mark a namespace as the provisioner's. The admission policy in the gateway chart checks the first. */
export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const MANAGED_BY_VALUE = 'urumi-provisioner';
// Named when stores were the only kind; it holds the id of the store or hosted server that owns the
// namespace. Kept, so namespaces created before hosted servers still match.
export const OWNER_ID_LABEL = 'urumi.dev/store-id';
const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const API_TIMEOUT_MS = 10_000;
const MAX_HELM_OUTPUT_BYTES = 1_000_000;

/**
 * Talks to the Kubernetes API with the pod's service account and runs the helm binary for releases.
 * The API server's CA must be trusted through NODE_EXTRA_CA_CERTS. Helm finds the same account itself.
 */
export function createInClusterStoreCluster(options: {
  serviceAccount: { name: string; namespace: string };
  storeRole: string;
}): StoreCluster {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) throw new Error('KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT must be set.');
  const apiBase = `https://${host.includes(':') ? `[${host}]` : host}:${port}`;

  /** Calls the API and returns the response. Throws on transport errors and on unexpected statuses. */
  const request = async (method: string, path: string, body?: unknown, allowed: number[] = []) => {
    // Projected tokens rotate, so the file is read for every request.
    const token = (await readFile(`${SERVICE_ACCOUNT_DIR}/token`, 'utf8')).trim();
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok && !allowed.includes(response.status)) {
      const status = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(
        `Kubernetes API ${method} ${path} answered ${response.status}: ${status.message ?? ''}`,
      );
    }
    return response;
  };

  /** Runs helm and returns its output. Throws HelmError with Helm's first error line. */
  const helm = (args: string[], signal: AbortSignal, stdin?: string) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        'helm',
        args,
        { signal, maxBuffer: MAX_HELM_OUTPUT_BYTES },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          const firstLine = stderr.split('\n').find((line) => line.trim()) ?? error.message;
          reject(new HelmError(firstLine.replace(/^Error: /, '').slice(0, 300)));
        },
      );
      child.stdin?.end(stdin);
    });

  return {
    async getNamespace(name) {
      const response = await request('GET', `/api/v1/namespaces/${name}`, undefined, [404]);
      if (response.status === 404) return undefined;
      const namespace = (await response.json()) as {
        metadata: { labels?: Record<string, string> };
        status?: { phase?: string };
      };
      const labels = namespace.metadata.labels ?? {};
      return {
        ownerId: labels[MANAGED_BY_LABEL] === MANAGED_BY_VALUE ? labels[OWNER_ID_LABEL] : undefined,
        terminating: namespace.status?.phase === 'Terminating',
      };
    },

    async createNamespace(name, ownerId) {
      await request('POST', '/api/v1/namespaces', {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name, labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, [OWNER_ID_LABEL]: ownerId } },
      });
    },

    async grantStoreRole(namespace) {
      await request(
        'POST',
        `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`,
        {
          apiVersion: 'rbac.authorization.k8s.io/v1',
          kind: 'RoleBinding',
          metadata: { name: 'store-provisioner' },
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: options.storeRole },
          subjects: [{ kind: 'ServiceAccount', ...options.serviceAccount }],
        },
        [409],
      );
    },

    async deleteNamespace(name) {
      // Foreground deletion lists the namespace as Terminating until every object in it is gone.
      await request('DELETE', `/api/v1/namespaces/${name}`, { propagationPolicy: 'Foreground' }, [404]);
    },

    async createSecretIfAbsent(namespace, name, data) {
      await request(
        'POST',
        `/api/v1/namespaces/${namespace}/secrets`,
        { apiVersion: 'v1', kind: 'Secret', metadata: { name }, type: 'Opaque', stringData: data },
        [409],
      );
    },

    async releaseStatus(namespace, release) {
      const releases = JSON.parse(
        await helm(
          ['list', '--namespace', namespace, '--output', 'json'],
          AbortSignal.timeout(API_TIMEOUT_MS),
        ),
      ) as { name: string; status: string }[];
      return releases.find((candidate) => candidate.name === release)?.status;
    },

    async uninstallRelease(namespace, release, signal) {
      await helm(['uninstall', release, '--namespace', namespace, '--wait'], signal);
    },

    async installRelease(namespace, chart, values, timeoutMs, signal) {
      // Values go through stdin, so a store name needs no escaping for --set.
      const args = [
        'upgrade',
        '--install',
        chart.release,
        chart.path,
        '--namespace',
        namespace,
        ...chart.valuesFiles.flatMap((file) => ['--values', file]),
        '--values',
        '-',
        '--wait=watcher',
        '--timeout',
        `${Math.max(1, Math.floor(timeoutMs / 1000))}s`,
      ];
      await helm(args, signal, JSON.stringify(values));
    },
  };
}
