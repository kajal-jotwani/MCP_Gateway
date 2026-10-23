import { join, sep } from 'node:path';

import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';

import { createApiRouter, HttpError } from './api.js';
import type { ApiDeps } from './api.js';
import { displayPrefixOf, verifyApiKey } from './apiKeys.js';
import type { RejectedKey } from './apiKeys.js';
import { writeAuditEntry } from './audit.js';
import type { Queryable } from './db.js';
import { callerAuthInfo } from './mcpEndpoint.js';
import type { Caller } from './toolCalls.js';

export interface AppDeps extends ApiDeps {
  mcpHandler: McpHttpHandler;
  /** Absolute path of the built dashboard (dashboard/dist). */
  dashboardDir: string;
}

// The dashboard loads only its own bundled scripts and styles; nothing inline, nothing third-party.
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function bearerToken(req: Request): string | undefined {
  const header = req.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
}

type McpRejection = { rejected: 'missing' } | RejectedKey;

/** The caller behind the request's API key, or why the request is refused. */
async function authenticateMcpRequest(
  db: Queryable,
  key: string | undefined,
): Promise<Caller | McpRejection> {
  if (!key) return { rejected: 'missing' };
  const verified = await verifyApiKey(db, key);
  return 'rejected' in verified
    ? verified
    : { member: verified.member, via: 'mcp', keyPrefix: verified.displayPrefix };
}

const REJECTION_REASONS = {
  missing: 'Missing API key',
  unknown: 'Unknown API key',
  revoked: 'Revoked API key',
  member_deactivated: 'API key of a deactivated member',
} as const;

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
 * A revoked key or a deactivated member's key is audited under the member it was issued to.
 */
async function rejectMcpRequest(
  db: Queryable,
  req: Request,
  res: Response,
  key: string | undefined,
  rejection: McpRejection,
): Promise<void> {
  const requests = jsonRpcRequestsIn(req.body);
  for (const request of requests) {
    const tool = request.method === 'tools/call' ? request.params?.name : undefined;
    await writeAuditEntry(db, {
      memberId: 'memberId' in rejection ? rejection.memberId : undefined,
      keyPrefix: key ? displayPrefixOf(key) : undefined,
      via: 'mcp',
      tool: typeof tool === 'string' ? tool.slice(0, 128) : undefined,
      durationMs: 0,
      outcome: 'rejected',
      reason: `${REJECTION_REASONS[rejection.rejected]} (${request.method.slice(0, 64)}).`,
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
 * The gateway's HTTP surface: /mcp for MCP clients with an API key, /api and the dashboard for people,
 * and the probes. /readyz checks only the database, so a dead upstream never takes the gateway out of
 * service.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });

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
    const key = bearerToken(req);
    const caller = await authenticateMcpRequest(deps.db, key);
    if ('rejected' in caller) return rejectMcpRequest(deps.db, req, res, key, caller);
    await mcp(Object.assign(req, { auth: callerAuthInfo(caller) }), res, req.body);
  });

  app.use('/api', createApiRouter(deps));

  // Vite puts content hashes in asset file names, so they can be cached forever; index.html cannot.
  app.use(
    express.static(deps.dashboardDir, {
      index: false,
      setHeaders: (res, path) => {
        if (path.includes(`${sep}assets${sep}`))
          res.set('cache-control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  // The dashboard routes in the browser, so every other GET serves its entry page.
  app.get('/{*path}', (_req, res) => {
    res.set('cache-control', 'no-cache').sendFile(join(deps.dashboardDir, 'index.html'));
  });
  app.use(handleError);
  return app;
}
