import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import * as z from 'zod/v4';

import type Anthropic from '@anthropic-ai/sdk';

import { createApiKey, getApiKey, listApiKeys, revokeApiKey } from './apiKeys.js';
import { listAuditEntries, upstreamCallStats } from './audit.js';
import type { UpstreamCallStats } from './audit.js';
import { chatFailureMessage, runChatTurn } from './chat.js';
import type { ChatEvent, ChatTurn } from './chat.js';
import type { Database } from './db.js';
import {
  auditScopeOf,
  isAdmin,
  mayCallTool,
  mayManageKeysOf,
  mayManageStoreOf,
  toolKey,
} from './permissions.js';
import type { ToolRestrictions } from './permissions.js';
import type { UpstreamRegistry, UpstreamState } from './registry.js';
import {
  createStore,
  getStore,
  listStores,
  requestStoreDeletion,
  retryStore,
  STORE_SLUG_PATTERN,
  storeUrl,
} from './stores.js';
import type { CreateStoreRefusal } from './stores.js';
import {
  acceptInvite,
  authenticatePassword,
  changeMember,
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
} from './team.js';
import type { Member } from './team.js';
import {
  createUpstream,
  deleteUpstream,
  listUpstreamConfigs,
  listUpstreams,
  loadToolRestrictions,
  setUpstreamAccess,
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
  stores: { domain: string; maxPerMember: number };
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

const accessBody = z.object({
  adminOnly: z.boolean(),
  // Upstream tool names, as listed in originalName.
  adminOnlyTools: z.array(z.string().min(1).max(128)).max(1000),
});

const storeBody = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[^\p{Cc}]+$/u, 'must not contain control characters'),
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
    throw new HttpError(403, 'The X-Requested-With header must be urumi-dashboard.');
  }
  next();
}

// The period of the per-server call statistics on the Servers page.
const STATS_HOURS = 24;
const NO_CALLS: UpstreamCallStats = {
  calls: 0,
  errors: 0,
  timedOut: 0,
  rejected: 0,
  p50Ms: null,
  p95Ms: null,
};

/**
 * An upstream with its live status and tools. Members get no URL, credential details, call
 * statistics or permissions, and only the tools they may call, since they only need to know which
 * tools they can use.
 */
function upstreamView(
  upstream: Upstream,
  state: UpstreamState | undefined,
  viewer: Member,
  restrictions: ToolRestrictions,
  stats: UpstreamCallStats | undefined,
) {
  const { url, authType, authHeaderName, ...visible } = upstream;
  const admin = isAdmin(viewer);
  return {
    ...visible,
    ...(admin && {
      url,
      authType,
      authHeaderName,
      stats: stats ?? NO_CALLS,
      adminOnly: restrictions.adminOnlyUpstreams.has(upstream.id),
    }),
    status: state?.status ?? (upstream.enabled ? 'unreachable' : 'disabled'),
    error: state?.error ?? null,
    checkedAt: state?.checkedAt ?? null,
    tools: (state?.tools ?? [])
      .filter((tool) => mayCallTool(viewer, tool, restrictions))
      .map(({ name, originalName, tool }) => ({
        name,
        originalName,
        title: tool.title ?? null,
        description: tool.description ?? null,
        ...(admin && {
          adminOnly: restrictions.adminOnlyTools.has(toolKey(upstream.id, originalName)),
        }),
      })),
  };
}

function upstreamChangeRefusal(outcome: 'slug_taken' | 'secret_required' | 'store_managed'): HttpError {
  if (outcome === 'slug_taken')
    return new HttpError(409, 'Another server or a store already uses this slug.');
  if (outcome === 'store_managed') {
    return new HttpError(409, 'This server belongs to a store. Delete the store on the Stores page instead.');
  }
  return new HttpError(
    400,
    'Enter the secret. It is required for this credential type and after a URL change.',
  );
}

function storeCreateRefusal(outcome: CreateStoreRefusal, maxPerMember: number): HttpError {
  if (outcome === 'limit_reached') {
    return new HttpError(409, `You already have ${maxPerMember} stores, the most a member can have.`);
  }
  if (outcome === 'being_deleted') {
    return new HttpError(409, 'Your store with this name is still being deleted. Try again in a minute.');
  }
  return new HttpError(409, 'Another store or server already uses this name. Pick another name.');
}

/** The dashboard API under /api. Humans authenticate with a session cookie set by /api/login. */
export function createApiRouter({ db, registry, anthropic, publicUrl, stores }: ApiDeps): Router {
  const router = express.Router();
  const secureCookie = publicUrl.protocol === 'https:';

  const applyUpstreamChanges = (): Promise<void> => registry.reload(() => listUpstreamConfigs(db));
  const upstreamResponse = async (upstream: Upstream, admin: Member) => ({
    upstream: upstreamView(
      upstream,
      registry.states().get(upstream.id),
      admin,
      await loadToolRestrictions(db),
      (await upstreamCallStats(db, STATS_HOURS)).get(upstream.id),
    ),
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

  // A chat history may hold 50 messages of 20,000 characters, about 1 MB, or 3 MB of non-Latin text.
  // A body parsed here is skipped by the general parser below.
  router.use('/chat', express.json({ limit: '4mb' }));
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
    const member = await changeMember(db, actor.id, parseId(req.params.id), change);
    if (!member) throw new HttpError(404, 'Not found.');
    if (typeof member === 'string') throw new HttpError(403, member);
    res.json({ member });
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
    const viewer = signedInMember(res);
    const states = registry.states();
    const [upstreams, restrictions] = await Promise.all([listUpstreams(db), loadToolRestrictions(db)]);
    // Statistics count every member's calls, so only admins get them, as with the full audit log.
    const stats = isAdmin(viewer) ? await upstreamCallStats(db, STATS_HOURS) : new Map();
    res.json({
      upstreams: upstreams
        // An admin-only server is hidden from members altogether, as its tools are.
        .filter((upstream) => isAdmin(viewer) || !restrictions.adminOnlyUpstreams.has(upstream.id))
        .map((upstream) =>
          upstreamView(upstream, states.get(upstream.id), viewer, restrictions, stats.get(upstream.id)),
        ),
    });
  });

  // Each change is applied to the registry before responding, so the response carries the new status.
  router.post('/upstreams', async (req, res) => {
    const admin = signedInAdmin(res);
    const { slug, ...input } = parse(upstreamBody, req.body);
    const derivedSlug = slug ?? slugFromName(input.name);
    if (!SLUG_PATTERN.test(derivedSlug)) {
      throw new HttpError(400, 'Enter a slug of 2-16 characters of a-z, 0-9 and -.');
    }
    const created = await createUpstream(db, { ...input, slug: derivedSlug });
    if (typeof created === 'string') throw upstreamChangeRefusal(created);
    await applyUpstreamChanges();
    res.status(201).json(await upstreamResponse(created, admin));
  });

  router.patch('/upstreams/:id', async (req, res) => {
    const admin = signedInAdmin(res);
    const changes = parse(upstreamPatchBody, req.body);
    const updated = await updateUpstream(db, parseId(req.params.id), changes);
    if (!updated) throw new HttpError(404, 'Not found.');
    if (typeof updated === 'string') throw upstreamChangeRefusal(updated);
    await applyUpstreamChanges();
    res.json(await upstreamResponse(updated, admin));
  });

  // Store upstreams can be restricted too: who may use a server is the admins' call, not the store's.
  router.put('/upstreams/:id/access', async (req, res) => {
    const admin = signedInAdmin(res);
    const id = parseId(req.params.id);
    if (!(await setUpstreamAccess(db, id, parse(accessBody, req.body))))
      throw new HttpError(404, 'Not found.');
    // The tool list is per member now, so listening clients list again.
    registry.announceToolsChanged();
    const upstream = (await listUpstreams(db)).find((candidate) => candidate.id === id)!;
    res.json(await upstreamResponse(upstream, admin));
  });

  router.delete('/upstreams/:id', async (req, res) => {
    signedInAdmin(res);
    const deleted = await deleteUpstream(db, parseId(req.params.id));
    if (!deleted) throw new HttpError(404, 'Not found.');
    if (deleted === 'store_managed') throw upstreamChangeRefusal(deleted);
    await applyUpstreamChanges();
    res.status(204).end();
  });

  // Every member sees every store, because every store's tools are shared with the whole team.
  router.get('/stores', async (_req, res) => {
    signedInMember(res);
    res.json({ stores: await listStores(db) });
  });

  // The provisioner picks the store up from the database. Sending the same name again returns the
  // existing store with 200, so a client can retry a create whose response it never got.
  router.post('/stores', async (req, res) => {
    const member = signedInMember(res);
    const { name } = parse(storeBody, req.body);
    const slug = slugFromName(name);
    if (!STORE_SLUG_PATTERN.test(slug)) {
      throw new HttpError(400, 'Use a name with at least two letters or digits.');
    }
    const outcome = await createStore(db, {
      slug,
      name,
      url: storeUrl(slug, stores.domain, publicUrl.protocol),
      ownerId: member.id,
      maxPerMember: stores.maxPerMember,
    });
    if (typeof outcome === 'string') throw storeCreateRefusal(outcome, stores.maxPerMember);
    res.status(outcome.created ? 201 : 200).json({ store: outcome.store });
  });

  router.post('/stores/:id/retry', async (req, res) => {
    const actor = signedInMember(res);
    const store = await getStore(db, parseId(req.params.id));
    if (!store) throw new HttpError(404, 'Not found.');
    if (!mayManageStoreOf(actor, store.ownerId))
      throw new HttpError(403, 'You can only retry your own stores.');
    if (!(await retryStore(db, store.id))) throw new HttpError(409, 'Only a failed store can be retried.');
    res.json({ store: await getStore(db, store.id) });
  });

  // Removing the store's upstream is part of the request, so its tools are gone from clients at once.
  // The provisioner then deletes the namespace and, once it is gone, the store.
  router.delete('/stores/:id', async (req, res) => {
    const actor = signedInMember(res);
    const store = await getStore(db, parseId(req.params.id));
    if (!store) throw new HttpError(404, 'Not found.');
    if (!mayManageStoreOf(actor, store.ownerId))
      throw new HttpError(403, 'You can only delete your own stores.');
    await requestStoreDeletion(db, store.id);
    await applyUpstreamChanges();
    res.status(202).json({ store: await getStore(db, store.id) });
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
