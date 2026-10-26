-- Rate limit: tool calls per member per minute. A counter in PostgreSQL is shared by every gateway
-- replica, so the limit holds however requests are spread. Each member keeps at most one row.
CREATE TABLE tool_call_windows (
  member_id uuid NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  calls integer NOT NULL,
  PRIMARY KEY (member_id, window_start)
);
