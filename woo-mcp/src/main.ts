import { createServer } from 'node:http';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { loadConfig } from './config.js';
import type { WooMcpConfig } from './config.js';
import { createWooServer } from './tools.js';
import { createStoreClient } from './woocommerce.js';

let config: WooMcpConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const store = createStoreClient(config);
const handler = createMcpHandler(() => createWooServer(store, config.storeTimezone), {
  onerror: (error) => console.error(JSON.stringify({ event: 'mcp_error', message: error.message })),
});
const mcp = toNodeHandler(handler);

// No Host or Origin check: the server is reachable only inside the cluster, from the gateway, which the
// NetworkPolicy enforces. Browsers never talk to it.
const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/mcp') {
    void mcp(req, res);
  } else if (path === '/healthz' && req.method === 'GET') {
    // Liveness and readiness only: it does not call the store, so a store restart does not cycle this pod.
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  } else {
    res.writeHead(404).end();
  }
});

server.listen(config.port, () => {
  console.log(JSON.stringify({ event: 'listening', port: config.port }));
});

process.on('SIGTERM', () => {
  server.close();
  void handler.close();
});
