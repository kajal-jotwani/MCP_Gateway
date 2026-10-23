import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { createNotesServer } from './notes.js';
import type { NoteStore } from './notes.js';

/**
 * Creates the HTTP server: /mcp requires `Authorization: Bearer <token>`, /healthz is open.
 * Logs one line for each rejected request.
 */
export function createNotesHttpServer(token: string, notes: NoteStore): Server {
  // Comparing digests keeps the comparison constant-time whatever length the client sends.
  const expectedDigest = createHash('sha256').update(token).digest();
  const hasValidToken = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const digest = createHash('sha256').update(header.slice('Bearer '.length)).digest();
    return timingSafeEqual(digest, expectedDigest);
  };

  const handler = createMcpHandler(() => createNotesServer(notes), {
    onerror: (error) => console.error(JSON.stringify({ event: 'mcp_error', message: error.message })),
  });
  const mcp = toNodeHandler(handler);

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/mcp') {
      if (!hasValidToken(req)) {
        console.log(JSON.stringify({ event: 'rejected', reason: 'missing or invalid bearer token' }));
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }),
        );
        return;
      }
      void mcp(req, res);
    } else if (path === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    } else {
      res.writeHead(404).end();
    }
  });
  server.on('close', () => void handler.close());
  return server;
}
