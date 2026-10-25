import { randomBytes } from 'node:crypto';

import { HelmError } from './cluster.js';
import type { StoreCluster } from './cluster.js';
import type { Database } from './db.js';
import { listStoreTasks, markStoreFailed, markStoreReady, removeStore, storeNamespace } from './stores.js';
import type { StoreTask } from './stores.js';

export interface ProvisionerSettings {
  /** How long one provisioning attempt may take, counted from when it started, across restarts. */
  timeoutMs: number;
  /** The gateway's namespace, which the store chart lets reach woo-mcp. */
  gatewayNamespace: string;
}

/** The Secret the store chart reads, created by the provisioner before the chart is installed. */
export const STORE_SECRET_NAME = 'store-credentials';

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

function minutes(ms: number): string {
  const count = Math.round(ms / 60_000);
  return `${count} minute${count === 1 ? '' : 's'}`;
}

interface Running {
  task: StoreTask;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Works through the stores table: provisions stores in the provisioning state and tears down those
 * in the deleting state. Each pass starts from what the database and the cluster say, and every step
 * is safe to repeat, so a restart in the middle of a store resumes it.
 */
export class Provisioner {
  private readonly running = new Map<string, Running>();
  private stopped = false;

  constructor(
    private readonly db: Database,
    private readonly cluster: StoreCluster,
    private readonly settings: ProvisionerSettings,
  ) {}

  /** Runs one pass: starts work on new tasks and cancels work whose store was deleted or retried. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const tasks = await listStoreTasks(this.db);
    const current = new Map(tasks.map((task) => [task.id, task]));
    for (const [id, running] of this.running) {
      const task = current.get(id);
      if (!task || task.status !== running.task.status || task.attempt !== running.task.attempt) {
        running.controller.abort();
      }
    }
    for (const task of tasks) {
      if (this.running.has(task.id)) continue;
      if (task.status === 'provisioning' && this.provisioningCount() >= MAX_PARALLEL_PROVISIONS) continue;
      this.start(task);
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

  private start(task: StoreTask): void {
    const controller = new AbortController();
    const work =
      task.status === 'provisioning' ? this.provision(task, controller.signal) : this.teardown(task);
    const done = work
      .catch((error: unknown) => {
        // Kubernetes API or database errors are retried on the next pass, until the timeout.
        if (!controller.signal.aborted) log('store_step_failed', task, { message: (error as Error).message });
      })
      .finally(() => {
        if (this.running.get(task.id)?.controller === controller) this.running.delete(task.id);
      });
    this.running.set(task.id, { task, controller, done });
  }

  private async provision(task: StoreTask, signal: AbortSignal): Promise<void> {
    const namespace = storeNamespace(task.slug);
    if (this.remainingMs(task) <= 0) return this.fail(task, this.timeoutReason());

    const existing = await this.cluster.getNamespace(namespace);
    if (existing && existing.storeId !== task.id) {
      return this.fail(task, `The namespace ${namespace} already exists and does not belong to this store.`);
    }
    // A namespace still terminating from an earlier delete is waited out on the next passes.
    if (existing?.terminating) return;
    if (!existing) await this.cluster.createNamespace(namespace, task.id);
    await this.cluster.grantStoreRole(namespace);
    await this.cluster.createSecretIfAbsent(namespace, STORE_SECRET_NAME, newStoreCredentials());

    // A deployed release is complete: Helm records it only after the workloads and the setup Job are
    // ready, so a provisioner that stopped right after the install only has to register the store.
    const status = await this.cluster.releaseStatus(namespace);
    if (status !== 'deployed' && !(await this.install(task, namespace, status, signal))) return;
    if (await markStoreReady(this.db, task)) {
      log('store_ready', task, { durationMs: Date.now() - task.attemptStartedAt.getTime() });
    }
  }

  /**
   * Installs the store chart and returns whether it succeeded. A Helm failure fails the store; other
   * errors are thrown, so the next pass tries again.
   */
  private async install(
    task: StoreTask,
    namespace: string,
    status: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    // A release left pending by a provisioner that stopped mid-install, or failed by an earlier
    // attempt, blocks upgrade --install. Removing it keeps the namespace, the Secret and the volumes.
    if (status) {
      log('store_release_reset', task, { releaseStatus: status });
      await this.cluster.uninstallRelease(namespace, signal);
    }
    const started = Date.now();
    try {
      const values = storeChartValues(task, this.settings.gatewayNamespace);
      await this.cluster.installRelease(namespace, values, this.remainingMs(task), signal);
      return true;
    } catch (error) {
      if (signal.aborted || !(error instanceof HelmError)) throw error;
      log('store_install_failed', task, { message: error.message, durationMs: Date.now() - started });
      // Helm's own timeout is the time left in the attempt, so a late failure is the timeout.
      const reason =
        this.remainingMs(task) <= 1000
          ? this.timeoutReason()
          : `The store chart failed to install: ${error.message}`;
      await this.fail(task, reason);
      return false;
    }
  }

  private remainingMs(task: StoreTask): number {
    return task.attemptStartedAt.getTime() + this.settings.timeoutMs - Date.now();
  }

  private timeoutReason(): string {
    return `Provisioning did not finish within ${minutes(this.settings.timeoutMs)}.`;
  }

  private async teardown(task: StoreTask): Promise<void> {
    const namespace = storeNamespace(task.slug);
    const existing = await this.cluster.getNamespace(namespace);
    // A namespace this store did not create is left alone; only the row goes.
    if (!existing || existing.storeId !== task.id) {
      await removeStore(this.db, task.id);
      log('store_deleted', task, {});
      return;
    }
    // Deleting the namespace removes the release, its volumes and its Secrets. The next passes wait
    // until it is gone before the row is removed.
    if (!existing.terminating) await this.cluster.deleteNamespace(namespace);
  }

  private async fail(task: StoreTask, reason: string): Promise<void> {
    await markStoreFailed(this.db, task, reason);
    log('store_failed', task, { reason });
  }
}

function log(event: string, task: StoreTask, fields: Record<string, unknown>): void {
  const line = JSON.stringify({
    event,
    store: task.slug,
    storeId: task.id,
    attempt: task.attempt,
    ...fields,
  });
  if (event.endsWith('failed')) console.error(line);
  else console.log(line);
}
