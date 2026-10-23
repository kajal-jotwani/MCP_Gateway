import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';

import { createApiRouter, HttpError } from './api.js';
import type { ApiDeps } from './api.js';
import { displayPrefixOf, verifyApiKey } from './apiKeys.js';
import { writeAuditEntry } from './audit.js';
import type { Queryable } from './db.js';
import { callerAuthInfo } from './mcpEndpoint.js';
import type { Caller } from './toolCalls.js';

export interface AppDeps extends ApiDeps {
  mcpHandler: McpHttpHandler;
}

function bearerToken(req: Request): string | undefined {
  const header = req.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
}

/** The member behind the request's API key, or undefined when the key is missing, unknown or revoked. */
async function authenticateMcpRequest(db: Queryable, req: Request): Promise<Caller | undefined> {
  const key = bearerToken(req);
  const verified = key ? await verifyApiKey(db, key) : undefined;
  return verified && { member: verified.member, via: 'mcp', keyPrefix: verified.displayPrefix };
}

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: { name?: unknown };
}

function jsonRpcRequestsIn(body: unknown): JsonRpcRequest[] {
  return (Array.isArray(body) ? body : [body]).filter(
    (message): message is JsonRpcRequest =>
      typeof message === 'object' &&
      message !== null &&
      'id' in message &&
      typeof (message as { method?: unknown }).method === 'string',
  );
}

/**
 * Answers an unauthenticated MCP request with 401 and audits every JSON-RPC request in it as
 * rejected, so a revoked key's next call shows up in the audit log even if it is not a tools/call.
 */
async function rejectMcpRequest(db: Queryable, req: Request, res: Response): Promise<void> {
  const key = bearerToken(req);
  const requests = jsonRpcRequestsIn(req.body);
  for (const request of requests) {
    const tool = request.method === 'tools/call' ? request.params?.name : undefined;
    await writeAuditEntry(db, {
      keyPrefix: key ? displayPrefixOf(key) : undefined,
      via: 'mcp',
      tool: typeof tool === 'string' ? tool.slice(0, 128) : undefined,
      durationMs: 0,
      outcome: 'rejected',
      reason: `${key ? 'Unknown or revoked' : 'Missing'} API key (${request.method.slice(0, 64)}).`,
    });
  }
  res
    .status(401)
    .set('www-authenticate', 'Bearer')
    .json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Missing, unknown or revoked API key.' },
      id: requests.length === 1 ? requests[0]!.id : null,
    });
}

function handleError(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  // body-parser marks its own errors with a type and an HTTP status.
  const parserError = error as { type?: string; status?: number };
  if (parserError.type === 'entity.parse.failed' || parserError.type === 'entity.too.large') {
    res
      .status(parserError.status ?? 400)
      .json({ error: 'The request body is not valid JSON or is too large.' });
    return;
  }
  console.error(
    JSON.stringify({
      event: 'request_failed',
      method: req.method,
      path: req.path,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  res.status(500).json({ error: 'Internal error.' });
}

/**
 * The gateway's HTTP surface: /mcp for MCP clients with an API key, /api for the dashboard, and the
 * probes. /readyz checks only the database, so a dead upstream never takes the gateway out of service.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok');
  });
  app.get('/readyz', async (_req, res) => {
    await deps.db.query('SELECT 1');
    res.type('text/plain').send('ok');
  });

  const mcp = toNodeHandler(deps.mcpHandler, {
    onerror: (error) => console.error(JSON.stringify({ event: 'mcp_error', message: error.message })),
  });
  app.all('/mcp', express.json({ limit: '4mb' }), async (req, res) => {
    const caller = await authenticateMcpRequest(deps.db, req);
    if (!caller) return rejectMcpRequest(deps.db, req, res);
    await mcp(Object.assign(req, { auth: callerAuthInfo(caller) }), res, req.body);
  });

  app.use('/api', createApiRouter(deps));
  app.use(handleError);
  return app;
}
