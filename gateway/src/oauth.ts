import { createHash } from 'node:crypto';

import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import * as z from 'zod/v4';

import type { Queryable } from './db.js';
import type { Member } from './team.js';
import { hashToken, newToken } from './tokens.js';

const ACCESS_TOKEN_PREFIX = 'uoa_';
const REFRESH_TOKEN_PREFIX = 'uor_';
const ACCESS_TOKEN_TTL_SECONDS = 3600;
// Counted from the last refresh, so a client in regular use stays signed in.
const REFRESH_TOKEN_TTL_DAYS = 30;
// Long enough for a client to exchange the code right after the redirect, short enough that a leaked
// code is useless soon after.
const CODE_TTL_SECONDS = 120;
// A registered client that never got a grant is deleted after this long, so open registration cannot
// grow the table without bound.
const UNUSED_CLIENT_DAYS = 1;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:']);
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/** The gateway as OAuth authorization server (issuer) and as the protected resource (/mcp). */
export interface OAuthIssuer {
  issuer: string;
  resource: string;
}

export function oauthIssuerFor(publicUrl: URL): OAuthIssuer {
  return { issuer: publicUrl.origin, resource: `${publicUrl.origin}/mcp` };
}

/** Where the 401 challenge on /mcp points clients to discover the authorization server (RFC 9728). */
export function resourceMetadataUrl({ issuer }: OAuthIssuer): string {
  return `${issuer}/.well-known/oauth-protected-resource/mcp`;
}

/** The authorization server metadata document (RFC 8414). */
export function authorizationServerMetadata({ issuer }: OAuthIssuer): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
  };
}

/** The protected resource metadata document (RFC 9728). /mcp and /mcp/search share it. */
export function protectedResourceMetadata({ issuer, resource }: OAuthIssuer): Record<string, unknown> {
  return {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    resource_name: 'Team MCP gateway',
  };
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Why a redirect URI cannot be registered, or undefined. Allowed: https, http on a loopback address
 * (CLI clients), and an app's own scheme such as cursor:// (RFC 8252). Never a fragment.
 */
export function redirectUriRefusal(value: string): string | undefined {
  const url = parseUrl(value);
  if (!url) return 'it is not an absolute URL';
  if (url.hash) return 'it must not have a fragment';
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname))
    return 'http is allowed only on localhost, 127.0.0.1 or [::1]';
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return `the ${url.protocol} scheme is not allowed`;
  return undefined;
}

/**
 * Whether a redirect URI in an authorization request is one the client registered. Loopback http
 * URIs match on any port, because CLI clients listen on a free port each run (RFC 8252 section 7.3).
 */
export function redirectUriRegistered(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const wanted = parseUrl(requested);
  if (wanted?.protocol !== 'http:' || !LOOPBACK_HOSTS.has(wanted.hostname)) return false;
  return registered.some((uri) => {
    const candidate = parseUrl(uri);
    return (
      candidate?.protocol === 'http:' &&
      candidate.hostname === wanted.hostname &&
      candidate.pathname === wanted.pathname &&
      candidate.search === wanted.search
    );
  });
}

/** Whether a PKCE code verifier hashes to the S256 challenge from the authorization request. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  return (
    CODE_VERIFIER_PATTERN.test(verifier) &&
    createHash('sha256').update(verifier).digest('base64url') === challenge
  );
}

/** Whether a client's RFC 8707 resource indicator names this gateway's MCP endpoint. Absent is fine. */
export function resourceAccepted(resource: string | undefined, issuer: OAuthIssuer): boolean {
  return resource === undefined || resource.replace(/\/$/, '') === issuer.resource;
}

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
}

/** Registers a public client (RFC 7591) and deletes registrations that never led to a grant. */
export async function registerOAuthClient(
  db: Queryable,
  input: { name: string; redirectUris: string[] },
): Promise<OAuthClient> {
  await db.query(
    `DELETE FROM oauth_clients c WHERE c.created_at < now() - make_interval(days => $1::int)
     AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)`,
    [UNUSED_CLIENT_DAYS],
  );
  const id = `uoc_${newToken().slice(0, 22)}`;
  await db.query('INSERT INTO oauth_clients (id, name, redirect_uris) VALUES ($1, $2, $3)', [
    id,
    input.name,
    input.redirectUris,
  ]);
  return { id, name: input.name, redirectUris: input.redirectUris };
}

async function getOAuthClient(db: Queryable, id: string): Promise<OAuthClient | undefined> {
  const [client] = await db.query<OAuthClient>(
    'SELECT id, name, redirect_uris AS "redirectUris" FROM oauth_clients WHERE id = $1',
    [id],
  );
  return client;
}

export interface AuthorizationRequest {
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
}

/**
 * The outcome of checking an authorization request. `refused`: the client or redirect URI is wrong, so
 * the person sees the message and nothing is redirected. `redirect`: any other error, which goes back
 * to the client's redirect URI.
 */
export type AuthorizationCheck =
  | { outcome: 'refused'; message: string }
  | { outcome: 'redirect'; redirectUrl: string }
  | { outcome: 'valid'; request: AuthorizationRequest };

function redirectTo(redirectUri: string, issuer: OAuthIssuer, params: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(name, value);
  // RFC 9207: tells the client which authorization server answered, against mix-up attacks.
  url.searchParams.set('iss', issuer.issuer);
  return url.href;
}

/** Checks an authorization request's query parameters (OAuth 2.1 authorization code with PKCE). */
export async function checkAuthorizationRequest(
  db: Queryable,
  issuer: OAuthIssuer,
  params: URLSearchParams,
): Promise<AuthorizationCheck> {
  const clientId = params.get('client_id');
  const client = clientId && clientId.length <= 100 ? await getOAuthClient(db, clientId) : undefined;
  if (!client) return { outcome: 'refused', message: 'This app is not registered with the gateway.' };
  const redirectUri = params.get('redirect_uri');
  if (!redirectUri || !redirectUriRegistered(client.redirectUris, redirectUri)) {
    return { outcome: 'refused', message: 'This app asked to return to an address it did not register.' };
  }

  const state = params.get('state') ?? undefined;
  const fail = (error: string, description: string): AuthorizationCheck => ({
    outcome: 'redirect',
    redirectUrl: redirectTo(redirectUri, issuer, {
      error,
      error_description: description,
      state: state && state.length <= 1000 ? state : undefined,
    }),
  });
  if (state && state.length > 1000) return fail('invalid_request', 'state is longer than 1000 characters.');
  if (params.get('response_type') !== 'code')
    return fail('unsupported_response_type', 'Only response_type=code is supported.');
  const codeChallenge = params.get('code_challenge');
  if (
    params.get('code_challenge_method') !== 'S256' ||
    !codeChallenge ||
    !CODE_CHALLENGE_PATTERN.test(codeChallenge)
  )
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  if (!resourceAccepted(params.get('resource') ?? undefined, issuer))
    return fail('invalid_target', `The only resource is ${issuer.resource}.`);
  return { outcome: 'valid', request: { client, redirectUri, codeChallenge, state } };
}

/** The redirect that tells the client the member declined. */
export function deniedRedirect(issuer: OAuthIssuer, request: AuthorizationRequest): string {
  return redirectTo(request.redirectUri, issuer, {
    error: 'access_denied',
    error_description: 'The member did not allow access.',
    state: request.state,
  });
}

/** Records the member's approval as a one-time code and returns the redirect that carries it. */
export async function approveAuthorization(
  db: Queryable,
  issuer: OAuthIssuer,
  request: AuthorizationRequest,
  memberId: string,
): Promise<string> {
  const code = newToken();
  await db.query(
    `INSERT INTO oauth_codes (code_hash, client_id, member_id, redirect_uri, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6::int))`,
    [
      hashToken(code),
      request.client.id,
      memberId,
      request.redirectUri,
      request.codeChallenge,
      CODE_TTL_SECONDS,
    ],
  );
  return redirectTo(request.redirectUri, issuer, { code, state: request.state });
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

/** A code or refresh token the token endpoint refuses: `invalid_grant` in RFC 6749 section 5.2. */
export class InvalidGrantError extends Error {}

function newTokenPair() {
  const accessToken = `${ACCESS_TOKEN_PREFIX}${newToken()}`;
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${newToken()}`;
  return {
    response: {
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
    },
    params: [
      hashToken(accessToken),
      ACCESS_TOKEN_TTL_SECONDS,
      hashToken(refreshToken),
      REFRESH_TOKEN_TTL_DAYS,
    ],
  };
}

/**
 * Exchanges a one-time authorization code for a new grant's tokens. The code is deleted as it is read,
 * so a second exchange fails. Throws InvalidGrantError when the code, client, redirect URI or PKCE
 * verifier does not match, or the member was deactivated meanwhile.
 */
export async function exchangeAuthorizationCode(
  db: Queryable,
  input: { code: string; clientId: string; redirectUri: string; codeVerifier: string },
): Promise<{ tokens: TokenResponse; grantId: string; memberId: string }> {
  const [code] = await db.query<{
    clientId: string;
    memberId: string;
    redirectUri: string;
    codeChallenge: string;
    expired: boolean;
  }>(
    `DELETE FROM oauth_codes WHERE code_hash = $1 RETURNING client_id AS "clientId", member_id AS "memberId",
       redirect_uri AS "redirectUri", code_challenge AS "codeChallenge", expires_at < now() AS expired`,
    [hashToken(input.code)],
  );
  if (!code || code.expired || code.clientId !== input.clientId || code.redirectUri !== input.redirectUri) {
    throw new InvalidGrantError('The authorization code is invalid, used or expired.');
  }
  if (!pkceMatches(input.codeVerifier, code.codeChallenge)) {
    throw new InvalidGrantError('The code verifier does not match the code challenge.');
  }
  const pair = newTokenPair();
  const [grant] = await db.query<{ id: string }>(
    `INSERT INTO oauth_grants (client_id, member_id, access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at)
     SELECT $1, m.id, $3, now() + make_interval(secs => $4::int), $5, now() + make_interval(days => $6::int)
     FROM members m WHERE m.id = $2 AND m.active RETURNING id`,
    [code.clientId, code.memberId, ...pair.params],
  );
  if (!grant) throw new InvalidGrantError('The member who approved this app is deactivated.');
  return { tokens: pair.response, grantId: grant.id, memberId: code.memberId };
}

/**
 * Replaces a grant's tokens. The old refresh and access tokens stop working at once. Throws
 * InvalidGrantError for an unknown, expired or revoked refresh token, another client's, or one of a
 * deactivated member.
 */
export async function refreshOAuthGrant(
  db: Queryable,
  input: { refreshToken: string; clientId: string },
): Promise<{ tokens: TokenResponse; grantId: string; memberId: string }> {
  const pair = newTokenPair();
  const [grant] = await db.query<{ id: string; memberId: string }>(
    `UPDATE oauth_grants g SET access_token_hash = $3, access_expires_at = now() + make_interval(secs => $4::int),
       refresh_token_hash = $5, refresh_expires_at = now() + make_interval(days => $6::int)
     FROM members m
     WHERE g.refresh_token_hash = $1 AND g.client_id = $2 AND g.revoked_at IS NULL
       AND g.refresh_expires_at > now() AND m.id = g.member_id AND m.active
     RETURNING g.id, g.member_id AS "memberId"`,
    [hashToken(input.refreshToken), input.clientId, ...pair.params],
  );
  if (!grant) throw new InvalidGrantError('The refresh token is invalid, expired or revoked.');
  return { tokens: pair.response, grantId: grant.id, memberId: grant.memberId };
}

/** Whether a bearer token is shaped like one of the gateway's OAuth access tokens. */
export function isOAuthAccessToken(token: string): boolean {
  return token.startsWith(ACCESS_TOKEN_PREFIX);
}

/** How audit entries name a grant: stable across token refreshes, unlike the tokens themselves. */
function grantLabel(grantId: string): string {
  return `oauth:${grantId.slice(0, 8)}`;
}

export interface VerifiedAccessToken {
  member: Member;
  keyPrefix: string;
}

/** Why an OAuth access token was refused. memberId and keyPrefix are set when the token is known. */
export interface RejectedAccessToken {
  rejected: 'oauth_unknown' | 'oauth_expired' | 'oauth_revoked' | 'oauth_member_deactivated';
  memberId?: string;
  keyPrefix?: string;
}

/**
 * Looks up the member behind an access token, or says why it is refused. Read on every request, so
 * revoking a grant or deactivating its member applies to the next call.
 */
export async function verifyOAuthAccessToken(
  db: Queryable,
  token: string,
): Promise<VerifiedAccessToken | RejectedAccessToken> {
  const [row] = await db.query<Member & { grantId: string; revoked: boolean; expired: boolean }>(
    `SELECT g.id AS "grantId", g.revoked_at IS NOT NULL AS revoked, g.access_expires_at < now() AS expired,
       m.id, m.email, m.name, m.role, m.active
     FROM oauth_grants g JOIN members m ON m.id = g.member_id WHERE g.access_token_hash = $1`,
    [hashToken(token)],
  );
  if (!row) return { rejected: 'oauth_unknown' };
  const known = { memberId: row.id, keyPrefix: grantLabel(row.grantId) };
  if (row.revoked) return { rejected: 'oauth_revoked', ...known };
  if (!row.active) return { rejected: 'oauth_member_deactivated', ...known };
  if (row.expired) return { rejected: 'oauth_expired', ...known };
  await db.query(
    `UPDATE oauth_grants SET last_used_at = now()
     WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [row.grantId],
  );
  const { id, email, name, role, active } = row;
  return { member: { id, email, name, role, active }, keyPrefix: known.keyPrefix };
}

/** An app a member allowed to use the gateway as them. */
export interface OAuthGrant {
  id: string;
  memberId: string;
  clientName: string;
  /** What audit entries show in the key column for this grant's calls. */
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

const GRANT_COLUMNS = `g.id, g.member_id AS "memberId", c.name AS "clientName",
  g.created_at AS "createdAt", g.last_used_at AS "lastUsedAt", g.revoked_at AS "revokedAt"`;

/** Grants of one member, or of everyone when memberId is undefined, newest first. */
export async function listOAuthGrants(db: Queryable, memberId: string | undefined): Promise<OAuthGrant[]> {
  const grants = await db.query<Omit<OAuthGrant, 'label'>>(
    `SELECT ${GRANT_COLUMNS} FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
     WHERE $1::uuid IS NULL OR g.member_id = $1 ORDER BY g.created_at DESC`,
    [memberId ?? null],
  );
  return grants.map((grant) => ({ ...grant, label: grantLabel(grant.id) }));
}

export async function getOAuthGrant(db: Queryable, id: string): Promise<OAuthGrant | undefined> {
  const [grant] = await db.query<Omit<OAuthGrant, 'label'>>(
    `SELECT ${GRANT_COLUMNS} FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id WHERE g.id = $1`,
    [id],
  );
  return grant && { ...grant, label: grantLabel(grant.id) };
}

/** Revokes a grant: its access and refresh tokens are refused from the next request. */
export async function revokeOAuthGrant(db: Queryable, id: string): Promise<OAuthGrant | undefined> {
  await db.query('UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [id]);
  return getOAuthGrant(db, id);
}

const registrationBody = z
  .object({
    redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
    client_name: z.string().trim().min(1).max(100).optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
  })
  .loose();

const tokenForm = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1).max(200),
    redirect_uri: z.string().min(1).max(2000),
    client_id: z.string().min(1).max(100),
    code_verifier: z.string().min(1).max(200),
    resource: z.string().max(2000).optional(),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1).max(200),
    client_id: z.string().min(1).max(100),
    resource: z.string().max(2000).optional(),
  }),
]);

const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'];

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).set('cache-control', 'no-store').json({ error, error_description: description });
}

// The discovery documents and the registration and token endpoints are called by browser-based
// clients on other origins. They use no cookies, so allowing every origin exposes nothing.
function allowAnyOrigin(req: Request, res: Response, next: NextFunction): void {
  res.set({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version',
  });
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/**
 * The gateway's OAuth authorization server for MCP clients: discovery documents, open client
 * registration and the token endpoint. The authorization page itself is the dashboard's, under
 * /oauth/authorize, so the member approves with their dashboard session.
 */
export function createOAuthRouter(db: Queryable, issuer: OAuthIssuer): Router {
  const router = express.Router();
  router.use(['/.well-known', '/oauth/register', '/oauth/token'], allowAnyOrigin);

  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json(authorizationServerMetadata(issuer));
  });
  router.get(
    [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource/mcp/search',
    ],
    (_req, res) => {
      res.json(protectedResourceMetadata(issuer));
    },
  );

  router.post('/oauth/register', express.json({ limit: '16kb' }), async (req, res) => {
    const parsed = registrationBody.safeParse(req.body);
    if (!parsed.success)
      return oauthError(res, 400, 'invalid_client_metadata', z.prettifyError(parsed.error));
    const { redirect_uris: redirectUris, client_name: name, grant_types: grantTypes } = parsed.data;
    for (const uri of redirectUris) {
      const refusal = redirectUriRefusal(uri);
      if (refusal) return oauthError(res, 400, 'invalid_redirect_uri', `${uri.slice(0, 200)}: ${refusal}.`);
    }
    if (grantTypes && !grantTypes.every((type) => SUPPORTED_GRANT_TYPES.includes(type)))
      return oauthError(
        res,
        400,
        'invalid_client_metadata',
        'Only authorization_code and refresh_token are supported.',
      );
    if (parsed.data.response_types && !parsed.data.response_types.every((type) => type === 'code'))
      return oauthError(res, 400, 'invalid_client_metadata', 'Only the code response type is supported.');
    const client = await registerOAuthClient(db, { name: name ?? 'Unnamed app', redirectUris });
    console.log(JSON.stringify({ event: 'oauth_client_registered', client: client.id }));
    // Every client is public: it proves itself with PKCE, so it gets no secret.
    res.status(201).json({
      client_id: client.id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: SUPPORTED_GRANT_TYPES,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  router.post('/oauth/token', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    const grantType = (req.body as { grant_type?: unknown } | undefined)?.grant_type;
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token')
      return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
    const parsed = tokenForm.safeParse(req.body);
    if (!parsed.success) return oauthError(res, 400, 'invalid_request', z.prettifyError(parsed.error));
    const form = parsed.data;
    if (!resourceAccepted(form.resource, issuer))
      return oauthError(res, 400, 'invalid_target', `The only resource is ${issuer.resource}.`);
    try {
      const issued =
        form.grant_type === 'authorization_code'
          ? await exchangeAuthorizationCode(db, {
              code: form.code,
              clientId: form.client_id,
              redirectUri: form.redirect_uri,
              codeVerifier: form.code_verifier,
            })
          : await refreshOAuthGrant(db, { refreshToken: form.refresh_token, clientId: form.client_id });
      console.log(
        JSON.stringify({
          event: 'oauth_tokens_issued',
          grantType: form.grant_type,
          grant: grantLabel(issued.grantId),
          memberId: issued.memberId,
          client: form.client_id,
        }),
      );
      res.set('cache-control', 'no-store').json(issued.tokens);
    } catch (error) {
      if (!(error instanceof InvalidGrantError)) throw error;
      oauthError(res, 400, 'invalid_grant', error.message);
    }
  });
  return router;
}
