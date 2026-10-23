import type { Database, Queryable } from './db.js';
import type { UpstreamConfig } from './registry.js';

export type AuthType = 'none' | 'bearer' | 'header';

/** Slugs prefix tool names on collisions, so they stay short and safe in a tool name. */
export const SLUG_PATTERN = /^[a-z0-9-]{2,16}$/;

/** An upstream as the dashboard API shows it. The credential appears only as its type and header name. */
export interface Upstream {
  id: string;
  slug: string;
  name: string;
  url: string;
  authType: AuthType;
  authHeaderName: string | null;
  enabled: boolean;
}

interface UpstreamRow extends Upstream {
  authSecret: string | null;
}

/** A credential as an admin enters it. A missing secret on an edit means "keep the stored one". */
export type AuthChange =
  | { type: 'none' }
  | { type: 'bearer'; secret?: string }
  | { type: 'header'; headerName: string; secret?: string };

export interface UpstreamInput {
  slug: string;
  name: string;
  url: string;
  auth: AuthChange;
  enabled: boolean;
}

const PUBLIC_COLUMNS = `id, slug, name, url, auth_type AS "authType", auth_header_name AS "authHeaderName", enabled`;
const UPSTREAM_COLUMNS = `${PUBLIC_COLUMNS}, auth_secret AS "authSecret"`;

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

/** Every upstream without its secret, oldest first. */
export async function listUpstreams(db: Queryable): Promise<Upstream[]> {
  return db.query<Upstream>(`SELECT ${PUBLIC_COLUMNS} FROM upstreams ORDER BY created_at`);
}

/** A slug derived from a server name, such as "notes" from "Notes". Empty when the name has no a-z or 0-9. */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 16)
    .replace(/^-+|-+$/g, '');
}

type StoredAuth = Pick<UpstreamRow, 'authType' | 'authHeaderName' | 'authSecret'>;

/**
 * The credential to store after an edit, or 'secret_required' when the edit leaves an authenticated
 * upstream without a secret. A URL change needs the secret entered again, so an edit cannot send a
 * stored credential, which nobody can read back, to a new address.
 */
function storedAuthAfter(
  current: StoredAuth,
  change: AuthChange | undefined,
  urlChanged: boolean,
): StoredAuth | 'secret_required' {
  if (change?.type === 'none' || (!change && current.authType === 'none')) {
    return { authType: 'none', authHeaderName: null, authSecret: null };
  }
  if (urlChanged && !change?.secret) return 'secret_required';
  const authType = change?.type ?? current.authType;
  const authSecret = change?.secret ?? (current.authType === 'none' ? null : current.authSecret);
  if (!authSecret) return 'secret_required';
  const authHeaderName =
    change?.type === 'header' ? change.headerName : change ? null : current.authHeaderName;
  return { authType, authHeaderName, authSecret };
}

/**
 * Inserts an upstream. Returns 'slug_taken' when another upstream has the slug and 'secret_required'
 * when the credential type needs a secret and none was given.
 */
export async function createUpstream(
  db: Queryable,
  input: UpstreamInput,
): Promise<Upstream | 'slug_taken' | 'secret_required'> {
  const auth = storedAuthAfter(
    { authType: 'none', authHeaderName: null, authSecret: null },
    input.auth,
    false,
  );
  if (auth === 'secret_required') return auth;
  const [upstream] = await db.query<Upstream>(
    `INSERT INTO upstreams (slug, name, url, auth_type, auth_header_name, auth_secret, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (slug) DO NOTHING RETURNING ${PUBLIC_COLUMNS}`,
    [input.slug, input.name, input.url, auth.authType, auth.authHeaderName, auth.authSecret, input.enabled],
  );
  return upstream ?? 'slug_taken';
}

/**
 * Applies an admin's edit. Returns undefined for an unknown id, 'slug_taken' when another upstream
 * has the new slug, and 'secret_required' as described for storedAuthAfter.
 */
export async function updateUpstream(
  db: Database,
  id: string,
  changes: Partial<UpstreamInput>,
): Promise<Upstream | undefined | 'slug_taken' | 'secret_required'> {
  return db.transaction(async (tx) => {
    const [current] = await tx.query<UpstreamRow>(
      `SELECT ${UPSTREAM_COLUMNS} FROM upstreams WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!current) return undefined;
    const url = changes.url ?? current.url;
    const auth = storedAuthAfter(current, changes.auth, url !== current.url);
    if (auth === 'secret_required') return auth;
    const [upstream] = await tx.query<Upstream>(
      `UPDATE upstreams SET slug = $2, name = $3, url = $4, auth_type = $5, auth_header_name = $6,
         auth_secret = $7, enabled = $8, updated_at = now()
       WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM upstreams WHERE slug = $2 AND id <> $1)
       RETURNING ${PUBLIC_COLUMNS}`,
      [
        id,
        changes.slug ?? current.slug,
        changes.name ?? current.name,
        url,
        auth.authType,
        auth.authHeaderName,
        auth.authSecret,
        changes.enabled ?? current.enabled,
      ],
    );
    return upstream ?? 'slug_taken';
  });
}

export async function deleteUpstream(db: Queryable, id: string): Promise<boolean> {
  return (await db.query('DELETE FROM upstreams WHERE id = $1 RETURNING id', [id])).length > 0;
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
