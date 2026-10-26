import { randomBytes } from 'node:crypto';

import { HelmError } from './cluster.js';
import type { HelmChart, StoreCluster } from './cluster.js';
import type { CredentialCipher } from './credentialCipher.js';
import type { Database, Queryable } from './db.js';
import {
  hostedServerNamespace,
  listHostedServerTasks,
  markHostedServerFailed,
  markHostedServerReady,
  removeHostedServer,
} from './hostedServers.js';
import type { HostedServerTask } from './hostedServers.js';
import { listStoreTasks, markStoreFailed, markStoreReady, removeStore, storeNamespace } from './stores.js';
import type { StoreTask } from './stores.js';

export interface ProvisionerSettings {
  /** How long one provisioning attempt may take, counted from when it started, across restarts. */
  timeoutMs: number;
}

/** A row the provisioner deploys or tears down: a store or a hosted MCP server. */
export interface DeploymentTask {
  id: string;
  slug: string;
  status: 'provisioning' | 'deleting';
  attempt: number;
  attemptStartedAt: Date;
}

/**
 * How the provisioner handles one kind of row: where it goes, which chart, Secret and values it gets,
 * and how the outcome is recorded. The steps themselves are the same for every kind.
 */
export interface DeploymentKind<T extends DeploymentTask> {
  /** The word used in logs and in reasons shown to people, such as "store". */
  noun: string;
  chart: HelmChart;
  secretName: string;
  listTasks(db: Queryable): Promise<T[]>;
  namespace(task: T): string;
  /** The Secret's data. It is created once, so a retried install keeps the first values. */
  secret(task: T): Record<string, string>;
  chartValues(task: T): Record<string, unknown>;
  markReady(db: Database, task: T): Promise<boolean>;
  markFailed(db: Queryable, task: T, reason: string): Promise<void>;
  remove(db: Queryable, id: string): Promise<void>;
}

/** The Secret the store chart reads, created by the provisioner before the chart is installed. */
export const STORE_SECRET_NAME = 'store-credentials';
/** The Secret whose keys the hosted-mcp chart passes to the server as environment variables. */
export const HOSTED_SERVER_SECRET_NAME = 'server-env';

// Each install runs a helm process and a setup Job that downloads WooCommerce. A few at a time keep
// the node responsive; the rest wait for a free slot.
const MAX_PARALLEL_PROVISIONS = 4;
const SALT_NAMES = [
  'AUTH_KEY',
  'SECURE_AUTH_KEY',
  'LOGGED_IN_KEY',
  'NONCE_KEY',
  'AUTH_SALT',
  'SECURE_AUTH_SALT',
  'LOGGED_IN_SALT',
  'NONCE_SALT',
];

/** Fresh credentials for one store, in the keys the store chart reads from its Secret. */
export function newStoreCredentials(): Record<string, string> {
  const hex = (bytes: number) => randomBytes(bytes).toString('hex');
  return {
    MARIADB_ROOT_PASSWORD: hex(24),
    MARIADB_PASSWORD: hex(24),
    WORDPRESS_ADMIN_PASSWORD: randomBytes(18).toString('base64'),
    WC_CONSUMER_KEY: `ck_${hex(20)}`,
    WC_CONSUMER_SECRET: `cs_${hex(20)}`,
    ...Object.fromEntries(SALT_NAMES.map((name) => [`WORDPRESS_${name}`, hex(32)])),
  };
}

/** The per-store chart values. Everything else comes from the values files shared by all stores. */
export function storeChartValues(task: StoreTask, gatewayNamespace: string): Record<string, unknown> {
  return { store: { url: task.url, title: task.name }, gatewayNamespace };
}

/** Stores, installed with the store chart in namespace store-<slug>. */
export function storeKind(chart: HelmChart, gatewayNamespace: string): DeploymentKind<StoreTask> {
  return {
    noun: 'store',
    chart,
    secretName: STORE_SECRET_NAME,
    listTasks: listStoreTasks,
    namespace: (task) => storeNamespace(task.slug),
    secret: newStoreCredentials,
    chartValues: (task) => storeChartValues(task, gatewayNamespace),
    markReady: markStoreReady,
    markFailed: markStoreFailed,
    remove: removeStore,
  };
}

/** Hosted MCP servers, installed with the hosted-mcp chart in namespace mcp-<slug>. */
export function hostedServerKind(
  chart: HelmChart,
  gatewayNamespace: string,
  cipher: CredentialCipher,
): DeploymentKind<HostedServerTask> {
  return {
    noun: 'server',
    chart,
    secretName: HOSTED_SERVER_SECRET_NAME,
    listTasks: listHostedServerTasks,
    namespace: (task) => hostedServerNamespace(task.slug),
    secret: (task) => JSON.parse(cipher.decrypt(task.env)) as Record<string, string>,
    chartValues: (task) => ({ image: task.image, port: task.port, gatewayNamespace }),
    markReady: markHostedServerReady,
    markFailed: markHostedServerFailed,
    remove: removeHostedServer,
  };
}

function minutes(ms: number): string {
  const count = Math.round(ms / 60_000);
  return `${count} minute${count === 1 ? '' : 's'}`;
}

// The provisioner treats every kind alike; the task type only matters inside a kind.
type AnyKind = DeploymentKind<DeploymentTask>;

interface Running {
  kind: AnyKind;
  task: DeploymentTask;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Works through the stores and hosted servers tables: deploys rows in the provisioning state and
 * tears down those in the deleting state. Each pass starts from what the database and the cluster
 * say, and every step is safe to repeat, so a restart in the middle of a deployment resumes it.
 */
export class Provisioner {
  private readonly running = new Map<string, Running>();
  private stopped = false;

  constructor(
    private readonly db: Database,
    private readonly cluster: StoreCluster,
    private readonly settings: ProvisionerSettings,
    private readonly kinds: AnyKind[],
  ) {}

  /** Runs one pass: starts work on new tasks and cancels work whose row was deleted or retried. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const tasks = (
      await Promise.all(
        this.kinds.map(async (kind) => (await kind.listTasks(this.db)).map((task) => ({ kind, task }))),
      )
    ).flat();
    const current = new Map(tasks.map(({ task }) => [task.id, task]));
    for (const [id, running] of this.running) {
      const task = current.get(id);
      if (!task || task.status !== running.task.status || task.attempt !== running.task.attempt) {
        running.controller.abort();
      }
    }
    for (const { kind, task } of tasks) {
      if (this.running.has(task.id)) continue;
      if (task.status === 'provisioning' && this.provisioningCount() >= MAX_PARALLEL_PROVISIONS) continue;
      this.start(kind, task);
    }
  }

  /** Waits for the work in flight to finish. */
  async idle(): Promise<void> {
    await Promise.all([...this.running.values()].map((running) => running.done));
  }

  /** Cancels all work in flight. An interrupted install is resumed by the next process. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const running of this.running.values()) running.controller.abort();
    await this.idle();
  }

  private provisioningCount(): number {
    return [...this.running.values()].filter((running) => running.task.status === 'provisioning').length;
  }

  private start(kind: AnyKind, task: DeploymentTask): void {
    const controller = new AbortController();
    const work =
      task.status === 'provisioning'
        ? this.provision(kind, task, controller.signal)
        : this.teardown(kind, task);
    const done = work
      .catch((error: unknown) => {
        // Kubernetes API or database errors are retried on the next pass, until the timeout.
        if (!controller.signal.aborted) {
          log(kind, 'step_failed', task, { message: (error as Error).message });
        }
      })
      .finally(() => {
        if (this.running.get(task.id)?.controller === controller) this.running.delete(task.id);
      });
    this.running.set(task.id, { kind, task, controller, done });
  }

  private async provision(kind: AnyKind, task: DeploymentTask, signal: AbortSignal): Promise<void> {
    const namespace = kind.namespace(task);
    if (this.remainingMs(task) <= 0) return this.fail(kind, task, this.timeoutReason());

    const existing = await this.cluster.getNamespace(namespace);
    if (existing && existing.ownerId !== task.id) {
      return this.fail(
        kind,
        task,
        `The namespace ${namespace} already exists and does not belong to this ${kind.noun}.`,
      );
    }
    // A namespace still terminating from an earlier delete is waited out on the next passes.
    if (existing?.terminating) return;
    if (!existing) await this.cluster.createNamespace(namespace, task.id);
    await this.cluster.grantStoreRole(namespace);
    await this.cluster.createSecretIfAbsent(namespace, kind.secretName, kind.secret(task));

    // A deployed release is complete: Helm records it only after the workloads (and a store's setup
    // Job) are ready, so a provisioner that stopped right after the install only has to register it.
    const status = await this.cluster.releaseStatus(namespace, kind.chart.release);
    if (status !== 'deployed' && !(await this.install(kind, task, namespace, status, signal))) return;
    if (await kind.markReady(this.db, task)) {
      log(kind, 'ready', task, { durationMs: Date.now() - task.attemptStartedAt.getTime() });
    }
  }

  /**
   * Installs the kind's chart and returns whether it succeeded. A Helm failure fails the row; other
   * errors are thrown, so the next pass tries again.
   */
  private async install(
    kind: AnyKind,
    task: DeploymentTask,
    namespace: string,
    status: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    // A release left pending by a provisioner that stopped mid-install, or failed by an earlier
    // attempt, blocks upgrade --install. Removing it keeps the namespace, the Secret and the volumes.
    if (status) {
      log(kind, 'release_reset', task, { releaseStatus: status });
      await this.cluster.uninstallRelease(namespace, kind.chart.release, signal);
    }
    const started = Date.now();
    try {
      await this.cluster.installRelease(
        namespace,
        kind.chart,
        kind.chartValues(task),
        this.remainingMs(task),
        signal,
      );
      return true;
    } catch (error) {
      if (signal.aborted || !(error instanceof HelmError)) throw error;
      log(kind, 'install_failed', task, { message: error.message, durationMs: Date.now() - started });
      // Helm's own timeout is the time left in the attempt, so a late failure is the timeout.
      const reason =
        this.remainingMs(task) <= 1000
          ? this.timeoutReason()
          : `The ${kind.noun} chart failed to install: ${error.message}`;
      await this.fail(kind, task, reason);
      return false;
    }
  }

  private remainingMs(task: DeploymentTask): number {
    return task.attemptStartedAt.getTime() + this.settings.timeoutMs - Date.now();
  }

  private timeoutReason(): string {
    return `Provisioning did not finish within ${minutes(this.settings.timeoutMs)}.`;
  }

  private async teardown(kind: AnyKind, task: DeploymentTask): Promise<void> {
    const namespace = kind.namespace(task);
    const existing = await this.cluster.getNamespace(namespace);
    // A namespace this row did not create is left alone; only the row goes.
    if (!existing || existing.ownerId !== task.id) {
      await kind.remove(this.db, task.id);
      log(kind, 'deleted', task, {});
      return;
    }
    // Deleting the namespace removes the release, its volumes and its Secrets. The next passes wait
    // until it is gone before the row is removed.
    if (!existing.terminating) await this.cluster.deleteNamespace(namespace);
  }

  private async fail(kind: AnyKind, task: DeploymentTask, reason: string): Promise<void> {
    await kind.markFailed(this.db, task, reason);
    log(kind, 'failed', task, { reason });
  }
}

/** One line per step, such as store_ready or server_install_failed, with the row's slug and id. */
function log(kind: AnyKind, step: string, task: DeploymentTask, fields: Record<string, unknown>): void {
  const event = `${kind.noun}_${step}`;
  const line = JSON.stringify({
    event,
    [kind.noun]: task.slug,
    [`${kind.noun}Id`]: task.id,
    attempt: task.attempt,
    ...fields,
  });
  if (event.endsWith('failed')) console.error(line);
  else console.log(line);
}
