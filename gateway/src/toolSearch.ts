import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';

import type { RoutedTool } from './registry.js';
import { callTool, toolsFor } from './toolCalls.js';
import type { Caller, ToolCallDeps } from './toolCalls.js';

const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 20;

/**
 * The two tools a client gets in search mode instead of every upstream tool: one finds tools by
 * keyword, the other calls one by name. They stay the same however many servers are registered.
 */
export const META_TOOLS: Tool[] = [
  {
    name: 'search_tools',
    description:
      'Finds tools of the team’s connected servers by keywords, such as "orders" or "create product". ' +
      'Returns each matching tool’s name, server, description and input schema. Search first, then run a tool with call_tool.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords describing what the tool should do.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RESULTS,
          description: `At most this many tools (default ${DEFAULT_RESULTS}).`,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'call_tool',
    description:
      'Calls a tool found with search_tools, by its exact name, with arguments that match its input schema.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The tool name search_tools returned.' },
        arguments: { type: 'object', description: 'The tool’s arguments.' },
      },
      required: ['name'],
    },
  },
];

const searchArgs = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(MAX_RESULTS).default(DEFAULT_RESULTS),
});
const callArgs = z.object({
  name: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}

// "order" finds "orders" and "list" finds "listing", but a one-letter difference in a short word does not count.
function matches(word: string, term: string): boolean {
  return (
    word === term ||
    (term.length >= 3 && (word.startsWith(term) || (term.startsWith(word) && word.length >= 3)))
  );
}

/**
 * Ranks tools against a keyword query. A term found in the tool name counts most, then in the server's
 * name or slug, then in the description. Tools that match no term are left out.
 */
export function searchTools(tools: RoutedTool[], query: string, limit: number): RoutedTool[] {
  const terms = [...new Set(words(query))];
  const scored = tools.map((tool) => {
    const name = words(tool.name);
    const server = words(`${tool.upstreamName} ${tool.upstreamSlug}`);
    const description = words(`${tool.tool.title ?? ''} ${tool.tool.description ?? ''}`);
    let score = 0;
    for (const term of terms) {
      if (name.some((word) => matches(word, term))) score += 3;
      if (server.some((word) => matches(word, term))) score += 2;
      if (description.some((word) => matches(word, term))) score += 1;
    }
    return { tool, score };
  });
  return scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : 1))
    .slice(0, limit)
    .map(({ tool }) => tool);
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Runs search_tools or call_tool for a caller. Search only finds the caller's own tools, and call_tool
 * goes through the single call path, so permissions and the audit entry are those of the real tool.
 * Any other name is called directly, for clients that already know it.
 */
export async function runMetaTool(
  deps: ToolCallDeps,
  caller: Caller,
  call: { name: string; arguments: Record<string, unknown>; signal?: AbortSignal },
): Promise<CallToolResult> {
  if (call.name === 'search_tools') {
    const parsed = searchArgs.safeParse(call.arguments);
    if (!parsed.success) return toolError(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
    const found = searchTools(await toolsFor(deps, caller.member), parsed.data.query, parsed.data.limit);
    const tools = found.map(({ name, upstreamName, tool }) => ({
      name,
      server: upstreamName,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema,
    }));
    const text = tools.length
      ? JSON.stringify({ tools }, null, 2)
      : 'No tool matches. Try other or fewer keywords.';
    return { content: [{ type: 'text', text }], structuredContent: { tools } };
  }
  if (call.name === 'call_tool') {
    const parsed = callArgs.safeParse(call.arguments);
    if (!parsed.success) return toolError(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
    return callTool(deps, caller, {
      name: parsed.data.name,
      arguments: parsed.data.arguments,
      signal: call.signal,
    });
  }
  return callTool(deps, caller, call);
}
