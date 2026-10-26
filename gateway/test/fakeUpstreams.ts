import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { CallToolResult } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export interface ReceivedCall {
  tool: string;
  args: unknown;
  authorization: string | undefined;
}

export interface FakeUpstream {
  url: string;
  port: number;
  calls: ReceivedCall[];
  /** Tells subscribed clients that the tool list changed. */
  notifyToolsChanged(): void;
  close(): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

/** Registers something to close after the current test. */
export function onCleanup(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup);
}

/** Closes everything registered with onCleanup, last first. Call from afterEach. */
export async function runCleanups(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

async function listen(server: Server, port = 0, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/**
 * An MCP server on a real port whose tools echo their name and arguments. `sleep` waits for args.ms,
 * `fail` throws. With a token, requests without `Authorization: Bearer <token>` get 401. Tools are
 * read from `toolNames` on each request, so changing the array changes what the server lists.
 * `maxSubscriptions` limits the open change-notification streams. It listens on `host`, loopback by default.
 * `resetBodiesOver` drops the connection of any request with a larger body, as some servers do.
 */
export async function startUpstream(
  toolNames: string[],
  options: {
    token?: string;
    port?: number;
    host?: string;
    maxSubscriptions?: number;
    resetBodiesOver?: number;
  } = {},
): Promise<FakeUpstream> {
  const calls: ReceivedCall[] = [];
  const createServerForRequest = (): McpServer => {
    const server = new McpServer({ name: 'fake', version: '1.0.0' });
    for (const tool of toolNames) {
      server.registerTool(
        tool,
        { description: `${tool} tool`, inputSchema: z.object({ ms: z.number().optional() }).loose() },
        async (args, ctx): Promise<CallToolResult> => {
          calls.push({ tool, args, authorization: ctx.http?.req?.headers.get('authorization') ?? undefined });
          if (tool === 'fail') throw new Error('the upstream tool failed');
          if (tool === 'sleep') await new Promise((resolve) => setTimeout(resolve, args.ms ?? 0));
          return { content: [{ type: 'text', text: `${tool} done` }] };
        },
      );
    }
    return server;
  };
  const handler: McpHttpHandler = createMcpHandler(createServerForRequest, {
    maxSubscriptions: options.maxSubscriptions,
  });
  const node = toNodeHandler(handler);
  const server = createServer((req, res) => {
    if (
      options.resetBodiesOver !== undefined &&
      Number(req.headers['content-length']) > options.resetBodiesOver
    ) {
      req.socket.destroy();
      return;
    }
    if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
      res.writeHead(401).end();
      return;
    }
    void node(req, res);
  });
  const host = options.host ?? '127.0.0.1';
  const port = await listen(server, options.port, host);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handler.close();
    await closeServer(server);
  };
  onCleanup(close);
  return {
    url: `http://${host}:${port}/mcp`,
    port,
    calls,
    notifyToolsChanged: () => handler.notify.toolsChanged(),
    close,
  };
}

/** A server that accepts connections and never answers. */
export async function startSilentServer(): Promise<string> {
  const server = createServer(() => {});
  const port = await listen(server);
  onCleanup(() => closeServer(server));
  return `http://127.0.0.1:${port}/mcp`;
}

/** A plain HTTP server that answers every request with the given status, headers and body. */
export async function startPlainServer(
  status: number,
  headers: Record<string, string>,
  body = '',
): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status, headers).end(body);
  });
  const port = await listen(server);
  onCleanup(() => closeServer(server));
  return `http://127.0.0.1:${port}/mcp`;
}

/** A URL nothing listens on. */
export async function deadUrl(): Promise<string> {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return `http://127.0.0.1:${port}/mcp`;
}

export function text(result: CallToolResult): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? '';
}

export async function eventually(assertion: () => void | Promise<void>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
