-- Stores that members provision from the dashboard. The provisioner works through rows in the
-- provisioning and deleting states; a row is removed once its namespace is gone. The slug names the
-- namespace (store-<slug>), the store's host and its upstream, so it must be a DNS label.
CREATE TABLE stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,14}[a-z0-9]$'),
  name text NOT NULL,
  url text NOT NULL,
  owner_id uuid NOT NULL REFERENCES members (id),
  status text NOT NULL CHECK (status IN ('provisioning', 'ready', 'failed', 'deleting')),
  reason text,
  -- Counts provisioning attempts, so the result of an attempt that was retried or deleted meanwhile is
  -- not written over the newer state.
  attempt integer NOT NULL DEFAULT 1,
  -- When the current attempt began. The provisioning timeout counts from here, so a provisioner
  -- restart does not reset it.
  attempt_started_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stores_owner_id ON stores (owner_id);

-- The upstream the provisioner registers for a ready store. Its tool names always carry the slug.
ALTER TABLE upstreams ADD COLUMN store_id uuid UNIQUE REFERENCES stores (id) ON DELETE CASCADE;
