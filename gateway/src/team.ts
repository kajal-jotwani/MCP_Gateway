import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import type { Database, Queryable } from './db.js';
import { hashToken, newToken } from './tokens.js';

export type Role = 'admin' | 'member';

export interface Member {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 12;

const MEMBER_COLUMNS = 'm.id, m.email, m.name, m.role, m.active';
const INVITE_COLUMNS = 'id, email, role, expires_at AS "expiresAt"';

// scrypt with N=2^15, r=8 needs 32 MiB, which is exactly Node's default memory cap.
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SCRYPT_KEY_LENGTH = 32;

function deriveKey(password: string, salt: Buffer, params: typeof SCRYPT_PARAMS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, { ...params, maxmem: SCRYPT_MAXMEM }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** Hashes a password with scrypt and a random salt, in the form `scrypt$N$r$p$salt$hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Checks a password against a hash from hashPassword, in constant time. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await deriveKey(password, Buffer.from(salt, 'base64'), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Compared against when an email is unknown, so a failed login takes as long either way.
let unknownMemberHash: Promise<string> | undefined;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Returns the active member with this email and password, or undefined. */
export async function authenticatePassword(
  db: Queryable,
  email: string,
  password: string,
): Promise<Member | undefined> {
  const [row] = await db.query<Member & { passwordHash: string }>(
    `SELECT ${MEMBER_COLUMNS}, m.password_hash AS "passwordHash" FROM members m WHERE m.email = $1`,
    [normalizeEmail(email)],
  );
  if (!row) {
    unknownMemberHash ??= hashPassword(newToken());
    await verifyPassword(password, await unknownMemberHash);
    return undefined;
  }
  const { passwordHash, ...member } = row;
  const valid = await verifyPassword(password, passwordHash);
  return valid && member.active ? member : undefined;
}

/** Inserts a member. Returns undefined when the email is already taken. */
export async function createMember(
  db: Queryable,
  input: { email: string; name: string; role: Role; password: string },
): Promise<Member | undefined> {
  const [member] = await db.query<Member>(
    `INSERT INTO members AS m (email, name, role, password_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING RETURNING ${MEMBER_COLUMNS}`,
    [normalizeEmail(input.email), input.name, input.role, await hashPassword(input.password)],
  );
  return member;
}

/** Creates the first admin when the team has no members yet. Returns whether it did. */
export async function ensureFirstAdmin(
  db: Database,
  admin: { email: string; password: string },
): Promise<boolean> {
  const passwordHash = await hashPassword(admin.password);
  const inserted = await db.query(
    `INSERT INTO members (email, name, role, password_hash)
     SELECT $1, 'Admin', 'admin', $2 WHERE NOT EXISTS (SELECT 1 FROM members) RETURNING id`,
    [normalizeEmail(admin.email), passwordHash],
  );
  return inserted.length > 0;
}

export async function listMembers(db: Queryable): Promise<Member[]> {
  return db.query<Member>(`SELECT ${MEMBER_COLUMNS} FROM members m ORDER BY m.created_at`);
}

export async function getMember(db: Queryable, id: string): Promise<Member | undefined> {
  const [member] = await db.query<Member>(`SELECT ${MEMBER_COLUMNS} FROM members m WHERE m.id = $1`, [id]);
  return member;
}

/** Changes a member's role or active flag. A deactivated member's sessions and keys stop working at once. */
export async function updateMember(
  db: Queryable,
  id: string,
  changes: { role?: Role; active?: boolean },
): Promise<Member | undefined> {
  const [member] = await db.query<Member>(
    `UPDATE members AS m SET role = COALESCE($2, role), active = COALESCE($3, active)
     WHERE m.id = $1 RETURNING ${MEMBER_COLUMNS}`,
    [id, changes.role ?? null, changes.active ?? null],
  );
  return member;
}

/** Starts a session and returns its id, which only the browser cookie holds. Expired sessions are purged. */
export async function createSession(db: Queryable, memberId: string): Promise<string> {
  const sessionId = newToken();
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  await db.query('INSERT INTO sessions (id_hash, member_id, expires_at) VALUES ($1, $2, $3)', [
    hashToken(sessionId),
    memberId,
    new Date(Date.now() + SESSION_TTL_MS),
  ]);
  return sessionId;
}

/** The active member a session belongs to, or undefined for an unknown or expired session. */
export async function memberForSession(db: Queryable, sessionId: string): Promise<Member | undefined> {
  const [member] = await db.query<Member>(
    `SELECT ${MEMBER_COLUMNS} FROM sessions s JOIN members m ON m.id = s.member_id
     WHERE s.id_hash = $1 AND s.expires_at > now() AND m.active`,
    [hashToken(sessionId)],
  );
  return member;
}

export async function deleteSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE id_hash = $1', [hashToken(sessionId)]);
}

/** Creates an invite and returns its one-time token, which is shown once and stored only as a hash. */
export async function createInvite(
  db: Queryable,
  input: { email: string; role: Role; createdBy: string },
): Promise<{ token: string; invite: Invite }> {
  const token = newToken();
  const [invite] = await db.query<Invite>(
    `INSERT INTO invites (token_hash, email, role, created_by, expires_at) VALUES ($1, $2, $3, $4, $5)
     RETURNING ${INVITE_COLUMNS}`,
    [
      hashToken(token),
      normalizeEmail(input.email),
      input.role,
      input.createdBy,
      new Date(Date.now() + INVITE_TTL_MS),
    ],
  );
  return { token, invite: invite! };
}

/** Invites that have not been used and have not expired. */
export async function listInvites(db: Queryable): Promise<Invite[]> {
  return db.query<Invite>(
    `SELECT ${INVITE_COLUMNS} FROM invites WHERE expires_at > now() ORDER BY expires_at`,
  );
}

export async function deleteInvite(db: Queryable, id: string): Promise<boolean> {
  return (await db.query('DELETE FROM invites WHERE id = $1 RETURNING id', [id])).length > 0;
}

export async function inviteForToken(db: Queryable, token: string): Promise<Invite | undefined> {
  const [invite] = await db.query<Invite>(
    `SELECT ${INVITE_COLUMNS} FROM invites WHERE token_hash = $1 AND expires_at > now()`,
    [hashToken(token)],
  );
  return invite;
}

/**
 * Turns an invite into a member with the given name and password and deletes the invite, in one
 * transaction so a token works once. Returns 'invalid' for an unknown or expired token and
 * 'email_taken' when a member with the invited email already exists.
 */
export async function acceptInvite(
  db: Database,
  token: string,
  input: { name: string; password: string },
): Promise<Member | 'invalid' | 'email_taken'> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [invite] = await tx.query<{ email: string; role: Role }>(
      'DELETE FROM invites WHERE token_hash = $1 AND expires_at > now() RETURNING email, role',
      [hashToken(token)],
    );
    if (!invite) return 'invalid';
    const [member] = await tx.query<Member>(
      `INSERT INTO members AS m (email, name, role, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING RETURNING ${MEMBER_COLUMNS}`,
      [invite.email, input.name, invite.role, passwordHash],
    );
    return member ?? 'email_taken';
  });
}
