import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import * as z from 'zod/v4';

import { createApiKey, getApiKey, listApiKeys, revokeApiKey } from './apiKeys.js';
import { listAuditEntries } from './audit.js';
import type { Database } from './db.js';
import { auditScopeOf, isAdmin, mayManageKeysOf, memberChangeRefusal } from './permissions.js';
import {
  acceptInvite,
  authenticatePassword,
  createInvite,
  createSession,
  deleteInvite,
  deleteSession,
  getMember,
  inviteForToken,
  listInvites,
  listMembers,
  memberForSession,
  MIN_PASSWORD_LENGTH,
  SESSION_TTL_MS,
  updateMember,
} from './team.js';
import type { Member } from './team.js';

/** An error whose status and message are meant for the browser. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiDeps {
  db: Database;
  publicUrl: URL;
}

const SESSION_COOKIE = 'urumi_session';

const roleSchema = z.enum(['admin', 'member']);
const idSchema = z.uuid();
const tokenSchema = z.string().min(1).max(100);
const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(1000);

const loginBody = z.object({ email: z.string().max(320), password: z.string().max(1000) });
const inviteBody = z.object({ email: z.email().max(320), role: roleSchema });
const invitePreviewBody = z.object({ token: tokenSchema });
const inviteAcceptBody = z.object({
  token: tokenSchema,
  name: z.string().trim().min(1).max(100),
  password: passwordSchema,
});
const memberPatchBody = z
  .object({ role: roleSchema.optional(), active: z.boolean().optional() })
  .refine((change) => change.role !== undefined || change.active !== undefined, 'nothing to change');
const keyBody = z.object({ name: z.string().trim().min(1).max(100), memberId: idSchema.optional() });
const keyListQuery = z.object({ memberId: z.union([idSchema, z.literal('all')]).optional() });
const auditQuery = z.object({
  before: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Validates request input at the boundary. Throws HttpError 400 with what was wrong. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

function parseId(value: unknown): string {
  // A malformed id cannot name anything, and Postgres would reject it as invalid uuid syntax.
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(404, 'Not found.');
  return parsed.data;
}

function sessionIdOf(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === SESSION_COOKIE && value) return value;
  }
  return undefined;
}

function signedInMember(res: Response): Member {
  const member = res.locals.member as Member | undefined;
  if (!member) throw new HttpError(401, 'Sign in first.');
  return member;
}

function signedInAdmin(res: Response): Member {
  const member = signedInMember(res);
  if (!isAdmin(member)) throw new HttpError(403, 'Only admins can do this.');
  return member;
}

/**
 * Rejects state-changing requests that lack the X-Requested-With header. A cross-site form or link
 * cannot set it, so together with the SameSite=Lax cookie this blocks cross-site request forgery.
 */
function requireCustomHeader(req: Request, _res: Response, next: NextFunction): void {
  if (req.method !== 'GET' && req.get('x-requested-with') !== 'urumi-dashboard') {
    throw new HttpError(403, 'Missing X-Requested-With header.');
  }
  next();
}

/** The dashboard API under /api. Humans authenticate with a session cookie set by /api/login. */
export function createApiRouter({ db, publicUrl }: ApiDeps): Router {
  const router = express.Router();
  const secureCookie = publicUrl.protocol === 'https:';

  const startSession = async (res: Response, member: Member): Promise<void> => {
    res.cookie(SESSION_COOKIE, await createSession(db, member.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
  };

  router.use(express.json({ limit: '100kb' }));
  router.use(requireCustomHeader);
  router.use(async (req, res, next) => {
    const sessionId = sessionIdOf(req);
    res.locals.member = sessionId ? await memberForSession(db, sessionId) : undefined;
    next();
  });

  router.post('/login', async (req, res) => {
    const { email, password } = parse(loginBody, req.body);
    const member = await authenticatePassword(db, email, password);
    if (!member) throw new HttpError(401, 'Wrong email or password.');
    await startSession(res, member);
    res.json({ member });
  });

  router.post('/logout', async (req, res) => {
    const sessionId = sessionIdOf(req);
    if (sessionId) await deleteSession(db, sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  router.get('/me', (_req, res) => {
    res.json({ member: signedInMember(res) });
  });

  // Invite tokens travel in request bodies, not URLs, so they stay out of access logs.
  router.post('/invites/preview', async (req, res) => {
    const { token } = parse(invitePreviewBody, req.body);
    const invite = await inviteForToken(db, token);
    if (!invite) throw new HttpError(404, 'This invite link is invalid or has expired.');
    res.json({ email: invite.email, role: invite.role });
  });

  router.post('/invites/accept', async (req, res) => {
    const { token, name, password } = parse(inviteAcceptBody, req.body);
    const accepted = await acceptInvite(db, token, { name, password });
    if (accepted === 'invalid') throw new HttpError(404, 'This invite link is invalid or has expired.');
    if (accepted === 'email_taken') throw new HttpError(409, 'A member with this email already exists.');
    await startSession(res, accepted);
    res.status(201).json({ member: accepted });
  });

  router.get('/invites', async (_req, res) => {
    signedInAdmin(res);
    res.json({ invites: await listInvites(db) });
  });

  router.post('/invites', async (req, res) => {
    const admin = signedInAdmin(res);
    const { email, role } = parse(inviteBody, req.body);
    const { token, invite } = await createInvite(db, { email, role, createdBy: admin.id });
    // The fragment never reaches a server, so the token is not in any request line or log.
    const inviteUrl = new URL(`/invite#${token}`, publicUrl).toString();
    res.status(201).json({ invite, inviteUrl });
  });

  router.delete('/invites/:id', async (req, res) => {
    signedInAdmin(res);
    if (!(await deleteInvite(db, parseId(req.params.id)))) throw new HttpError(404, 'Not found.');
    res.status(204).end();
  });

  router.get('/members', async (_req, res) => {
    signedInAdmin(res);
    res.json({ members: await listMembers(db) });
  });

  router.patch('/members/:id', async (req, res) => {
    const actor = signedInMember(res);
    const change = parse(memberPatchBody, req.body);
    const target = await getMember(db, parseId(req.params.id));
    if (!target) throw new HttpError(404, 'Not found.');
    const refusal = memberChangeRefusal(actor, target, change);
    if (refusal) throw new HttpError(403, refusal);
    res.json({ member: await updateMember(db, target.id, change) });
  });

  router.get('/keys', async (req, res) => {
    const actor = signedInMember(res);
    const { memberId = actor.id } = parse(keyListQuery, req.query);
    if (memberId === 'all' ? !isAdmin(actor) : !mayManageKeysOf(actor, memberId)) {
      throw new HttpError(403, 'You can only see your own keys.');
    }
    res.json({ keys: await listApiKeys(db, memberId === 'all' ? undefined : memberId) });
  });

  router.post('/keys', async (req, res) => {
    const actor = signedInMember(res);
    const { name, memberId = actor.id } = parse(keyBody, req.body);
    if (!mayManageKeysOf(actor, memberId))
      throw new HttpError(403, 'Only admins can create keys for others.');
    const owner = await getMember(db, memberId);
    if (!owner?.active) throw new HttpError(404, 'No active member with this id.');
    const { key, apiKey } = await createApiKey(db, { memberId, name, createdBy: actor.id });
    // The only time the full key leaves the gateway.
    res.status(201).json({ key, apiKey });
  });

  router.delete('/keys/:id', async (req, res) => {
    const actor = signedInMember(res);
    const apiKey = await getApiKey(db, parseId(req.params.id));
    if (!apiKey) throw new HttpError(404, 'Not found.');
    if (!mayManageKeysOf(actor, apiKey.memberId))
      throw new HttpError(403, 'You can only revoke your own keys.');
    res.json({ apiKey: await revokeApiKey(db, apiKey.id) });
  });

  router.get('/audit', async (req, res) => {
    const actor = signedInMember(res);
    const { before, limit } = parse(auditQuery, req.query);
    res.json({ entries: await listAuditEntries(db, { memberId: auditScopeOf(actor), before, limit }) });
  });

  return router;
}
