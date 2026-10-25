import { createServer } from 'node:http';

import { createInClusterStoreCluster } from './cluster.js';
import { loadProvisionerConfig } from './config.js';
import type { ProvisionerConfig } from './config.js';
import { createPostgresDatabase, migrate, waitForDatabase } from './db.js';
import { Provisioner } from './provisioner.js';

const TICK_INTERVAL_MS = 5000;
// Liveness fails when no pass has finished for this long, which means the database or the loop is stuck.
const STALE_AFTER_MS = 60_000;

let config: ProvisionerConfig;
try {
  config = loadProvisionerConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const db = createPostgresDatabase(config.database);
await waitForDatabase(db);
// The gateway applies the same migrations; the advisory lock in migrate lets whichever starts first do it.
await migrate(db);

const provisioner = new Provisioner(
  db,
  createInClusterStoreCluster({
    chartPath: config.chartPath,
    valuesFiles: config.valuesFiles,
    serviceAccount: { name: config.serviceAccount, namespace: config.gatewayNamespace },
    storeRole: config.storeRole,
  }),
  { timeoutMs: config.timeoutMs, gatewayNamespace: config.gatewayNamespace },
);

let lastPassAt = Date.now();
const health = createServer((req, res) => {
  const healthy = req.url === '/healthz' && Date.now() - lastPassAt < STALE_AFTER_MS;
  res.writeHead(healthy ? 200 : 503).end();
});
health.listen(config.port, () => {
  console.log(JSON.stringify({ event: 'listening', port: config.port }));
});

let timer: NodeJS.Timeout | undefined;
let stopping = false;
const runPass = async () => {
  try {
    await provisioner.tick();
    lastPassAt = Date.now();
  } catch (error) {
    console.error(JSON.stringify({ event: 'provisioner_pass_failed', message: (error as Error).message }));
  }
  if (!stopping) timer = setTimeout(() => void runPass(), TICK_INTERVAL_MS);
};
await runPass();

process.on('SIGTERM', () => {
  stopping = true;
  clearTimeout(timer);
  health.close();
  void provisioner.stop().then(() => db.close());
});
