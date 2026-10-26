-- Tool permissions: a server or single tools can be limited to admins. Members neither see nor call
-- them. Tools are named as their upstream names them, so a rename on the gateway side keeps the rule.
ALTER TABLE upstreams ADD COLUMN admin_only boolean NOT NULL DEFAULT false;

CREATE TABLE admin_only_tools (
  upstream_id uuid NOT NULL REFERENCES upstreams (id) ON DELETE CASCADE,
  tool text NOT NULL,
  PRIMARY KEY (upstream_id, tool)
);
