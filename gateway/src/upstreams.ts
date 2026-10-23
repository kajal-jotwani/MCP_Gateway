import type { Database, Queryable } from './db.js';
import type { UpstreamConfig } from './registry.js';

export type AuthType = 'none' | 'bearer' | 'header';

interface UpstreamRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  authType: AuthType;
  authHeaderName: string | null;
  authSecret: string | null;
  enabled: boolean;
}

const UPSTREAM_COLUMNS = `id, slug, name, url, auth_type AS "authType", auth_header_name AS "authHeaderName",
  auth_secret AS "authSecret", enabled`;

function toConfig(row: UpstreamRow): UpstreamConfig {
  const config: UpstreamConfig = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
  };
  if (row.authType === 'bearer' && row.authSecret) {
    config.credential = { header: 'authorization', value: `Bearer ${row.authSecret}` };
  } else if (row.authType === 'header' && row.authHeaderName && row.authSecret) {
    config.credential = { header: row.authHeaderName, value: row.authSecret };
  }
  return config;
}

/** Every upstream with its credential resolved to a header, for the registry. Stays in the backend. */
export async function listUpstreamConfigs(db: Queryable): Promise<UpstreamConfig[]> {
  const rows = await db.query<UpstreamRow>(`SELECT ${UPSTREAM_COLUMNS} FROM upstreams ORDER BY created_at`);
  return rows.map(toConfig);
}

/**
 * Registers the upstream from chart values (WooCommerce) on the gateway's first start only. A row in
 * `bootstrap` records that it happened, so an admin who renames or removes it does not get it back.
 * Returns whether it was inserted.
 */
export async function seedUpstreamOnce(
  db: Database,
  seed: { name: string; slug: string; url: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [first] = await tx.query(
      `INSERT INTO bootstrap (action) VALUES ('seed_upstream') ON CONFLICT DO NOTHING RETURNING action`,
    );
    if (!first) return false;
    await tx.query(`INSERT INTO upstreams (slug, name, url, auth_type) VALUES ($1, $2, $3, 'none')`, [
      seed.slug,
      seed.name,
      seed.url,
    ]);
    return true;
  });
}
