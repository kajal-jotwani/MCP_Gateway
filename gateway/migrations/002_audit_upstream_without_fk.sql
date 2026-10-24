-- Audit entries keep the id of the upstream they called after it is removed. With the foreign key, a
-- call that finished while its upstream was being deleted could not be audited, and each delete had to
-- rewrite all of that upstream's past entries.
ALTER TABLE audit_entries DROP CONSTRAINT audit_entries_upstream_id_fkey;
