import { createHash } from 'node:crypto';

import type { Tool } from '@modelcontextprotocol/client';

/**
 * Longest name the gateway exposes. Cursor rejects server key plus tool name over 60 characters,
 * so 48 leaves room for a server key of up to 12 characters.
 */
export const MAX_TOOL_NAME_LENGTH = 48;

const HASH_SUFFIX_LENGTH = 7; // '_' plus 6 hex characters

export interface UpstreamTools {
  upstreamId: string;
  slug: string;
  /** Prefix every tool with the slug, even without a collision. Set for provisioned stores. */
  alwaysPrefix: boolean;
  tools: Tool[];
}

export interface ExposedTool {
  /** The name clients see and call. */
  name: string;
  upstreamId: string;
  /** The tool's name on its upstream, used when the call is routed. */
  originalName: string;
  tool: Tool;
}

function hash6(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 6);
}

function withHashSuffix(name: string, hashInput: string): string {
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - HASH_SUFFIX_LENGTH)}_${hash6(hashInput)}`;
}

/**
 * Maps every upstream tool to the name clients see. Names keep their upstream spelling, with
 * characters outside [A-Za-z0-9_-] replaced by '_'. A name exposed by more than one upstream becomes
 * `<slug>__<name>` on every one of them, so the result does not depend on registration order. Tools
 * of an upstream with `alwaysPrefix` are always `<slug>__<name>`, so a store's tools name their store.
 * Names over the length limit, and any duplicate left after that, get a stable hash suffix. A name
 * that is still ambiguous after all of this is left out, so a call can never reach the wrong upstream.
 */
export function exposeToolNames(upstreams: UpstreamTools[]): ExposedTool[] {
  const candidates: { exposed: ExposedTool; slug: string; alwaysPrefix: boolean }[] = [];
  const upstreamsByBaseName = new Map<string, Set<string>>();

  for (const { upstreamId, slug, alwaysPrefix, tools } of upstreams) {
    const seen = new Set<string>();
    for (const tool of tools) {
      // An upstream listing the same tool twice is broken; the first definition wins.
      if (tool.name === '' || seen.has(tool.name)) continue;
      seen.add(tool.name);
      const base = tool.name.replace(/[^A-Za-z0-9_-]/g, '_');
      candidates.push({
        exposed: { name: base, upstreamId, originalName: tool.name, tool },
        slug,
        alwaysPrefix,
      });
      const owners = upstreamsByBaseName.get(base) ?? new Set<string>();
      owners.add(upstreamId);
      upstreamsByBaseName.set(base, owners);
    }
  }

  for (const { exposed, slug, alwaysPrefix } of candidates) {
    if (alwaysPrefix || (upstreamsByBaseName.get(exposed.name)?.size ?? 0) > 1) {
      exposed.name = `${slug}__${exposed.name}`;
    }
    if (exposed.name.length > MAX_TOOL_NAME_LENGTH) {
      exposed.name = withHashSuffix(exposed.name, exposed.name);
    }
  }

  // Leftover duplicates: two names that sanitize to the same string, or an upstream tool that is
  // literally named like another upstream's prefixed name.
  for (const group of groupByName(candidates)) {
    if (group.length < 2) continue;
    for (const { exposed, slug } of group) {
      exposed.name = withHashSuffix(exposed.name, `${slug}/${exposed.originalName}`);
    }
  }

  return groupByName(candidates)
    .flatMap((group) => (group.length === 1 ? [group[0]!.exposed] : []))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function groupByName<T extends { exposed: ExposedTool }>(items: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    groups.set(item.exposed.name, [...(groups.get(item.exposed.name) ?? []), item]);
  }
  return [...groups.values()];
}
