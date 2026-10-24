import type { Queryable } from './db.js';

export type Outcome = 'succeeded' | 'failed' | 'timed_out' | 'rejected';
export type Via = 'mcp' | 'chat';

export interface AuditEntryInput {
  memberId?: string;
  keyPrefix?: string;
  via: Via;
  upstreamId?: string;
  upstreamName?: string;
  tool?: string;
  durationMs: number;
  outcome: Outcome;
  reason?: string;
}

export interface AuditEntry {
  id: string;
  at: Date;
  memberId: string | null;
  memberEmail: string | null;
  keyPrefix: string | null;
  via: Via;
  upstreamName: string | null;
  tool: string | null;
  durationMs: number;
  outcome: Outcome;
  reason: string | null;
}

/** Stores one audit entry and logs it as one line. */
export async function writeAuditEntry(db: Queryable, entry: AuditEntryInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_entries
       (member_id, key_prefix, via, upstream_id, upstream_name, tool, duration_ms, outcome, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.memberId ?? null,
      entry.keyPrefix ?? null,
      entry.via,
      entry.upstreamId ?? null,
      entry.upstreamName ?? null,
      withoutNul(entry.tool),
      entry.durationMs,
      entry.outcome,
      withoutNul(entry.reason),
    ],
  );
  console.log(
    JSON.stringify({
      event: 'tool_call',
      memberId: entry.memberId,
      keyPrefix: entry.keyPrefix,
      via: entry.via,
      upstream: entry.upstreamName,
      tool: entry.tool,
      durationMs: entry.durationMs,
      outcome: entry.outcome,
      reason: entry.reason,
    }),
  );
}

// Tool names and reasons can carry text from the client, and PostgreSQL text cannot hold U+0000.
function withoutNul(text: string | undefined): string | null {
  return text?.replaceAll('\u0000', '\uFFFD') ?? null;
}

/**
 * Audit entries, newest first, one page at a time. `memberId` limits them to one member's entries;
 * `before` is the id of the last entry of the previous page.
 */
export async function listAuditEntries(
  db: Queryable,
  filter: { memberId?: string; before?: string; limit: number },
): Promise<AuditEntry[]> {
  return db.query<AuditEntry>(
    `SELECT a.id::text AS id, a.at, a.member_id AS "memberId", m.email AS "memberEmail",
       a.key_prefix AS "keyPrefix", a.via, a.upstream_name AS "upstreamName", a.tool,
       a.duration_ms AS "durationMs", a.outcome, a.reason
     FROM audit_entries a LEFT JOIN members m ON m.id = a.member_id
     WHERE ($1::uuid IS NULL OR a.member_id = $1) AND ($2::bigint IS NULL OR a.id < $2)
     ORDER BY a.id DESC LIMIT $3`,
    [filter.memberId ?? null, filter.before ?? null, filter.limit],
  );
}
