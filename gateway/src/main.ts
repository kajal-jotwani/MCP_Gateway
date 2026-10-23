import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';

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
// gateway/dist/main.js -> dashboard/dist, the same layout in the repository and in the image.
const DASHBOARD_DIR = fileURLToPath(new URL('../../dashboard/dist/', import.meta.url));

let config: GatewayConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
if (!existsSync(`${DASHBOARD_DIR}index.html`)) {
  console.error(`The dashboard is not built: ${DASHBOARD_DIR}index.html is missing. Run npm run build.`);
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
const app = createApp({
  db,
  registry,
  mcpHandler,
  anthropic: new Anthropic({ apiKey: config.anthropicApiKey }),
  publicUrl: config.publicUrl,
  dashboardDir: DASHBOARD_DIR,
});
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
