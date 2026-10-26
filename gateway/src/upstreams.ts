import type { CredentialCipher } from './credentialCipher.js';
import type { Database, Queryable } from './db.js';
import { toolKey } from './permissions.js';
import type { ToolRestrictions } from './permissions.js';
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
  /** The provisioned store this upstream belongs to. Such an upstream is changed through its store. */
  storeId: string | null;
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

const PUBLIC_COLUMNS = `id, slug, name, url, auth_type AS "authType", auth_header_name AS "authHeaderName", enabled,
  store_id AS "storeId"`;
const UPSTREAM_COLUMNS = `${PUBLIC_COLUMNS}, auth_secret AS "authSecret"`;

function toConfig(row: UpstreamRow, cipher: CredentialCipher): UpstreamConfig {
  const config: UpstreamConfig = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
  };
  if (row.storeId) config.storeId = row.storeId;
  const secret = row.authSecret && cipher.decrypt(row.authSecret);
  if (row.authType === 'bearer' && secret) {
    config.credential = { header: 'authorization', value: `Bearer ${secret}` };
  } else if (row.authType === 'header' && row.authHeaderName && secret) {
    config.credential = { header: row.authHeaderName, value: secret };
  }
  return config;
}

/**
 * Every upstream with its credential decrypted and resolved to a header, for the registry. Stays in
 * the backend.
 */
export async function listUpstreamConfigs(
  db: Queryable,
  cipher: CredentialCipher,
): Promise<UpstreamConfig[]> {
  const rows = await db.query<UpstreamRow>(`SELECT ${UPSTREAM_COLUMNS} FROM upstreams ORDER BY created_at`);
  return rows.map((row) => toConfig(row, cipher));
}

/**
 * Encrypts credentials stored in clear by a gateway older than encryption at rest, and checks that
 * every encrypted one decrypts with this key. Returns how many it encrypted. Throws
 * CredentialDecryptError when one was encrypted with another key, so a wrong key stops the gateway at
 * startup.
 */
export async function encryptStoredCredentials(db: Database, cipher: CredentialCipher): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ id: string; authSecret: string }>(
      `SELECT id, auth_secret AS "authSecret" FROM upstreams WHERE auth_secret IS NOT NULL FOR UPDATE`,
    );
    let encrypted = 0;
    for (const { id, authSecret } of rows) {
      if (cipher.isEncrypted(authSecret)) {
        cipher.decrypt(authSecret);
        continue;
      }
      await tx.query('UPDATE upstreams SET auth_secret = $2 WHERE id = $1', [id, cipher.encrypt(authSecret)]);
      encrypted += 1;
    }
    return encrypted;
  });
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
 * The credential to store after an edit, with a new secret encrypted, or 'secret_required' when the
 * edit leaves an authenticated upstream without a secret. A URL change needs the secret entered
 * again, so an edit cannot send a stored credential, which nobody can read back, to a new address.
 */
function storedAuthAfter(
  current: StoredAuth,
  change: AuthChange | undefined,
  urlChanged: boolean,
  cipher: CredentialCipher,
): StoredAuth | 'secret_required' {
  if (change?.type === 'none' || (!change && current.authType === 'none')) {
    return { authType: 'none', authHeaderName: null, authSecret: null };
  }
  if (urlChanged && !change?.secret) return 'secret_required';
  const authType = change?.type ?? current.authType;
  const authSecret = change?.secret
    ? cipher.encrypt(change.secret)
    : current.authType === 'none'
      ? null
      : current.authSecret;
  if (!authSecret) return 'secret_required';
  const authHeaderName =
    change?.type === 'header' ? change.headerName : change ? null : current.authHeaderName;
  return { authType, authHeaderName, authSecret };
}

/**
 * Inserts an upstream. Returns 'slug_taken' when another upstream or a store has the slug, and
 * 'secret_required' when the credential type needs a secret and none was given.
 */
export async function createUpstream(
  db: Queryable,
  cipher: CredentialCipher,
  input: UpstreamInput,
): Promise<Upstream | 'slug_taken' | 'secret_required'> {
  const auth = storedAuthAfter(
    { authType: 'none', authHeaderName: null, authSecret: null },
    input.auth,
    false,
    cipher,
  );
  if (auth === 'secret_required') return auth;
  const [upstream] = await db.query<Upstream>(
    `INSERT INTO upstreams (slug, name, url, auth_type, auth_header_name, auth_secret, enabled)
     SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::boolean
     WHERE NOT EXISTS (SELECT 1 FROM stores WHERE slug = $1)
     ON CONFLICT (slug) DO NOTHING RETURNING ${PUBLIC_COLUMNS}`,
    [input.slug, input.name, input.url, auth.authType, auth.authHeaderName, auth.authSecret, input.enabled],
  );
  return upstream ?? 'slug_taken';
}

/**
 * Applies an admin's edit. Returns undefined for an unknown id, 'slug_taken' when another upstream
 * or a store has the new slug, 'secret_required' as described for storedAuthAfter, and
 * 'store_managed' for any change but enabling or disabling a store's upstream.
 */
export async function updateUpstream(
  db: Database,
  cipher: CredentialCipher,
  id: string,
  changes: Partial<UpstreamInput>,
): Promise<Upstream | undefined | 'slug_taken' | 'secret_required' | 'store_managed'> {
  return db.transaction(async (tx) => {
    const [current] = await tx.query<UpstreamRow>(
      `SELECT ${UPSTREAM_COLUMNS} FROM upstreams WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!current) return undefined;
    if (current.storeId && Object.keys(changes).some((field) => field !== 'enabled')) return 'store_managed';
    const url = changes.url ?? current.url;
    const auth = storedAuthAfter(current, changes.auth, url !== current.url, cipher);
    if (auth === 'secret_required') return auth;
    const [upstream] = await tx.query<Upstream>(
      `UPDATE upstreams SET slug = $2, name = $3, url = $4, auth_type = $5, auth_header_name = $6,
         auth_secret = $7, enabled = $8, updated_at = now()
       WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM upstreams WHERE slug = $2 AND id <> $1)
         AND NOT EXISTS (SELECT 1 FROM stores WHERE slug = $2 AND id IS DISTINCT FROM $9)
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
        current.storeId,
      ],
    );
    return upstream ?? 'slug_taken';
  });
}

/**
 * Removes an upstream and returns whether it existed. A store's upstream is not removed and gives
 * 'store_managed': deleting the store removes it.
 */
export async function deleteUpstream(db: Queryable, id: string): Promise<boolean | 'store_managed'> {
  if (
    (await db.query('DELETE FROM upstreams WHERE id = $1 AND store_id IS NULL RETURNING id', [id])).length
  ) {
    return true;
  }
  return (await db.query('SELECT 1 FROM upstreams WHERE id = $1', [id])).length > 0 ? 'store_managed' : false;
}

/** The admin-only servers and tools. Read on every listing and call, so a change applies at once. */
export async function loadToolRestrictions(db: Queryable): Promise<ToolRestrictions> {
  const [upstreams, tools] = await Promise.all([
    db.query<{ id: string }>('SELECT id FROM upstreams WHERE admin_only'),
    db.query<{ upstreamId: string; tool: string }>(
      'SELECT upstream_id AS "upstreamId", tool FROM admin_only_tools',
    ),
  ]);
  return {
    adminOnlyUpstreams: new Set(upstreams.map((row) => row.id)),
    adminOnlyTools: new Set(tools.map((row) => toolKey(row.upstreamId, row.tool))),
  };
}

/**
 * Sets whether an upstream is admin-only and which of its tools, by upstream tool name, are.
 * Replaces the previous tool list. Returns false for an unknown upstream.
 */
export async function setUpstreamAccess(
  db: Database,
  id: string,
  access: { adminOnly: boolean; adminOnlyTools: string[] },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.query('UPDATE upstreams SET admin_only = $2 WHERE id = $1 RETURNING id', [
      id,
      access.adminOnly,
    ]);
    if (updated.length === 0) return false;
    await tx.query('DELETE FROM admin_only_tools WHERE upstream_id = $1', [id]);
    await tx.query(
      'INSERT INTO admin_only_tools (upstream_id, tool) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING',
      [id, access.adminOnlyTools],
    );
    return true;
  });
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
