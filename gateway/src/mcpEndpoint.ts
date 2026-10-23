import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

import type { UpstreamRegistry } from './registry.js';
import { callTool } from './toolCalls.js';

/**
 * Builds the gateway's MCP endpoint. tools/list returns the tools of every connected upstream from the
 * registry's state; tools/call goes through the shared call path. Each request gets a fresh server, so
 * the endpoint holds no sessions. Clients listening for changes get notifications/tools/list_changed.
 */
export function createGatewayMcpHandler(registry: UpstreamRegistry): McpHttpHandler {
  const handler = createMcpHandler(
    () => {
      const server = new Server(
        { name: 'urumi-gateway', version: '1.0.0' },
        { capabilities: { tools: { listChanged: true } } },
      );
      server.setRequestHandler('tools/list', () => ({
        tools: registry.listTools().map(({ name, tool }) => ({ ...tool, name })),
      }));
      server.setRequestHandler('tools/call', (request, ctx) =>
        callTool(registry, {
          name: request.params.name,
          arguments: request.params.arguments ?? {},
          signal: ctx.mcpReq.signal,
        }),
      );
      return server;
    },
    { onerror: (error) => console.error(JSON.stringify({ event: 'mcp_error', message: error.message })) },
  );
  registry.onToolsChanged(() => handler.notify.toolsChanged());
  return handler;
}
