import type { CallToolResult } from '@modelcontextprotocol/client';

import { writeAuditEntry } from './audit.js';
import type { AuditEntryInput, Via } from './audit.js';
import type { Queryable } from './db.js';
import { recordToolCall } from './metrics.js';
import { mayCallTool, mayUseTools } from './permissions.js';
import { countToolCall } from './rateLimit.js';
import { UpstreamCallError } from './registry.js';
import type { RoutedTool, UpstreamRegistry } from './registry.js';
import type { Member } from './team.js';
import { loadToolRestrictions } from './upstreams.js';

/** Who is calling: the member, and whether through an API key on /mcp or the chat agent. */
export interface Caller {
  member: Member;
  via: Via;
  keyPrefix?: string;
}

export interface ToolCall {
  /** The exposed tool name. */
  name: string;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ToolCallDeps {
  db: Queryable;
  registry: UpstreamRegistry;
  /** Tool calls each member may make per minute, across all replicas. Unset or 0: no limit. */
  callsPerMinute?: number;
}

type Outcome = Pick<AuditEntryInput, 'outcome' | 'reason' | 'upstreamId' | 'upstreamName' | 'tool'> & {
  upstreamSlug?: string;
};

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * The tools a member may see and call now, sorted by name: those of connected upstreams minus the
 * admin-only ones. tools/list and the chat agent both list through here.
 */
export async function toolsFor(deps: ToolCallDeps, member: Member): Promise<RoutedTool[]> {
  const restrictions = await loadToolRestrictions(deps.db);
  return deps.registry.listTools().filter((tool) => mayCallTool(member, tool, restrictions));
}

/**
 * The one path every tool call takes, from MCP clients and from the chat agent: authorize the member,
 * apply the rate limit, route the name to its upstream, check the tool's permissions, call it, and
 * write an audit entry whatever happened. Rejections and
 * upstream failures come back as tool errors, so the model can read them and recover.
 */
export async function callTool(deps: ToolCallDeps, caller: Caller, call: ToolCall): Promise<CallToolResult> {
  const started = Date.now();
  // Replaced by the real outcome unless something unexpected throws, which is audited as well.
  let outcome: Outcome = {
    outcome: 'failed',
    reason: 'Internal gateway error.',
    tool: call.name.slice(0, 128),
  };
  try {
    const run = await runToolCall(deps, caller, call);
    outcome = run.outcome;
    return run.result;
  } finally {
    const { upstreamSlug, ...audited } = outcome;
    const durationMs = Date.now() - started;
    recordToolCall({ upstream: upstreamSlug, outcome: audited.outcome, via: caller.via, durationMs });
    await writeAuditEntry(deps.db, {
      memberId: caller.member.id,
      keyPrefix: caller.keyPrefix,
      via: caller.via,
      durationMs,
      ...audited,
    });
  }
}

async function runToolCall(
  { db, registry, callsPerMinute }: ToolCallDeps,
  caller: Caller,
  call: ToolCall,
): Promise<{ result: CallToolResult; outcome: Outcome }> {
  const requestedName = call.name.slice(0, 128);
  if (!mayUseTools(caller.member)) {
    const reason = 'This member may not use tools.';
    return { result: toolError(reason), outcome: { outcome: 'rejected', reason, tool: requestedName } };
  }
  if (callsPerMinute) {
    // Rejected calls count too, so a client retrying in a loop stays limited until the minute ends.
    const window = await countToolCall(db, caller.member.id);
    if (window.calls > callsPerMinute) {
      const reason = `Rate limit reached: ${callsPerMinute} tool calls per minute per member. Try again in ${window.resetInSeconds} s.`;
      return { result: toolError(reason), outcome: { outcome: 'rejected', reason, tool: requestedName } };
    }
  }

  const tool = registry.resolve(call.name);
  if (!tool) {
    const reason = `Unknown tool "${requestedName}". It may have been disabled or removed; list the tools again.`;
    return { result: toolError(reason), outcome: { outcome: 'rejected', reason, tool: requestedName } };
  }

  const target = {
    upstreamId: tool.upstreamId,
    upstreamName: tool.upstreamName,
    upstreamSlug: tool.upstreamSlug,
    tool: tool.originalName,
  };
  if (!mayCallTool(caller.member, tool, await loadToolRestrictions(db))) {
    const reason = 'Only admins may call this tool.';
    return { result: toolError(reason), outcome: { ...target, outcome: 'rejected', reason } };
  }
  try {
    const result = await registry.callTool(tool, call.arguments, call.signal);
    return result.isError
      ? { result, outcome: { ...target, outcome: 'failed', reason: 'The tool returned an error.' } }
      : { result, outcome: { ...target, outcome: 'succeeded' } };
  } catch (error) {
    if (!(error instanceof UpstreamCallError)) throw error;
    return {
      result: toolError(error.message),
      outcome: { ...target, outcome: error.outcome, reason: error.message },
    };
  }
}
