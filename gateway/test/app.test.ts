import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createApiKey } from '../src/apiKeys.js';
import { createApp } from '../src/app.js';
import type { AuditEntry } from '../src/audit.js';
import type { Database } from '../src/db.js';
import { createGatewayMcpHandler } from '../src/mcpEndpoint.js';
import { UpstreamRegistry } from '../src/registry.js';
import { createMember, ensureFirstAdmin, hashPassword, verifyPassword } from '../src/team.js';
import type { Member, Role } from '../src/team.js';
import { listUpstreamConfigs } from '../src/upstreams.js';
import { createTestDatabase } from './database.js';
import { onCleanup, runCleanups, startUpstream, text } from './fakeUpstreams.js';
import type { FakeUpstream } from './fakeUpstreams.js';

const ADMIN = { email: 'admin@example.com', password: 'admin-password-123' };
const PASSWORD = 'member-password-123';

let db: Database;
let emailCounter = 0;
let upstreamCounter = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFirstAdmin(db, ADMIN);
});

afterAll(async () => {
  await db.close();
});

afterEach(runCleanups);

interface Gateway {
  url: string;
  upstream: FakeUpstream;
}

/** Starts the gateway's HTTP app on a free port, with one upstream named WooCommerce. */
async function startGateway(): Promise<Gateway> {
  const upstream = await startUpstream(['list_orders', 'fail', 'sleep']);
  upstreamCounter += 1;
  const [{ id }] = (await db.query<{ id: string }>(
    `INSERT INTO upstreams (slug, name, url, auth_type) VALUES ($1, 'WooCommerce', $2, 'none') RETURNING id`,
    [`woo${upstreamCounter}`, upstream.url],
  )) as [{ id: string }];
  const registry = new UpstreamRegistry({ connectMs: 500, listMs: 500, callMs: 300 });
  // Each test's gateway sees only its own upstream row; the database is shared by the whole file.
  await registry.sync((await listUpstreamConfigs(db)).filter((config) => config.id === id));
  const mcpHandler = createGatewayMcpHandler({ db, registry });
  const app = createApp({ db, mcpHandler, publicUrl: new URL('http://app.localtest.me') });
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
    const response = await fetch(`${this.gateway.url}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: this.cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    const responseText = await response.text();
    return { status: response.status, body: responseText ? JSON.parse(responseText) : {} };
  }

  async login(email: string, password: string): Promise<this> {
    const { status } = await this.request('POST', '/login', { email, password });
    expect(status).toBe(200);
    return this;
  }
}

async function newMember(role: Role = 'member'): Promise<Member> {
  emailCounter += 1;
  const member = await createMember(db, {
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
      memberId: null,
      via: 'mcp',
      tool: 'list_orders',
      reason: 'Unknown or revoked API key (tools/call).',
    });
  });

  it('rejects requests without a key, with an unknown key, and with a deactivated member’s key', async () => {
    const gateway = await startGateway();
    const member = await newMember();
    const { key } = await createApiKey(db, { memberId: member.id, name: 'cli', createdBy: member.id });
    await (await adminBrowser(gateway)).request('PATCH', `/members/${member.id}`, { active: false });

    await expect(mcpClient(gateway, undefined)).rejects.toThrow(/401/);
    await expect(mcpClient(gateway, `urk_${'A'.repeat(43)}`)).rejects.toThrow(/401/);
    await expect(mcpClient(gateway, key)).rejects.toThrow(/401/);
    expect(gateway.upstream.calls).toEqual([]);
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

describe('probes', () => {
  it('reports ready when the database answers, whatever the upstreams do', async () => {
    const gateway = await startGateway();
    await gateway.upstream.close();
    expect((await fetch(`${gateway.url}/readyz`)).status).toBe(200);
    expect((await fetch(`${gateway.url}/healthz`)).status).toBe(200);
  });
});
