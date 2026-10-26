-- MCP servers the platform runs from a container image, one namespace mcp-<slug> each. The
-- provisioner deploys them and registers the upstream once the server is ready, as for stores.
CREATE TABLE hosted_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,14}[a-z0-9]$'),
  name text NOT NULL,
  image text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  path text NOT NULL,
  -- The environment variables as a JSON object, encrypted like upstream credentials. They go into
  -- the server's Secret and are never sent back to the dashboard.
  env text NOT NULL,
  status text NOT NULL CHECK (status IN ('provisioning', 'ready', 'failed', 'deleting')),
  reason text,
  attempt integer NOT NULL DEFAULT 1,
  attempt_started_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES members (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE upstreams ADD COLUMN hosted_server_id uuid UNIQUE REFERENCES hosted_servers (id) ON DELETE CASCADE;
