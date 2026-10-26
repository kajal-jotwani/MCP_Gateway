import type { Queryable } from './db.js';

/** A member's tool calls in the current minute, this one included, and when the minute ends. */
export interface CallWindow {
  calls: number;
  resetInSeconds: number;
}

/**
 * Counts one tool call against the member's current one-minute window and returns the new count.
 * The upsert is atomic, so concurrent calls on any replica each get their own count. The member's
 * earlier windows are deleted in the same statement.
 */
export async function countToolCall(db: Queryable, memberId: string): Promise<CallWindow> {
  const [window] = await db.query<CallWindow>(
    `WITH expired AS (
       DELETE FROM tool_call_windows WHERE member_id = $1 AND window_start < date_trunc('minute', now())
     )
     INSERT INTO tool_call_windows (member_id, window_start, calls)
     VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (member_id, window_start) DO UPDATE SET calls = tool_call_windows.calls + 1
     RETURNING calls,
       ceil(extract(epoch FROM date_trunc('minute', now()) + interval '1 minute' - now()))::int
         AS "resetInSeconds"`,
    [memberId],
  );
  return window!;
}
