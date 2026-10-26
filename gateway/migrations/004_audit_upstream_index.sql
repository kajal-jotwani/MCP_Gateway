-- Per-server call statistics read the last day of audit entries of each upstream.
CREATE INDEX audit_entries_upstream_at ON audit_entries (upstream_id, at);
