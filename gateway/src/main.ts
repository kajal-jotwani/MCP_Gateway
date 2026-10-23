import { createApp } from './app.js';
import { loadConfig } from './config.js';
import type { GatewayConfig } from './config.js';
import { createPostgresDatabase, migrate, waitForDatabase } from './db.js';
import { createGatewayMcpHandler } from './mcpEndpoint.js';
import { UpstreamRegistry } from './registry.js';
import { ensureFirstAdmin } from './team.js';
import { listUpstreamConfigs, seedUpstreamOnce } from './upstreams.js';

// Upstreams are in-cluster, so a healthy one answers in milliseconds. Calls get longer because store
// writes can be slow; woo-mcp's own 20 s store timeout fires first and returns a clearer error.
const TIMEOUTS = { connectMs: 5000, listMs: 5000, callMs: 30_000 };
const REFRESH_INTERVAL_MS = 15_000;

let config: GatewayConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const db = createPostgresDatabase(config.database);
await waitForDatabase(db);
for (const migration of await migrate(db)) {
  console.log(JSON.stringify({ event: 'migration_applied', migration }));
}
if (await ensureFirstAdmin(db, config.firstAdmin)) {
  console.log(JSON.stringify({ event: 'first_admin_created', email: config.firstAdmin.email }));
}
if (await seedUpstreamOnce(db, config.seedUpstream)) {
  console.log(JSON.stringify({ event: 'upstream_seeded', upstream: config.seedUpstream.slug }));
}

const registry = new UpstreamRegistry(TIMEOUTS);
const mcpHandler = createGatewayMcpHandler({ db, registry });
const app = createApp({ db, mcpHandler, publicUrl: config.publicUrl });
const server = app.listen(config.port, () => {
  console.log(JSON.stringify({ event: 'listening', port: config.port }));
});

// Connecting to upstreams happens after the server is up, so readiness never waits on an upstream.
await registry.sync(await listUpstreamConfigs(db));
const refreshTimer = setInterval(() => void registry.refreshAll(), REFRESH_INTERVAL_MS);

process.on('SIGTERM', () => {
  clearInterval(refreshTimer);
  server.close();
  void mcpHandler
    .close()
    .then(() => registry.close())
    .then(() => db.close());
});
