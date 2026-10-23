import type { CallToolResult } from '@modelcontextprotocol/client';

import { UpstreamCallError } from './registry.js';
import type { UpstreamRegistry } from './registry.js';

export interface ToolCall {
  /** The exposed tool name. */
  name: string;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * The one path every tool call takes, from MCP clients and from the chat agent. Unknown tools and
 * upstream failures come back as tool errors, so the model can read them and recover.
 */
export async function callTool(registry: UpstreamRegistry, call: ToolCall): Promise<CallToolResult> {
  const tool = registry.resolve(call.name);
  if (!tool) {
    return toolError(
      `Unknown tool "${call.name.slice(0, 128)}". It may have been disabled or removed; list the tools again.`,
    );
  }
  try {
    return await registry.callTool(tool, call.arguments, call.signal);
  } catch (error) {
    if (error instanceof UpstreamCallError) return toolError(error.message);
    throw error;
  }
}
