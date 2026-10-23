import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import * as z from 'zod/v4';

import type Anthropic from '@anthropic-ai/sdk';

import { createApiKey, getApiKey, listApiKeys, revokeApiKey } from './apiKeys.js';
import { listAuditEntries } from './audit.js';
import { chatFailureMessage, runChatTurn } from './chat.js';
import type { ChatEvent, ChatTurn } from './chat.js';
import type { Database } from './db.js';
import { auditScopeOf, isAdmin, mayManageKeysOf, memberChangeRefusal } from './permissions.js';
import type { UpstreamRegistry, UpstreamState } from './registry.js';
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
import {
  createUpstream,
  deleteUpstream,
  listUpstreamConfigs,
  listUpstreams,
  SLUG_PATTERN,
  slugFromName,
  updateUpstream,
} from './upstreams.js';
import type { Upstream } from './upstreams.js';

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
  registry: UpstreamRegistry;
  anthropic: Anthropic;
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

// Headers the MCP transport sets itself or that change HTTP framing. A credential cannot replace them.
const RESERVED_HEADERS = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'host',
  'keep-alive',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const slugSchema = z.string().regex(SLUG_PATTERN, 'must be 2-16 characters of a-z, 0-9 and -');
const upstreamUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((url) => {
    const parsed = new URL(url);
    return !parsed.username && !parsed.password;
  }, 'must not contain a user name or password; use the credential fields');
// fetch only sends printable ASCII header values, and a line break would split the header.
const secretSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[\x20-\x7e]+$/, 'must be printable ASCII on one line');
const headerNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/, 'must be a valid HTTP header name')
  .refine((name) => !RESERVED_HEADERS.has(name), 'is set by the gateway and cannot carry a credential');
const newAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), secret: secretSchema }),
  z.object({ type: z.literal('header'), headerName: headerNameSchema, secret: secretSchema }),
]);
const changedAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), secret: secretSchema.optional() }),
  z.object({ type: z.literal('header'), headerName: headerNameSchema, secret: secretSchema.optional() }),
]);
const upstreamNameSchema = z.string().trim().min(1).max(100);
const upstreamBody = z.object({
  name: upstreamNameSchema,
  slug: slugSchema.optional(),
  url: upstreamUrlSchema,
  auth: newAuthSchema.default({ type: 'none' }),
  enabled: z.boolean().default(true),
});
const upstreamPatchBody = z.object({
  name: upstreamNameSchema.optional(),
  slug: slugSchema.optional(),
  url: upstreamUrlSchema.optional(),
  auth: changedAuthSchema.optional(),
  enabled: z.boolean().optional(),
});

const chatBody = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().trim().min(1).max(20_000) }))
    .min(1)
    .max(50)
    .refine(
      (turns: ChatTurn[]) =>
        turns.every((turn, index) => turn.role === (index % 2 === 0 ? 'user' : 'assistant')) &&
        turns.length % 2 === 1,
      'must alternate between user and assistant, starting and ending with user',
    ),
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

/**
 * An upstream with its live status and tools. Members get no URL or credential details, since they
 * only need to know which tools exist.
 */
function upstreamView(upstream: Upstream, state: UpstreamState | undefined, admin: boolean) {
  const { url, authType, authHeaderName, ...visible } = upstream;
  return {
    ...visible,
    ...(admin && { url, authType, authHeaderName }),
    status: state?.status ?? (upstream.enabled ? 'unreachable' : 'disabled'),
    error: state?.error ?? null,
    checkedAt: state?.checkedAt ?? null,
    tools: (state?.tools ?? []).map(({ name, originalName, tool }) => ({
      name,
      originalName,
      title: tool.title ?? null,
      description: tool.description ?? null,
    })),
  };
}

function upstreamChangeRefusal(outcome: 'slug_taken' | 'secret_required'): HttpError {
  return outcome === 'slug_taken'
    ? new HttpError(409, 'Another server already uses this slug.')
    : new HttpError(400, 'Enter the secret. It is required for this credential type and after a URL change.');
}

/** The dashboard API under /api. Humans authenticate with a session cookie set by /api/login. */
export function createApiRouter({ db, registry, anthropic, publicUrl }: ApiDeps): Router {
  const router = express.Router();
  const secureCookie = publicUrl.protocol === 'https:';

  // Serialized, so when edits overlap the last sync reads the latest rows.
  let upstreamsApplied = Promise.resolve();
  const applyUpstreamChanges = (): Promise<void> => {
    const next = upstreamsApplied.then(async () => registry.sync(await listUpstreamConfigs(db)));
    upstreamsApplied = next.catch(() => undefined);
    return next;
  };
  const upstreamResponse = (upstream: Upstream) => ({
    upstream: upstreamView(upstream, registry.states().get(upstream.id), true),
  });

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

  router.get('/upstreams', async (_req, res) => {
    const admin = isAdmin(signedInMember(res));
    const states = registry.states();
    const upstreams = await listUpstreams(db);
    res.json({
      upstreams: upstreams.map((upstream) => upstreamView(upstream, states.get(upstream.id), admin)),
    });
  });

  // Each change is applied to the registry before responding, so the response carries the new status.
  router.post('/upstreams', async (req, res) => {
    signedInAdmin(res);
    const { slug, ...input } = parse(upstreamBody, req.body);
    const derivedSlug = slug ?? slugFromName(input.name);
    if (!SLUG_PATTERN.test(derivedSlug)) {
      throw new HttpError(400, 'Enter a slug of 2-16 characters of a-z, 0-9 and -.');
    }
    const created = await createUpstream(db, { ...input, slug: derivedSlug });
    if (typeof created === 'string') throw upstreamChangeRefusal(created);
    await applyUpstreamChanges();
    res.status(201).json(upstreamResponse(created));
  });

  router.patch('/upstreams/:id', async (req, res) => {
    signedInAdmin(res);
    const changes = parse(upstreamPatchBody, req.body);
    const updated = await updateUpstream(db, parseId(req.params.id), changes);
    if (!updated) throw new HttpError(404, 'Not found.');
    if (typeof updated === 'string') throw upstreamChangeRefusal(updated);
    await applyUpstreamChanges();
    res.json(upstreamResponse(updated));
  });

  router.delete('/upstreams/:id', async (req, res) => {
    signedInAdmin(res);
    if (!(await deleteUpstream(db, parseId(req.params.id)))) throw new HttpError(404, 'Not found.');
    await applyUpstreamChanges();
    res.status(204).end();
  });

  // Streams the turn as newline-delimited JSON, so the dashboard can show text and tool calls as they
  // happen. The browser holds the conversation and sends it with each message.
  router.post('/chat', async (req, res) => {
    const member = signedInMember(res);
    const { messages } = parse(chatBody, req.body);
    const disconnected = new AbortController();
    res.on('close', () => disconnected.abort());
    res.status(200).set({ 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    const emit = (event: ChatEvent) => res.write(`${JSON.stringify(event)}\n`);
    const started = Date.now();
    try {
      await runChatTurn({ db, registry, anthropic }, member, messages, emit, disconnected.signal);
    } catch (error) {
      if (!disconnected.signal.aborted) {
        console.error(
          JSON.stringify({
            event: 'chat_failed',
            memberId: member.id,
            durationMs: Date.now() - started,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        emit({ type: 'error', message: chatFailureMessage(error) });
      }
    }
    res.end();
  });

  // Without this, an unknown /api path would fall through to the dashboard's index.html.
  router.use(() => {
    throw new HttpError(404, 'Not found.');
  });

  return router;
}
