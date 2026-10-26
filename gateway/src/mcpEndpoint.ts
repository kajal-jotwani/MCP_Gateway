import { createMcpHandler, ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import type { AuthInfo, McpHttpHandler } from '@modelcontextprotocol/server';

import { callTool, toolsFor } from './toolCalls.js';
import type { Caller, ToolCallDeps } from './toolCalls.js';

/** Wraps a verified caller as the AuthInfo that the MCP handler passes to each request's server. */
export function callerAuthInfo(caller: Caller): AuthInfo {
  // The key itself is not carried past verification; nothing after this point needs it.
  return { token: caller.keyPrefix ?? '', clientId: caller.member.id, scopes: [], extra: { caller } };
}

/**
 * Builds the gateway's MCP endpoint. tools/list returns the caller's tools of every connected upstream
 * from the registry's state; tools/call goes through the shared call path as the authenticated caller. Each
 * request gets a fresh server, so the endpoint holds no sessions. Clients listening for changes get
 * notifications/tools/list_changed.
 */
export function createGatewayMcpHandler(deps: ToolCallDeps): McpHttpHandler {
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const caller = authInfo?.extra?.caller as Caller | undefined;
      // The HTTP layer authenticates every request first; reaching here without a caller is a bug.
      if (!caller) throw new Error('MCP request reached the handler without an authenticated caller');
      const server = new Server(
        { name: 'urumi-gateway', version: '1.0.0' },
        { capabilities: { tools: { listChanged: true } } },
      );
      server.setRequestHandler('tools/list', async () => ({
        tools: (await toolsFor(deps, caller.member)).map(({ name, tool }) => ({ ...tool, name })),
      }));
      server.setRequestHandler('tools/call', async (request, ctx) => {
        try {
          return await callTool(deps, caller, {
            name: request.params.name,
            arguments: request.params.arguments ?? {},
            signal: ctx.mcpReq.signal,
          });
        } catch (error) {
          // Only expected failures become tool errors. Anything else (the database, a bug) is logged
          // here and reaches the client without internal details.
          console.error(JSON.stringify({ event: 'tool_call_error', message: (error as Error).message }));
          throw new ProtocolError(ProtocolErrorCode.InternalError, 'Internal gateway error.');
        }
      });
      return server;
    },
    { onerror: (error) => console.error(JSON.stringify({ event: 'mcp_error', message: error.message })) },
  );
  deps.registry.onToolsChanged(() => handler.notify.toolsChanged());
  return handler;
}
