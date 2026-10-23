import type { CallToolResult } from '@modelcontextprotocol/client';

import { writeAuditEntry } from './audit.js';
import type { AuditEntryInput, Via } from './audit.js';
import type { Queryable } from './db.js';
import { mayUseTools } from './permissions.js';
import { UpstreamCallError } from './registry.js';
import type { UpstreamRegistry } from './registry.js';
import type { Member } from './team.js';

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
}

type Outcome = Pick<AuditEntryInput, 'outcome' | 'reason' | 'upstreamId' | 'upstreamName' | 'tool'>;

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * The one path every tool call takes, from MCP clients and from the chat agent: authorize the member,
 * route the name to its upstream, call it, and write an audit entry whatever happened. Rejections and
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
    const run = await runToolCall(deps.registry, caller, call);
    outcome = run.outcome;
    return run.result;
  } finally {
    await writeAuditEntry(deps.db, {
      memberId: caller.member.id,
      keyPrefix: caller.keyPrefix,
      via: caller.via,
      durationMs: Date.now() - started,
      ...outcome,
    });
  }
}

async function runToolCall(
  registry: UpstreamRegistry,
  caller: Caller,
  call: ToolCall,
): Promise<{ result: CallToolResult; outcome: Outcome }> {
  const requestedName = call.name.slice(0, 128);
  if (!mayUseTools(caller.member)) {
    const reason = 'This member may not use tools.';
    return { result: toolError(reason), outcome: { outcome: 'rejected', reason, tool: requestedName } };
  }

  const tool = registry.resolve(call.name);
  if (!tool) {
    const reason = `Unknown tool "${requestedName}". It may have been disabled or removed; list the tools again.`;
    return { result: toolError(reason), outcome: { outcome: 'rejected', reason, tool: requestedName } };
  }

  const target = { upstreamId: tool.upstreamId, upstreamName: tool.upstreamName, tool: tool.originalName };
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
