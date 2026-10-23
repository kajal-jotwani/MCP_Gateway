import type { Queryable } from './db.js';
import type { Member } from './team.js';
import { hashToken, newToken } from './tokens.js';

const KEY_PREFIX = 'urk_';
const KEY_PATTERN = /^urk_[A-Za-z0-9_-]{43}$/;

export interface ApiKey {
  id: string;
  memberId: string;
  name: string;
  /** The 8 characters after `urk_`, kept in clear so people can tell their keys apart. */
  displayPrefix: string;
  createdBy: string;
  createdAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export interface VerifiedKey {
  member: Member;
  keyId: string;
  displayPrefix: string;
}

/** Why a presented key was refused. `memberId` is set when the key was issued to a member. */
export interface RejectedKey {
  rejected: 'unknown' | 'revoked' | 'member_deactivated';
  memberId?: string;
}

const KEY_COLUMNS = `id, member_id AS "memberId", name, display_prefix AS "displayPrefix",
  created_by AS "createdBy", created_at AS "createdAt", revoked_at AS "revokedAt", last_used_at AS "lastUsedAt"`;

/** The display prefix of a well-formed key, or undefined for anything else. */
export function displayPrefixOf(key: string): string | undefined {
  return KEY_PATTERN.test(key) ? key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 8) : undefined;
}

/** Creates a key for a member. The full key is returned once; only its SHA-256 hash is stored. */
export async function createApiKey(
  db: Queryable,
  input: { memberId: string; name: string; createdBy: string },
): Promise<{ key: string; apiKey: ApiKey }> {
  const key = `${KEY_PREFIX}${newToken()}`;
  const [apiKey] = await db.query<ApiKey>(
    `INSERT INTO api_keys (member_id, key_hash, display_prefix, name, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${KEY_COLUMNS}`,
    [input.memberId, hashToken(key), displayPrefixOf(key), input.name, input.createdBy],
  );
  return { key, apiKey: apiKey! };
}

/** Keys of one member, or of everyone when memberId is undefined, newest first. */
export async function listApiKeys(db: Queryable, memberId: string | undefined): Promise<ApiKey[]> {
  return db.query<ApiKey>(
    `SELECT ${KEY_COLUMNS} FROM api_keys WHERE $1::uuid IS NULL OR member_id = $1 ORDER BY created_at DESC`,
    [memberId ?? null],
  );
}

export async function getApiKey(db: Queryable, id: string): Promise<ApiKey | undefined> {
  const [apiKey] = await db.query<ApiKey>(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = $1`, [id]);
  return apiKey;
}

/** Revokes a key. Verification reads the database on every request, so the next call is rejected. */
export async function revokeApiKey(db: Queryable, id: string): Promise<ApiKey | undefined> {
  const [apiKey] = await db.query<ApiKey>(
    `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING ${KEY_COLUMNS}`,
    [id],
  );
  return apiKey;
}

/**
 * Looks up the member a presented key belongs to, or says why it is refused: malformed or unknown,
 * revoked, or its member deactivated. There is no cache, so revocation applies to the next request.
 */
export async function verifyApiKey(db: Queryable, key: string): Promise<VerifiedKey | RejectedKey> {
  const displayPrefix = displayPrefixOf(key);
  if (!displayPrefix) return { rejected: 'unknown' };
  const [row] = await db.query<Member & { keyId: string; revoked: boolean }>(
    `SELECT k.id AS "keyId", k.revoked_at IS NOT NULL AS revoked, m.id, m.email, m.name, m.role, m.active
     FROM api_keys k JOIN members m ON m.id = k.member_id
     WHERE k.key_hash = $1`,
    [hashToken(key)],
  );
  if (!row) return { rejected: 'unknown' };
  // A refused key that matches a stored hash was issued to this member, so its calls are audited
  // under them.
  if (row.revoked) return { rejected: 'revoked', memberId: row.id };
  if (!row.active) return { rejected: 'member_deactivated', memberId: row.id };
  // Written at most once a minute per key, so busy clients do not turn every call into a write.
  await db.query(
    `UPDATE api_keys SET last_used_at = now()
     WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [row.keyId],
  );
  const { keyId, id, email, name, role, active } = row;
  return { member: { id, email, name, role, active }, keyId, displayPrefix };
}
