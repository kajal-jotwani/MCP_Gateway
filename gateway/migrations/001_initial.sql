-- Members are deactivated, never deleted, so audit entries keep pointing at them.
CREATE TABLE members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES members (id),
  expires_at timestamptz NOT NULL
);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  created_by uuid NOT NULL REFERENCES members (id),
  expires_at timestamptz NOT NULL
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members (id),
  key_hash text NOT NULL UNIQUE,
  display_prefix text NOT NULL,
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES members (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);

CREATE TABLE upstreams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,16}$'),
  name text NOT NULL,
  url text NOT NULL,
  auth_type text NOT NULL CHECK (auth_type IN ('none', 'bearer', 'header')),
  auth_header_name text,
  auth_secret text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((auth_type = 'none') = (auth_secret IS NULL)),
  CHECK ((auth_type = 'header') = (auth_header_name IS NOT NULL))
);

-- upstream_name and tool are copied as text so entries stay readable after an upstream is removed.
CREATE TABLE audit_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  member_id uuid REFERENCES members (id),
  key_prefix text,
  via text NOT NULL CHECK (via IN ('mcp', 'chat')),
  upstream_id uuid REFERENCES upstreams (id) ON DELETE SET NULL,
  upstream_name text,
  tool text,
  duration_ms integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'timed_out', 'rejected')),
  reason text
);

CREATE INDEX audit_entries_member_id ON audit_entries (member_id, id);

-- One row per one-time startup action, such as seeding the WooCommerce upstream, so an admin who
-- later removes that upstream does not get it back on restart.
CREATE TABLE bootstrap (
  action text PRIMARY KEY,
  done_at timestamptz NOT NULL DEFAULT now()
);
