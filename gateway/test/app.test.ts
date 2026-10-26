import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApiKey } from '../src/apiKeys.js';
import { createApp } from '../src/app.js';
import type { AuditEntry } from '../src/audit.js';
import { chatFailureMessage } from '../src/chat.js';
import type { ChatEvent } from '../src/chat.js';
import type { Database } from '../src/db.js';
import { createGatewayMcpHandler } from '../src/mcpEndpoint.js';
import { UpstreamRegistry } from '../src/registry.js';
import { changeMember, createMember, ensureFirstAdmin, hashPassword, verifyPassword } from '../src/team.js';
import type { Member, Role } from '../src/team.js';
import { listStoreTasks, markStoreFailed, markStoreReady } from '../src/stores.js';
import type { StoreTask } from '../src/stores.js';
import { startMetricsServer } from '../src/metrics.js';
import { upstreamUrlRefusal } from '../src/upstreamNetwork.js';
import { listUpstreamConfigs } from '../src/upstreams.js';
import type { Upstream } from '../src/upstreams.js';
import { createTestDatabase } from './database.js';
import { startFakeClaude } from './fakeClaude.js';
import { eventually, onCleanup, runCleanups, startUpstream, text } from './fakeUpstreams.js';
import type { FakeUpstream } from './fakeUpstreams.js';

const ADMIN = { email: 'admin@example.com', password: 'admin-password-123' };
const PASSWORD = 'member-password-123';

let db: Database;
let dashboardDir: string;
let emailCounter = 0;
let upstreamCounter = 0;

/** A database of its own with the first admin, for tests whose gateway syncs every upstream row. */
async function isolatedDatabase(): Promise<Database> {
  const isolated = await createTestDatabase();
  await ensureFirstAdmin(isolated, ADMIN);
  onCleanup(() => isolated.close());
  return isolated;
}

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFirstAdmin(db, ADMIN);
  dashboardDir = await mkdtemp(join(tmpdir(), 'dashboard-'));
  await mkdir(join(dashboardDir, 'assets'));
  await writeFile(join(dashboardDir, 'index.html'), '<!doctype html><title>Dashboard</title>');
  await writeFile(join(dashboardDir, 'assets', 'index-abc123.js'), 'console.log(1);');
});

afterAll(async () => {
  await db.close();
  await rm(dashboardDir, { recursive: true });
});

afterEach(runCleanups);

interface Gateway {
  url: string;
  upstream: FakeUpstream;
}

// For gateways whose test does not chat: any call to it fails to connect.
const unusedAnthropic = new Anthropic({ apiKey: 'unused', baseURL: 'http://127.0.0.1:9', maxRetries: 0 });

/**
 * Starts the gateway's HTTP app on a free port, with one upstream named WooCommerce. With the shared
 * database, the gateway starts out seeing only its own upstream row.
 */
// Fake upstreams listen on loopback, which the real guard always refuses. Its own tests cover it.
const allowEveryUrl = async (): Promise<undefined> => undefined;

async function startGateway(
  database: Database = db,
  anthropic: Anthropic = unusedAnthropic,
  checkUpstreamUrl: (url: string) => Promise<string | undefined> = allowEveryUrl,
): Promise<Gateway> {
  const upstream = await startUpstream(['list_orders', 'fail', 'sleep']);
  upstreamCounter += 1;
  const [{ id }] = (await database.query<{ id: string }>(
    `INSERT INTO upstreams (slug, name, url, auth_type) VALUES ($1, 'WooCommerce', $2, 'none') RETURNING id`,
    [`woo${upstreamCounter}`, upstream.url],
  )) as [{ id: string }];
  const registry = new UpstreamRegistry({ connectMs: 500, listMs: 500, callMs: 300 });
  await registry.sync((await listUpstreamConfigs(database)).filter((config) => config.id === id));
  const mcpHandler = createGatewayMcpHandler({ db: database, registry });
  const app = createApp({
    db: database,
    registry,
    mcpHandler,
    anthropic,
    publicUrl: new URL('http://app.localtest.me'),
    stores: { domain: 'localtest.me', maxPerMember: 2 },
    checkUpstreamUrl,
    dashboardDir,
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  onCleanup(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await mcpHandler.close();
    await registry.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, upstream };
}

/** A browser with a cookie jar that talks to /api the way the dashboard does. */
class Browser {
  private cookie = '';

  constructor(private readonly gateway: Gateway) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = { 'x-requested-with': 'urumi-dashboard' },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const { status, text } = await this.requestText(method, path, body, headers);
    return { status, body: text ? JSON.parse(text) : {} };
  }

  async requestText(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = { 'x-requested-with': 'urumi-dashboard' },
    signal?: AbortSignal,
  ): Promise<{ status: number; text: string }> {
    const response = await fetch(`${this.gateway.url}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: this.cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    return { status: response.status, text: await response.text() };
  }

  /** Sends one chat message and returns the events the gateway streamed back. */
  async chat(question: string, signal?: AbortSignal): Promise<ChatEvent[]> {
    const { status, text } = await this.requestText(
      'POST',
      '/chat',
      { messages: [{ role: 'user', text: question }] },
      undefined,
      signal,
    );
    expect(status).toBe(200);
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChatEvent);
  }

  async login(email: string, password: string): Promise<this> {
    const { status } = await this.request('POST', '/login', { email, password });
    expect(status).toBe(200);
    return this;
  }
}

async function newMember(role: Role = 'member', database: Database = db): Promise<Member> {
  emailCounter += 1;
  const member = await createMember(database, {
    email: `person${emailCounter}@example.com`,
    name: `Person ${emailCounter}`,
    role,
    password: PASSWORD,
  });
  return member!;
}

async function adminBrowser(gateway: Gateway): Promise<Browser> {
  return new Browser(gateway).login(ADMIN.email, ADMIN.password);
}

async function mcpClient(gateway: Gateway, key: string | undefined): Promise<Client> {
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`), {
      requestInit: { headers: key ? { authorization: `Bearer ${key}` } : {} },
    }),
  );
  onCleanup(() => client.close());
  return client;
}

async function newKey(database: Database, member: Member): Promise<string> {
  const { key } = await createApiKey(database, { memberId: member.id, name: 'cli', createdBy: member.id });
  return key;
}

async function auditEntries(gateway: Gateway): Promise<AuditEntry[]> {
  const { body } = await (await adminBrowser(gateway)).request('GET', '/audit?limit=200');
  return body.entries as AuditEntry[];
}

describe('passwords', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse battery!', hash)).toBe(false);
  });
});

describe('dashboard sign-in', () => {
  it('signs in with email and password, and signs out', async () => {
    const gateway = await startGateway();
    const browser = new Browser(gateway);

    expect((await browser.request('GET', '/me')).status).toBe(401);
    expect((await browser.request('POST', '/login', { email: ADMIN.email, password: 'wrong' })).status).toBe(
      401,
    );
    await browser.login(ADMIN.email.toUpperCase(), ADMIN.password);
    expect((await browser.request('GET', '/me')).body.member).toMatchObject({
      email: ADMIN.email,
      role: 'admin',
    });

    expect((await browser.request('POST', '/logout')).status).toBe(204);
    expect((await browser.request('GET', '/me')).status).toBe(401);
  });

  it('refuses state-changing requests without the X-Requested-With header', async () => {
    const gateway = await startGateway();
    const browser = new Browser(gateway);
    const response = await browser.request('POST', '/login', ADMIN, {});
    expect(response.status).toBe(403);
  });

  it('refuses sign-in to a deactivated member', async () => {
    const gateway = await startGateway();
    const member = await newMember();
    await (await adminBrowser(gateway)).request('PATCH', `/members/${member.id}`, { active: false });
    const response = await new Browser(gateway).request('POST', '/login', {
      email: member.email,
      password: PASSWORD,
    });
    expect(response.status).toBe(401);
  });
});

describe('invites', () => {
  it('turns a one-time invite link into a signed-in member with the invited role', async () => {
    const gateway = await startGateway();
    const admin = await adminBrowser(gateway);
    const created = await admin.request('POST', '/invites', {
      email: 'New.Person@example.com',
      role: 'member',
    });
    expect(created.status).toBe(201);
    const inviteUrl = new URL(created.body.inviteUrl as string);
    expect(inviteUrl.origin + inviteUrl.pathname).toBe('http://app.localtest.me/invite');
    const token = inviteUrl.hash.slice(1);

    const invitee = new Browser(gateway);
    expect((await invitee.request('POST', '/invites/preview', { token })).body).toEqual({
      email: 'new.person@example.com',
      role: 'member',
    });
    const accepted = await invitee.request('POST', '/invites/accept', {
      token,
      name: 'New Person',
      password: PASSWORD,
    });
    expect(accepted.status).toBe(201);
    expect((await invitee.request('GET', '/me')).body.member).toMatchObject({
      email: 'new.person@example.com',
      role: 'member',
    });

    const again = await new Browser(gateway).request('POST', '/invites/accept', {
      token,
      name: 'Someone Else',
      password: PASSWORD,
    });
    expect(again.status).toBe(404);
  });

  it('rejects an expired invite', async () => {
    const gateway = await startGateway();
    const admin = await adminBrowser(gateway);
    const created = await admin.request('POST', '/invites', { email: 'late@example.com', role: 'member' });
    await db.query(
      `UPDATE invites SET expires_at = now() - interval '1 second' WHERE email = 'late@example.com'`,
    );
    const token = new URL(created.body.inviteUrl as string).hash.slice(1);
    const response = await new Browser(gateway).request('POST', '/invites/accept', {
      token,
      name: 'Late',
      password: PASSWORD,
    });
    expect(response.status).toBe(404);
  });
});

describe('roles', () => {
  it('keeps members out of admin actions', async () => {
    const gateway = await startGateway();
    const member = await newMember();
    const other = await newMember();
    const browser = await new Browser(gateway).login(member.email, PASSWORD);

    expect((await browser.request('GET', '/members')).status).toBe(403);
    expect(
      (await browser.request('POST', '/invites', { email: 'x@example.com', role: 'admin' })).status,
    ).toBe(403);
    expect((await browser.request('PATCH', `/members/${other.id}`, { role: 'admin' })).status).toBe(403);
    expect((await browser.request('PATCH', `/members/${member.id}`, { role: 'admin' })).status).toBe(403);
  });

  it('lets admins change roles but not demote themselves', async () => {
    const gateway = await startGateway();
    const member = await newMember();
    const admin = await adminBrowser(gateway);
    const me = (await admin.request('GET', '/me')).body.member as Member;

    expect(
      (await admin.request('PATCH', `/members/${member.id}`, { role: 'admin' })).body.member,
    ).toMatchObject({
      role: 'admin',
    });
    expect((await admin.request('PATCH', `/members/${me.id}`, { role: 'member' })).status).toBe(403);
  });

  it('checks the acting admin when the change is made, not when the request started', async () => {
    const isolated = await isolatedDatabase();
    const first = await newMember('admin', isolated);
    const second = await newMember('admin', isolated);
    // The second admin's request was signed in as an admin, but the first admin's change committed first.
    expect(await changeMember(isolated, first.id, second.id, { role: 'member' })).toMatchObject({
      role: 'member',
    });

    expect(await changeMember(isolated, second.id, first.id, { role: 'member' })).toBe(
      'Only admins can change members.',
    );
    expect(await changeMember(isolated, first.id, randomUUID(), { role: 'member' })).toBeUndefined();
  });
});

describe('API keys', () => {
  it('shows a new key once and stores only its hash', async () => {
    const gateway = await startGateway();
    const member = await newMember();
    const browser = await new Browser(gateway).login(member.email, PASSWORD);

    const created = await browser.request('POST', '/keys', { name: 'laptop' });
    const key = created.body.key as string;
    expect(created.status).toBe(201);
    expect(key).toMatch(/^urk_[A-Za-z0-9_-]{43}$/);
    expect(created.body.apiKey).toMatchObject({ name: 'laptop', displayPrefix: key.slice(4, 12) });

    const rows = await db.query<Record<string, unknown>>('SELECT * FROM api_keys WHERE member_id = $1', [
      member.id,
    ]);
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(JSON.stringify(rows)).not.toContain(key.slice(12));

    const listed = await browser.request('GET', '/keys');
    expect(JSON.stringify(listed.body)).not.toContain(key);
  });

  it('lets members manage only their own keys and admins anyone’s', async () => {
    const gateway = await startGateway();
    const member = await newMember();
    const other = await newMember();
    const { apiKey: othersKey } = await createApiKey(db, {
      memberId: other.id,
      name: 'other',
      createdBy: other.id,
    });
    const browser = await new Browser(gateway).login(member.email, PASSWORD);

    expect((await browser.request('DELETE', `/keys/${othersKey.id}`)).status).toBe(403);
    expect((await browser.request('POST', '/keys', { name: 'for other', memberId: other.id })).status).toBe(
      403,
    );
    expect((await browser.request('GET', `/keys?memberId=${other.id}`)).status).toBe(403);
    expect((await browser.request('GET', '/keys?memberId=all')).status).toBe(403);

    const admin = await adminBrowser(gateway);
    const issued = await admin.request('POST', '/keys', { name: 'issued by admin', memberId: member.id });
    expect(issued.status).toBe(201);
    expect(issued.body.apiKey).toMatchObject({ memberId: member.id });
    const revoked = await admin.request('DELETE', `/keys/${othersKey.id}`);
    expect(revoked.body.apiKey).toMatchObject({ id: othersKey.id });
    expect((revoked.body.apiKey as { revokedAt: string | null }).revokedAt).not.toBeNull();
  });
});

describe('MCP endpoint with API keys', () => {
  it('calls tools as the key’s member and audits the call', async () => {
    const gateway = await startGateway();
    const member = await newMember();
    const { key, apiKey } = await createApiKey(db, {
      memberId: member.id,
      name: 'cli',
      createdBy: member.id,
    });
    const client = await mcpClient(gateway, key);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['fail', 'list_orders', 'sleep']);
    expect(text(await client.callTool({ name: 'list_orders', arguments: {} }))).toBe('list_orders done');

    const [entry] = (await auditEntries(gateway)).filter((e) => e.memberId === member.id);
    expect(entry).toMatchObject({
      memberEmail: member.email,
      keyPrefix: apiKey.displayPrefix,
      via: 'mcp',
      upstreamName: 'WooCommerce',
      tool: 'list_orders',
      outcome: 'succeeded',
      reason: null,
    });
    expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('never forwards the client’s API key to the upstream', async () => {
    const gateway = await startGateway();
    const member = await newMember();
    const { key } = await createApiKey(db, { memberId: member.id, name: 'cli', createdBy: member.id });
    const client = await mcpClient(gateway, key);

    await client.callTool({ name: 'list_orders', arguments: {} });
    expect(gateway.upstream.calls).toEqual([{ tool: 'list_orders', args: {}, authorization: undefined }]);
  });

  it('rejects a revoked key on the next call and audits the rejection', async () => {
    const gateway = await startGateway();
    const member = await newMember();
    const browser = await new Browser(gateway).login(member.email, PASSWORD);
    const created = await browser.request('POST', '/keys', { name: 'cli' });
    const key = created.body.key as string;
    const keyId = (created.body.apiKey as { id: string }).id;
    const client = await mcpClient(gateway, key);
    expect(text(await client.callTool({ name: 'list_orders', arguments: {} }))).toBe('list_orders done');

    expect((await browser.request('DELETE', `/keys/${keyId}`)).status).toBe(200);

    await expect(client.callTool({ name: 'list_orders', arguments: {} })).rejects.toMatchObject({
      status: 401,
    });
    expect(gateway.upstream.calls).toHaveLength(1);
    const rejected = (await auditEntries(gateway)).find(
      (entry) => entry.keyPrefix === key.slice(4, 12) && entry.outcome === 'rejected',
    );
    expect(rejected).toMatchObject({
      memberId: member.id,
      memberEmail: member.email,
      via: 'mcp',
      tool: 'list_orders',
      reason: 'Revoked API key (tools/call).',
    });
  });

  it('rejects requests without a key, with an unknown key, and with a deactivated member’s key', async () => {
    const gateway = await startGateway();
    const member = await newMember();
    const { key } = await createApiKey(db, { memberId: member.id, name: 'cli', createdBy: member.id });
    await (await adminBrowser(gateway)).request('PATCH', `/members/${member.id}`, { active: false });

    const unknownKey = `urk_${'A'.repeat(43)}`;
    await expect(mcpClient(gateway, undefined)).rejects.toThrow(/401/);
    await expect(mcpClient(gateway, unknownKey)).rejects.toThrow(/401/);
    await expect(mcpClient(gateway, key)).rejects.toThrow(/401/);
    expect(gateway.upstream.calls).toEqual([]);

    const entries = await auditEntries(gateway);
    expect(entries.find((entry) => entry.keyPrefix === unknownKey.slice(4, 12))).toMatchObject({
      memberId: null,
      outcome: 'rejected',
      reason: expect.stringMatching(/^Unknown API key \(/),
    });
    expect(entries.find((entry) => entry.keyPrefix === key.slice(4, 12))).toMatchObject({
      memberId: member.id,
      outcome: 'rejected',
      reason: expect.stringMatching(/^API key of a deactivated member \(/),
    });
  });

  it('audits failed, timed-out and unknown-tool calls with their reason', async () => {
    const gateway = await startGateway();
    const member = await newMember();
    const { key } = await createApiKey(db, { memberId: member.id, name: 'cli', createdBy: member.id });
    const client = await mcpClient(gateway, key);

    await client.callTool({ name: 'fail', arguments: {} });
    const timedOut = await client.callTool({ name: 'sleep', arguments: { ms: 2000 } });
    expect(text(timedOut)).toBe('Upstream "WooCommerce" did not respond within 0.3 s.');
    await client.callTool({ name: 'no_such_tool', arguments: {} });

    const entries = (await auditEntries(gateway)).filter((entry) => entry.memberId === member.id).reverse();
    expect(entries.map(({ tool, outcome, upstreamName }) => ({ tool, outcome, upstreamName }))).toEqual([
      { tool: 'fail', outcome: 'failed', upstreamName: 'WooCommerce' },
      { tool: 'sleep', outcome: 'timed_out', upstreamName: 'WooCommerce' },
      { tool: 'no_such_tool', outcome: 'rejected', upstreamName: null },
    ]);
    expect(entries[1]?.reason).toBe('Upstream "WooCommerce" did not respond within 0.3 s.');
    expect(entries[1]?.durationMs).toBeGreaterThanOrEqual(300);
  });

  it('audits calls whose tool name contains a NUL character, with a valid key or without', async () => {
    const gateway = await startGateway();
    const member = await newMember();
    const client = await mcpClient(gateway, await newKey(db, member));

    const result = await client.callTool({ name: 'list_orders\u0000', arguments: {} });
    expect(result.isError).toBe(true);
    const unknownKey = `urk_${'B'.repeat(43)}`;
    const rejected = await fetch(`${gateway.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${unknownKey}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x\u0000' } }),
    });
    expect(rejected.status).toBe(401);

    const entries = await auditEntries(gateway);
    expect(entries.find((entry) => entry.memberId === member.id)).toMatchObject({
      tool: 'list_orders\uFFFD',
      outcome: 'rejected',
    });
    expect(entries.find((entry) => entry.keyPrefix === unknownKey.slice(4, 12))).toMatchObject({
      tool: 'x\uFFFD',
      outcome: 'rejected',
    });
  });

  it('shows members only their own audit entries', async () => {
    const gateway = await startGateway();
    const member = await newMember();
    const { key } = await createApiKey(db, { memberId: member.id, name: 'cli', createdBy: member.id });
    await (await mcpClient(gateway, key)).callTool({ name: 'list_orders', arguments: {} });
    const other = await newMember();
    const { key: otherKey } = await createApiKey(db, {
      memberId: other.id,
      name: 'cli',
      createdBy: other.id,
    });
    await (await mcpClient(gateway, otherKey)).callTool({ name: 'list_orders', arguments: {} });

    const browser = await new Browser(gateway).login(member.email, PASSWORD);
    const entries = (await browser.request('GET', '/audit')).body.entries as AuditEntry[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.memberId === member.id)).toBe(true);
  });
});

describe('upstream servers', () => {
  const NOTES_TOKEN = 'notes-secret-token';
  // The gateway syncs every upstream row after a change, so each test needs a database of its own.
  let isolated: Database;
  beforeEach(async () => {
    isolated = await isolatedDatabase();
  });

  it('lets admins add a server with a credential and shows its status and tools right away', async () => {
    const gateway = await startGateway(isolated);
    const notes = await startUpstream(['save_note', 'list_orders'], { token: NOTES_TOKEN });
    onCleanup(() => notes.close());
    const admin = await adminBrowser(gateway);

    const created = await admin.request('POST', '/upstreams', {
      name: 'Notes',
      url: notes.url,
      auth: { type: 'bearer', secret: NOTES_TOKEN },
    });
    expect(created.status).toBe(201);
    expect(created.body.upstream).toMatchObject({
      slug: 'notes',
      name: 'Notes',
      authType: 'bearer',
      status: 'connected',
      error: null,
    });
    const tools = (created.body.upstream as { tools: { name: string; originalName: string }[] }).tools;
    expect(tools).toEqual([
      expect.objectContaining({ name: 'notes__list_orders', originalName: 'list_orders' }),
      expect.objectContaining({ name: 'save_note', originalName: 'save_note' }),
    ]);
    const listed = await admin.request('GET', '/upstreams');
    expect(JSON.stringify([created.body, listed.body])).not.toContain(NOTES_TOKEN);

    const client = await mcpClient(gateway, await newKey(isolated, await newMember('member', isolated)));
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'fail',
      'notes__list_orders',
      'save_note',
      'sleep',
      expect.stringMatching(/^woo\d+__list_orders$/),
    ]);
    expect(text(await client.callTool({ name: 'save_note', arguments: {} }))).toBe('save_note done');
    expect(notes.calls[0]?.authorization).toBe(`Bearer ${NOTES_TOKEN}`);
  });

  it('shows members servers and tools without URLs or credentials, and keeps them from changes', async () => {
    const gateway = await startGateway(isolated);
    const member = await newMember('member', isolated);
    const browser = await new Browser(gateway).login(member.email, PASSWORD);

    const { body } = await browser.request('GET', '/upstreams');
    const [upstream] = body.upstreams as Record<string, unknown>[];
    expect(Object.keys(upstream!).sort()).toEqual([
      'checkedAt',
      'enabled',
      'error',
      'id',
      'name',
      'slug',
      'status',
      'storeId',
      'tools',
    ]);
    expect((await browser.request('POST', '/upstreams', { name: 'X', url: 'http://x' })).status).toBe(403);
    expect((await browser.request('PATCH', `/upstreams/${upstream!.id}`, { enabled: false })).status).toBe(
      403,
    );
    expect((await browser.request('DELETE', `/upstreams/${upstream!.id}`)).status).toBe(403);
  });

  it('refuses upstream URLs that point at metadata endpoints or private addresses', async () => {
    const policy = { internalHosts: ['notes-mcp'] };
    const gateway = await startGateway(isolated, unusedAnthropic, (url) => upstreamUrlRefusal(url, policy));
    const admin = await adminBrowser(gateway);

    const metadata = await admin.request('POST', '/upstreams', {
      name: 'M',
      url: 'http://169.254.169.254/mcp',
    });
    expect(metadata.status).toBe(400);
    expect(metadata.body.error).toMatch(
      /^This URL cannot be used: the address is loopback, link-local or a cloud metadata endpoint/,
    );
    const privateAddress = await admin.request('POST', '/upstreams', {
      name: 'P',
      url: 'http://10.43.0.1/mcp',
    });
    expect(privateAddress.body.error).toMatch(/private or cluster-internal address/);
    const [upstream] = (await admin.request('GET', '/upstreams')).body.upstreams as { id: string }[];
    const moved = await admin.request('PATCH', `/upstreams/${upstream!.id}`, {
      url: 'http://[::ffff:127.0.0.1]/mcp',
    });
    expect(moved.status).toBe(400);
  });

  it('gives admins calls, errors and latency per server from the audit log', async () => {
    const gateway = await startGateway(isolated);
    const member = await newMember('member', isolated);
    const client = await mcpClient(gateway, await newKey(isolated, member));
    await client.callTool({ name: 'list_orders', arguments: {} });
    await client.callTool({ name: 'list_orders', arguments: {} });
    await client.callTool({ name: 'fail', arguments: {} });
    await client.callTool({ name: 'sleep', arguments: { ms: 1000 } });

    const [upstream] = (await (await adminBrowser(gateway)).request('GET', '/upstreams')).body.upstreams as {
      stats: Record<string, unknown>;
    }[];
    expect(upstream!.stats).toMatchObject({ calls: 4, errors: 2, timedOut: 1, rejected: 0 });
    expect(upstream!.stats.p95Ms).toBeGreaterThanOrEqual(250);
    const asMember = await new Browser(gateway).login(member.email, PASSWORD);
    expect((await asMember.request('GET', '/upstreams')).body.upstreams).toEqual([
      expect.not.objectContaining({ stats: expect.anything() }),
    ]);
  });

  it('counts tool calls per upstream and outcome on the metrics port', async () => {
    const gateway = await startGateway(isolated);
    const [{ slug }] = (await isolated.query<{ slug: string }>('SELECT slug FROM upstreams')) as [
      { slug: string },
    ];
    const client = await mcpClient(gateway, await newKey(isolated, await newMember('member', isolated)));
    await client.callTool({ name: 'list_orders', arguments: {} });
    await client.callTool({ name: 'fail', arguments: {} });
    const metricsServer = startMetricsServer(0);
    onCleanup(() => new Promise<void>((resolve) => metricsServer.close(() => resolve())));
    await new Promise((resolve) => metricsServer.once('listening', resolve));

    const port = (metricsServer.address() as AddressInfo).port;
    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(metrics).toContain(`gateway_tool_calls_total{upstream="${slug}",outcome="succeeded",via="mcp"} 1`);
    expect(metrics).toContain(`gateway_tool_calls_total{upstream="${slug}",outcome="failed",via="mcp"} 1`);
    expect(metrics).toContain(`gateway_tool_call_duration_seconds_count{upstream="${slug}"} 2`);
  });

  it('keeps the stored secret on edits but requires it again when the URL changes', async () => {
    const gateway = await startGateway(isolated);
    const notes = await startUpstream(['save_note'], { token: NOTES_TOKEN });
    onCleanup(() => notes.close());
    const admin = await adminBrowser(gateway);
    const created = await admin.request('POST', '/upstreams', {
      name: 'Notes',
      url: notes.url,
      auth: { type: 'bearer', secret: NOTES_TOKEN },
    });
    const id = (created.body.upstream as { id: string }).id;

    const renamed = await admin.request('PATCH', `/upstreams/${id}`, { name: 'Team notes' });
    expect(renamed.body.upstream).toMatchObject({
      name: 'Team notes',
      authType: 'bearer',
      status: 'connected',
    });

    const moved = await admin.request('PATCH', `/upstreams/${id}`, { url: `${notes.url}?v=2` });
    expect(moved.status).toBe(400);
    const movedWithSecret = await admin.request('PATCH', `/upstreams/${id}`, {
      url: `${notes.url}?v=2`,
      auth: { type: 'bearer', secret: NOTES_TOKEN },
    });
    expect(movedWithSecret.body.upstream).toMatchObject({ status: 'connected' });
  });

  it('hides a disabled server’s tools from MCP clients and brings them back when enabled', async () => {
    const gateway = await startGateway(isolated);
    const admin = await adminBrowser(gateway);
    const [upstream] = (await admin.request('GET', '/upstreams')).body.upstreams as { id: string }[];
    const client = await mcpClient(gateway, await newKey(isolated, await newMember('member', isolated)));

    const disabled = await admin.request('PATCH', `/upstreams/${upstream!.id}`, { enabled: false });
    expect(disabled.body.upstream).toMatchObject({ enabled: false, status: 'disabled', tools: [] });
    expect((await client.listTools()).tools).toEqual([]);
    expect(text(await client.callTool({ name: 'list_orders', arguments: {} }))).toMatch(/^Unknown tool/);

    await admin.request('PATCH', `/upstreams/${upstream!.id}`, { enabled: true });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'fail',
      'list_orders',
      'sleep',
    ]);
  });

  it('removes a server and keeps its audit entries readable', async () => {
    const gateway = await startGateway(isolated);
    const admin = await adminBrowser(gateway);
    const [upstream] = (await admin.request('GET', '/upstreams')).body.upstreams as { id: string }[];
    const member = await newMember('member', isolated);
    await (
      await mcpClient(gateway, await newKey(isolated, member))
    ).callTool({ name: 'list_orders', arguments: {} });

    expect((await admin.request('DELETE', `/upstreams/${upstream!.id}`)).status).toBe(204);
    expect((await admin.request('GET', '/upstreams')).body.upstreams).toEqual([]);
    const [entry] = (await auditEntries(gateway)).filter((e) => e.memberId === member.id);
    expect(entry).toMatchObject({ upstreamName: 'WooCommerce', tool: 'list_orders', outcome: 'succeeded' });
  });

  it('audits a call that is still running when its server is removed', async () => {
    const gateway = await startGateway(isolated);
    const admin = await adminBrowser(gateway);
    const [upstream] = (await admin.request('GET', '/upstreams')).body.upstreams as { id: string }[];
    const member = await newMember('member', isolated);
    const client = await mcpClient(gateway, await newKey(isolated, member));

    const running = client.callTool({ name: 'sleep', arguments: { ms: 200 } });
    await eventually(() => expect(gateway.upstream.calls).toHaveLength(1));
    expect((await admin.request('DELETE', `/upstreams/${upstream!.id}`)).status).toBe(204);

    expect((await running).isError).toBe(true);
    const [entry] = (await auditEntries(gateway)).filter((e) => e.memberId === member.id);
    expect(entry).toMatchObject({ upstreamName: 'WooCommerce', tool: 'sleep', outcome: 'failed' });
  });

  it('rejects credentials in URLs, reserved header names, multi-line secrets and taken slugs', async () => {
    const gateway = await startGateway(isolated);
    const admin = await adminBrowser(gateway);
    const add = (body: unknown) => admin.request('POST', '/upstreams', body);

    expect((await add({ name: 'A', url: 'http://user:pass@notes:3000/mcp' })).status).toBe(400);
    expect((await add({ name: 'A', url: 'file:///etc/passwd' })).status).toBe(400);
    const reserved = { type: 'header', headerName: 'Content-Type', secret: 'x' };
    expect((await add({ name: 'A', url: 'http://notes/mcp', auth: reserved })).status).toBe(400);
    const multiLine = { type: 'bearer', secret: 'abc\r\nX-Injected: 1' };
    expect((await add({ name: 'A', url: 'http://notes/mcp', auth: multiLine })).status).toBe(400);
    expect((await add({ name: 'A', url: 'http://notes/mcp', auth: { type: 'bearer' } })).status).toBe(400);
    const [existing] = (await admin.request('GET', '/upstreams')).body.upstreams as { slug: string }[];
    expect((await add({ name: 'Copy', slug: existing!.slug, url: 'http://notes/mcp' })).status).toBe(409);
  });
});

describe('tool permissions', () => {
  let isolated: Database;
  beforeEach(async () => {
    isolated = await isolatedDatabase();
  });

  async function restrict(gateway: Gateway, access: { adminOnly: boolean; adminOnlyTools: string[] }) {
    const admin = await adminBrowser(gateway);
    const [upstream] = (await admin.request('GET', '/upstreams')).body.upstreams as { id: string }[];
    const response = await admin.request('PUT', `/upstreams/${upstream!.id}/access`, access);
    expect(response.status).toBe(200);
    return response.body.upstream as { adminOnly: boolean; tools: { name: string; adminOnly: boolean }[] };
  }

  it('hides an admin-only tool from members, rejects and audits a direct call, and keeps it for admins', async () => {
    const gateway = await startGateway(isolated);
    const updated = await restrict(gateway, { adminOnly: false, adminOnlyTools: ['fail'] });
    expect(updated.tools).toContainEqual(expect.objectContaining({ name: 'fail', adminOnly: true }));
    const member = await newMember('member', isolated);
    const memberClient = await mcpClient(gateway, await newKey(isolated, member));
    const adminClient = await mcpClient(gateway, await newKey(isolated, await newMember('admin', isolated)));

    expect((await memberClient.listTools()).tools.map((tool) => tool.name)).toEqual(['list_orders', 'sleep']);
    const rejected = await memberClient.callTool({ name: 'fail', arguments: {} });
    expect(rejected.isError).toBe(true);
    expect(text(rejected)).toBe('Only admins may call this tool.');
    expect(gateway.upstream.calls).toEqual([]);
    const [entry] = (await auditEntries(gateway)).filter((e) => e.memberId === member.id);
    expect(entry).toMatchObject({
      tool: 'fail',
      outcome: 'rejected',
      reason: 'Only admins may call this tool.',
    });
    expect(entry?.upstreamName).toBe('WooCommerce');

    expect((await adminClient.listTools()).tools.map((tool) => tool.name)).toEqual([
      'fail',
      'list_orders',
      'sleep',
    ]);
    expect((await adminClient.callTool({ name: 'fail', arguments: {} })).isError).toBe(true);
    expect(gateway.upstream.calls.map((call) => call.tool)).toEqual(['fail']);

    const memberView = (
      await (await new Browser(gateway).login(member.email, PASSWORD)).request('GET', '/upstreams')
    ).body.upstreams as { tools: { name: string }[] }[];
    expect(memberView[0]!.tools.map((tool) => tool.name)).toEqual(['list_orders', 'sleep']);
    expect(memberView[0]).not.toHaveProperty('adminOnly');
  });

  it('hides an admin-only server from members on the Servers page and in tools/list', async () => {
    const gateway = await startGateway(isolated);
    await restrict(gateway, { adminOnly: true, adminOnlyTools: [] });
    const member = await newMember('member', isolated);
    const client = await mcpClient(gateway, await newKey(isolated, member));

    expect((await client.listTools()).tools).toEqual([]);
    expect(text(await client.callTool({ name: 'list_orders', arguments: {} }))).toBe(
      'Only admins may call this tool.',
    );
    const browser = await new Browser(gateway).login(member.email, PASSWORD);
    expect((await browser.request('GET', '/upstreams')).body.upstreams).toEqual([]);

    await restrict(gateway, { adminOnly: false, adminOnlyTools: [] });
    expect((await client.listTools()).tools).toHaveLength(3);
  });

  it('only lets admins change permissions', async () => {
    const gateway = await startGateway(isolated);
    const [{ id }] = (await isolated.query<{ id: string }>('SELECT id FROM upstreams')) as [{ id: string }];
    const member = await newMember('member', isolated);
    const browser = await new Browser(gateway).login(member.email, PASSWORD);
    const body = { adminOnly: false, adminOnlyTools: [] };
    expect((await browser.request('PUT', `/upstreams/${id}/access`, body)).status).toBe(403);
  });
});

describe('stores', () => {
  let isolated: Database;
  beforeEach(async () => {
    isolated = await isolatedDatabase();
  });

  it('records a store for the provisioner, and returns the same store when the create is retried', async () => {
    const gateway = await startGateway(isolated);
    const member = await newMember('member', isolated);
    const browser = await new Browser(gateway).login(member.email, PASSWORD);

    const created = await browser.request('POST', '/stores', { name: 'Delhi Shop' });
    expect(created.status).toBe(201);
    expect(created.body.store).toMatchObject({
      slug: 'delhi-shop',
      name: 'Delhi Shop',
      url: 'http://store-delhi-shop.localtest.me',
      ownerId: member.id,
      ownerName: member.name,
      status: 'provisioning',
      reason: null,
    });
    const retried = await browser.request('POST', '/stores', { name: 'Delhi Shop' });
    expect(retried.status).toBe(200);
    expect(retried.body.store).toEqual(created.body.store);
    expect(await listStoreTasks(isolated)).toHaveLength(1);
  });

  it('refuses a name another member or a server uses, and more stores than the limit', async () => {
    const gateway = await startGateway(isolated);
    const [first, second] = [await newMember('member', isolated), await newMember('member', isolated)];
    const a = await new Browser(gateway).login(first.email, PASSWORD);
    const b = await new Browser(gateway).login(second.email, PASSWORD);

    expect((await a.request('POST', '/stores', { name: 'Pune' })).status).toBe(201);
    expect((await b.request('POST', '/stores', { name: 'pune' })).status).toBe(409);
    const [{ slug: serverSlug }] = (await isolated.query<{ slug: string }>('SELECT slug FROM upstreams')) as [
      { slug: string },
    ];
    expect((await b.request('POST', '/stores', { name: serverSlug })).status).toBe(409);
    expect((await a.request('POST', '/stores', { name: '!' })).status).toBe(400);
    // The test gateway allows two stores per member.
    expect((await a.request('POST', '/stores', { name: 'Mumbai' })).status).toBe(201);
    const third = await a.request('POST', '/stores', { name: 'Goa' });
    expect(third.status).toBe(409);
    expect(third.body.error).toBe('You already have 2 stores, the most a member can have.');
    // The admin cannot add a server under a store's slug either.
    const admin = await adminBrowser(gateway);
    expect((await admin.request('POST', '/upstreams', { name: 'Pune', url: 'http://x' })).status).toBe(409);
  });

  it('names a ready store’s tools after it and removes them from clients as soon as the store is deleted', async () => {
    const gateway = await startGateway(isolated);
    const storeMcp = await startUpstream(['list_orders', 'get_order']);
    onCleanup(() => storeMcp.close());
    const member = await newMember('member', isolated);
    const browser = await new Browser(gateway).login(member.email, PASSWORD);
    const { body } = await browser.request('POST', '/stores', { name: 'Delhi' });
    const storeId = (body.store as { id: string }).id;

    // What the provisioner does once the chart is installed, with the fake standing in for woo-mcp.
    const [task] = (await listStoreTasks(isolated)) as [StoreTask];
    expect(await markStoreReady(isolated, task)).toBe(true);
    await isolated.query('UPDATE upstreams SET url = $1 WHERE store_id = $2', [storeMcp.url, storeId]);
    const admin = await adminBrowser(gateway);
    const upstreams = (await admin.request('GET', '/upstreams')).body.upstreams as Upstream[];
    const storeUpstream = upstreams.find((upstream) => upstream.storeId === storeId)!;
    expect(storeUpstream).toMatchObject({ slug: 'delhi', name: 'Delhi' });
    // Enabling is allowed on a store's server and reloads the registry; other changes are not.
    expect((await admin.request('PATCH', `/upstreams/${storeUpstream.id}`, { enabled: true })).status).toBe(
      200,
    );
    expect((await admin.request('PATCH', `/upstreams/${storeUpstream.id}`, { url: 'http://x' })).status).toBe(
      409,
    );
    expect((await admin.request('DELETE', `/upstreams/${storeUpstream.id}`)).status).toBe(409);

    const client = await mcpClient(gateway, await newKey(isolated, member));
    const names = async () => (await client.listTools()).tools.map((tool) => tool.name);
    expect(await names()).toEqual([
      'delhi__get_order',
      'delhi__list_orders',
      'fail',
      'sleep',
      expect.stringMatching(/^woo\d+__list_orders$/),
    ]);
    expect(text(await client.callTool({ name: 'delhi__list_orders', arguments: {} }))).toBe(
      'list_orders done',
    );

    const deleted = await browser.request('DELETE', `/stores/${storeId}`);
    expect(deleted.status).toBe(202);
    expect(deleted.body.store).toMatchObject({ status: 'deleting' });
    expect(await names()).toEqual(['fail', 'list_orders', 'sleep']);
    expect((await isolated.query('SELECT 1 FROM upstreams WHERE store_id = $1', [storeId])).length).toBe(0);
  });

  it('lets members delete and retry only their own stores, and admins anyone’s', async () => {
    const gateway = await startGateway(isolated);
    const [owner, other] = [await newMember('member', isolated), await newMember('member', isolated)];
    const ownerBrowser = await new Browser(gateway).login(owner.email, PASSWORD);
    const otherBrowser = await new Browser(gateway).login(other.email, PASSWORD);
    const { body } = await ownerBrowser.request('POST', '/stores', { name: 'Jaipur' });
    const storeId = (body.store as { id: string }).id;

    expect((await otherBrowser.request('GET', '/stores')).body.stores).toHaveLength(1);
    expect((await otherBrowser.request('DELETE', `/stores/${storeId}`)).status).toBe(403);
    expect((await ownerBrowser.request('POST', `/stores/${storeId}/retry`)).status).toBe(409);

    const [task] = (await listStoreTasks(isolated)) as [StoreTask];
    await markStoreFailed(isolated, task, 'The store chart failed to install: job failed');
    expect((await otherBrowser.request('POST', `/stores/${storeId}/retry`)).status).toBe(403);
    const retried = await ownerBrowser.request('POST', `/stores/${storeId}/retry`);
    expect(retried.body.store).toMatchObject({ status: 'provisioning', reason: null });
    const [retriedTask] = (await listStoreTasks(isolated)) as [StoreTask];
    expect(retriedTask.attempt).toBe(2);

    const admin = await adminBrowser(gateway);
    expect((await admin.request('DELETE', `/stores/${storeId}`)).status).toBe(202);
  });
});

describe('chat agent', () => {
  it('answers through Claude, calling gateway tools as the signed-in member and auditing them as chat', async () => {
    const after = '2026-10-23T00:00:00';
    const claude = await startFakeClaude([
      {
        blocks: [
          { type: 'text', text: 'Checking the store.' },
          { type: 'tool_use', name: 'list_orders', input: { after } },
        ],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'One order came in today.' }], stopReason: 'end_turn' },
    ]);
    const gateway = await startGateway(db, claude.anthropic);
    const member = await newMember();
    const browser = await new Browser(gateway).login(member.email, PASSWORD);

    const events = await browser.chat('Which orders came in today?');

    expect(events).toEqual([
      { type: 'text', delta: 'Checking the store.' },
      { type: 'tool_call', id: 'toolu_1_1', name: 'list_orders', server: 'WooCommerce', input: { after } },
      { type: 'tool_result', id: 'toolu_1_1', isError: false, preview: 'list_orders done' },
      { type: 'text', delta: 'One order came in today.' },
      { type: 'done' },
    ]);
    expect(gateway.upstream.calls).toEqual([
      { tool: 'list_orders', args: { after }, authorization: undefined },
    ]);
    const [entry] = (await auditEntries(gateway)).filter((e) => e.memberId === member.id);
    expect(entry).toMatchObject({ via: 'chat', keyPrefix: null, tool: 'list_orders', outcome: 'succeeded' });

    const [first, second] = claude.requests;
    expect(first?.body).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'medium' } });
    // Haiku 5.5 has no server-side fallback, so the request carries neither fallbacks nor a beta.
    expect(first?.body).not.toHaveProperty('fallbacks');
    expect(first?.betas).toBeUndefined();
    expect((first?.body.tools as { name: string }[]).map((tool) => tool.name)).toEqual([
      'fail',
      'list_orders',
      'sleep',
    ]);
    const secondMessages = second?.body.messages as { role: string; content: unknown }[];
    expect(secondMessages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1_1', content: 'list_orders done', is_error: false },
      ],
    });
  });

  it('offers Claude only the tools the signed-in member may call', async () => {
    const claude = await startFakeClaude([
      { blocks: [{ type: 'text', text: 'Hi.' }], stopReason: 'end_turn' },
    ]);
    const isolated = await isolatedDatabase();
    const gateway = await startGateway(isolated, claude.anthropic);
    await isolated.query(
      `INSERT INTO admin_only_tools (upstream_id, tool) SELECT id, 'sleep' FROM upstreams`,
    );
    const member = await newMember('member', isolated);

    await (await new Browser(gateway).login(member.email, PASSWORD)).chat('Hello');

    expect((claude.requests[0]?.body.tools as { name: string }[]).map((tool) => tool.name)).toEqual([
      'fail',
      'list_orders',
    ]);
  });

  it('returns a rejected tool call to Claude as an error result and audits it', async () => {
    const claude = await startFakeClaude([
      { blocks: [{ type: 'tool_use', name: 'delete_everything', input: {} }], stopReason: 'tool_use' },
      { blocks: [{ type: 'text', text: 'That tool does not exist.' }], stopReason: 'end_turn' },
    ]);
    const gateway = await startGateway(db, claude.anthropic);
    const member = await newMember();
    const browser = await new Browser(gateway).login(member.email, PASSWORD);

    const events = await browser.chat('Delete everything.');

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        isError: true,
        preview: expect.stringMatching(/^Unknown tool/),
      }),
    );
    const [entry] = (await auditEntries(gateway)).filter((e) => e.memberId === member.id);
    expect(entry).toMatchObject({ via: 'chat', tool: 'delete_everything', outcome: 'rejected' });
    expect(gateway.upstream.calls).toEqual([]);
  });

  it('cancels a running tool call when the browser disconnects', async () => {
    const claude = await startFakeClaude([
      { blocks: [{ type: 'tool_use', name: 'sleep', input: { ms: 2000 } }], stopReason: 'tool_use' },
    ]);
    const gateway = await startGateway(db, claude.anthropic);
    const member = await newMember();
    const browser = await new Browser(gateway).login(member.email, PASSWORD);

    const disconnect = new AbortController();
    setTimeout(() => disconnect.abort(), 100);
    await expect(browser.chat('Wait a while.', disconnect.signal)).rejects.toThrow();

    await eventually(async () => {
      const [entry] = (await auditEntries(gateway)).filter((e) => e.memberId === member.id);
      expect(entry).toMatchObject({
        tool: 'sleep',
        outcome: 'failed',
        reason: 'The call was cancelled by the client.',
      });
    });
    expect(claude.requests).toHaveLength(1);
  });

  it('tells the browser to drop the text of an answer Claude declines partway through', async () => {
    const claude = await startFakeClaude([
      { blocks: [{ type: 'text', text: 'Here is how to' }], stopReason: 'refusal' },
    ]);
    const gateway = await startGateway(db, claude.anthropic);
    const browser = await new Browser(gateway).login((await newMember()).email, PASSWORD);

    expect(await browser.chat('Hello')).toEqual([
      { type: 'text', delta: 'Here is how to' },
      { type: 'error', message: 'Claude declined to answer this request.', discardText: true },
    ]);
  });

  it('reports a Claude API failure without internal details', async () => {
    const claude = await startFakeClaude([]);
    const gateway = await startGateway(db, claude.anthropic);
    const browser = await new Browser(gateway).login((await newMember()).email, PASSWORD);

    expect(await browser.chat('Hello')).toEqual([
      { type: 'error', message: 'The Claude API returned an error (HTTP 500).' },
    ]);
  });

  it('accepts a conversation at the message limits', async () => {
    const claude = await startFakeClaude([
      { blocks: [{ type: 'text', text: 'Done.' }], stopReason: 'end_turn' },
    ]);
    const gateway = await startGateway(db, claude.anthropic);
    const browser = await new Browser(gateway).login((await newMember()).email, PASSWORD);
    // 49 messages of 20,000 characters, about 1 MB, ten times the limit of the other routes.
    const messages = Array.from({ length: 49 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `${index} `.padEnd(20_000, 'x'),
    }));

    const { status, text: body } = await browser.requestText('POST', '/chat', { messages });

    expect(status).toBe(200);
    expect(body).toContain('{"type":"done"}');
  });

  it('explains Claude API errors that arrive in the middle of an answer', () => {
    const streamError = (type: 'overloaded_error' | 'api_error') =>
      new Anthropic.APIError(undefined, { type: 'error', error: { type } }, undefined, undefined, type);

    expect(chatFailureMessage(streamError('overloaded_error'))).toBe(
      'The Claude API is overloaded. Try again shortly.',
    );
    expect(chatFailureMessage(streamError('api_error'))).toBe(
      'The Claude API ended the answer with an error. Try again shortly.',
    );
  });

  it('requires a signed-in member and a conversation that ends with the member', async () => {
    const gateway = await startGateway();
    const anonymous = await new Browser(gateway).requestText('POST', '/chat', {
      messages: [{ role: 'user', text: 'Hello' }],
    });
    expect(anonymous.status).toBe(401);

    const browser = await new Browser(gateway).login((await newMember()).email, PASSWORD);
    const endsWithAssistant = await browser.request('POST', '/chat', {
      messages: [
        { role: 'user', text: 'Hello' },
        { role: 'assistant', text: 'Hi' },
      ],
    });
    expect(endsWithAssistant.status).toBe(400);
  });
});

describe('dashboard files', () => {
  it('serves the dashboard for browser routes, with security headers, but not for unknown API paths', async () => {
    const gateway = await startGateway();

    const page = await fetch(`${gateway.url}/servers`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Dashboard</title>');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');

    const asset = await fetch(`${gateway.url}/assets/index-abc123.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');

    const unknownApi = await fetch(`${gateway.url}/api/nothing-here`);
    expect(unknownApi.status).toBe(404);
    expect(await unknownApi.json()).toEqual({ error: 'Not found.' });
  });
});

describe('probes', () => {
  it('reports ready when the database answers, whatever the upstreams do', async () => {
    const gateway = await startGateway();
    await gateway.upstream.close();
    expect((await fetch(`${gateway.url}/readyz`)).status).toBe(200);
    expect((await fetch(`${gateway.url}/healthz`)).status).toBe(200);
  });
});
