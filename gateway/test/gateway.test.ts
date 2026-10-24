import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';

import type { Queryable } from '../src/db.js';
import { callerAuthInfo, createGatewayMcpHandler } from '../src/mcpEndpoint.js';
import { UpstreamRegistry } from '../src/registry.js';
import type { UpstreamConfig } from '../src/registry.js';
import {
  deadUrl,
  eventually,
  onCleanup,
  runCleanups,
  startSilentServer,
  startUpstream,
  text,
} from './fakeUpstreams.js';

const TIMEOUTS = { connectMs: 500, listMs: 500, callMs: 500 };
const MEMBER = { id: 'member-1', email: 'a@example.com', name: 'A', role: 'member' as const, active: true };
// Audit entries are covered with a real database in app.test.ts; here they only need somewhere to go.
const auditSink: Queryable = { query: async () => [] };
const NOTES_TOKEN = 'notes-token-for-tests';

afterEach(runCleanups);

function upstream(
  slug: string,
  name: string,
  url: string,
  extra: Partial<UpstreamConfig> = {},
): UpstreamConfig {
  return { id: `id-${slug}`, slug, name, url, enabled: true, ...extra };
}

function connectThrough(handler: McpHttpHandler, client: Client): Promise<void> {
  return client.connect(
    new StreamableHTTPClientTransport(new URL('http://gateway.test/mcp'), {
      fetch: (url, init) =>
        handler.fetch(new Request(url, init), { authInfo: callerAuthInfo({ member: MEMBER, via: 'mcp' }) }),
    }),
  );
}

async function startGateway(configs: UpstreamConfig[]): Promise<{
  registry: UpstreamRegistry;
  handler: McpHttpHandler;
  client: Client;
  toolsChanged: () => number;
}> {
  const registry = new UpstreamRegistry(TIMEOUTS);
  await registry.sync(configs);
  const handler = createGatewayMcpHandler({ db: auditSink, registry });
  let changes = 0;
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    {
      versionNegotiation: { mode: 'auto' },
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => changes++ } },
    },
  );
  await connectThrough(handler, client);
  onCleanup(async () => {
    await client.close();
    await handler.close();
    await registry.close();
  });
  return { registry, handler, client, toolsChanged: () => changes };
}

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools(undefined, { cacheMode: 'bypass' });
  return tools.map((tool) => tool.name);
}

describe('gateway core', () => {
  it('lists the tools of three upstreams under their plain names', async () => {
    const woo = await startUpstream(['list_orders', 'create_product']);
    const notes = await startUpstream(['save_note', 'list_notes'], { token: NOTES_TOKEN });
    const everything = await startUpstream(['echo', 'get-sum']);
    const { client } = await startGateway([
      upstream('woocommerce', 'WooCommerce', woo.url),
      upstream('notes', 'Notes', notes.url, {
        credential: { header: 'authorization', value: `Bearer ${NOTES_TOKEN}` },
      }),
      upstream('everything', 'Everything', everything.url),
    ]);

    expect(await toolNames(client)).toEqual([
      'create_product',
      'echo',
      'get-sum',
      'list_notes',
      'list_orders',
      'save_note',
    ]);
  });

  it('serves 2025-era clients that connect with initialize', async () => {
    const woo = await startUpstream(['list_orders']);
    const { handler } = await startGateway([upstream('woocommerce', 'WooCommerce', woo.url)]);
    const legacyClient = new Client({ name: 'legacy-client', version: '1.0.0' });
    await connectThrough(handler, legacyClient);
    onCleanup(() => legacyClient.close());

    expect(legacyClient.getNegotiatedProtocolVersion()).toMatch(/^2025-/);
    expect(await toolNames(legacyClient)).toEqual(['list_orders']);
    expect(text(await legacyClient.callTool({ name: 'list_orders', arguments: {} }))).toBe(
      'list_orders done',
    );
  });

  it('routes each call to its upstream under the original name, with that upstream’s credential', async () => {
    const woo = await startUpstream(['list_orders']);
    const notes = await startUpstream(['save_note'], { token: NOTES_TOKEN });
    const { client } = await startGateway([
      upstream('woocommerce', 'WooCommerce', woo.url),
      upstream('notes', 'Notes', notes.url, {
        credential: { header: 'authorization', value: `Bearer ${NOTES_TOKEN}` },
      }),
    ]);

    const saved = await client.callTool({ name: 'save_note', arguments: { title: 'Orders today' } });
    const listed = await client.callTool({ name: 'list_orders', arguments: {} });

    expect(text(saved)).toBe('save_note done');
    expect(text(listed)).toBe('list_orders done');
    expect(notes.calls).toEqual([
      { tool: 'save_note', args: { title: 'Orders today' }, authorization: `Bearer ${NOTES_TOKEN}` },
    ]);
    expect(woo.calls).toEqual([{ tool: 'list_orders', args: {}, authorization: undefined }]);
  });

  it('prefixes colliding tool names and routes each to its own upstream', async () => {
    const first = await startUpstream(['save_note', 'list_notes']);
    const second = await startUpstream(['save_note']);
    const { client } = await startGateway([
      upstream('notes', 'Notes', first.url),
      upstream('notes2', 'Notes 2', second.url),
    ]);

    expect(await toolNames(client)).toEqual(['list_notes', 'notes2__save_note', 'notes__save_note']);
    await client.callTool({ name: 'notes2__save_note', arguments: {} });
    expect(second.calls.map((call) => call.tool)).toEqual(['save_note']);
    expect(first.calls).toEqual([]);
  });

  it('keeps collision prefixes while one of the colliding upstreams is down', async () => {
    const first = await startUpstream(['save_note']);
    const second = await startUpstream(['save_note']);
    const { client, registry } = await startGateway([
      upstream('notes', 'Notes', first.url),
      upstream('notes2', 'Notes 2', second.url),
    ]);

    await second.close();
    await registry.refreshAll();

    expect(await toolNames(client)).toEqual(['notes__save_note']);
    const result = await client.callTool({ name: 'notes__save_note', arguments: {} });
    expect(result.isError).toBeFalsy();
  });

  it('keeps listing and calls working when one upstream never answers', async () => {
    const woo = await startUpstream(['list_orders']);
    const started = Date.now();
    const { client, registry } = await startGateway([
      upstream('woocommerce', 'WooCommerce', woo.url),
      upstream('silent', 'Silent', await startSilentServer()),
    ]);

    // The silent upstream costs its own connect timeout, not more.
    expect(Date.now() - started).toBeLessThan(TIMEOUTS.connectMs + 1000);
    expect(registry.states().get('id-silent')).toMatchObject({ status: 'unreachable', error: 'timed out' });

    const listStarted = Date.now();
    expect(await toolNames(client)).toEqual(['list_orders']);
    expect(Date.now() - listStarted).toBeLessThan(200);
    expect(text(await client.callTool({ name: 'list_orders', arguments: {} }))).toBe('list_orders done');
  });

  it('reports an upstream that refuses connections as unreachable and hides its tools', async () => {
    const woo = await startUpstream(['list_orders']);
    const { client, registry } = await startGateway([
      upstream('woocommerce', 'WooCommerce', woo.url),
      upstream('dead', 'Dead', await deadUrl()),
    ]);

    expect(registry.states().get('id-dead')).toMatchObject({
      status: 'unreachable',
      error: 'connection failed',
    });
    expect(registry.states().get('id-woocommerce')).toMatchObject({ status: 'connected' });
    expect(await toolNames(client)).toEqual(['list_orders']);
  });

  it('reports an upstream that rejects the gateway’s credential', async () => {
    const notes = await startUpstream(['save_note'], { token: NOTES_TOKEN });
    const { registry } = await startGateway([
      upstream('notes', 'Notes', notes.url, {
        credential: { header: 'authorization', value: 'Bearer wrong' },
      }),
    ]);

    expect(registry.states().get('id-notes')).toMatchObject({
      status: 'unreachable',
      error: "rejected the gateway's credential (HTTP 401)",
    });
  });

  it('times out a slow call with a clear error while other calls keep working', async () => {
    const everything = await startUpstream(['sleep']);
    const woo = await startUpstream(['list_orders']);
    const { client } = await startGateway([
      upstream('everything', 'Everything', everything.url),
      upstream('woocommerce', 'WooCommerce', woo.url),
    ]);

    const slow = client.callTool({ name: 'sleep', arguments: { ms: 3000 } });
    const fast = await client.callTool({ name: 'list_orders', arguments: {} });
    expect(text(fast)).toBe('list_orders done');

    const timedOut = await slow;
    expect(timedOut.isError).toBe(true);
    expect(text(timedOut)).toBe('Upstream "Everything" did not respond within 0.5 s.');
  });

  it('marks an upstream unreachable when it dies and hides its tools at once', async () => {
    const woo = await startUpstream(['list_orders']);
    const notes = await startUpstream(['save_note']);
    const { client, registry } = await startGateway([
      upstream('woocommerce', 'WooCommerce', woo.url),
      upstream('notes', 'Notes', notes.url),
    ]);

    await woo.close();
    const result = await client.callTool({ name: 'list_orders', arguments: {} });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Upstream "WooCommerce" is unreachable.');
    await eventually(() => expect(registry.states().get('id-woocommerce')?.status).toBe('unreachable'));
    expect(await toolNames(client)).toEqual(['save_note']);
    expect(text(await client.callTool({ name: 'save_note', arguments: {} }))).toBe('save_note done');
  });

  it('connects again when an unreachable upstream comes back', async () => {
    const woo = await startUpstream(['list_orders']);
    const { client, registry } = await startGateway([upstream('woocommerce', 'WooCommerce', woo.url)]);
    await woo.close();
    await registry.refreshAll();
    expect(await toolNames(client)).toEqual([]);

    await startUpstream(['list_orders'], { port: woo.port });
    await registry.refreshAll();

    expect(registry.states().get('id-woocommerce')?.status).toBe('connected');
    expect(text(await client.callTool({ name: 'list_orders', arguments: {} }))).toBe('list_orders done');
  });

  it('removes a disabled upstream’s tools and tells listening clients', async () => {
    const woo = await startUpstream(['list_orders']);
    const notes = await startUpstream(['save_note']);
    const configs = [upstream('woocommerce', 'WooCommerce', woo.url), upstream('notes', 'Notes', notes.url)];
    const { client, registry, toolsChanged } = await startGateway(configs);
    const before = toolsChanged();

    await registry.sync([configs[0]!, { ...configs[1]!, enabled: false }]);

    expect(registry.states().get('id-notes')).toMatchObject({ status: 'disabled', tools: [] });
    expect(await toolNames(client)).toEqual(['list_orders']);
    await eventually(() => expect(toolsChanged()).toBeGreaterThan(before));

    const result = await client.callTool({ name: 'save_note', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Unknown tool "save_note"/);
    expect(notes.calls).toEqual([]);
  });

  it('passes an upstream tool error on to the client', async () => {
    const everything = await startUpstream(['fail']);
    const { client } = await startGateway([upstream('everything', 'Everything', everything.url)]);

    const result = await client.callTool({ name: 'fail', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('the upstream tool failed');
  });

  it('keeps an upstream connected when one call is answered with an HTTP error', async () => {
    const woo = await startUpstream(['list_orders']);
    const { client, registry } = await startGateway([upstream('woocommerce', 'WooCommerce', woo.url)]);

    // Over the upstream SDK's 4 MiB request limit, so the upstream answers 413.
    const oversized = registry.callTool(registry.resolve('list_orders')!, { padding: 'x'.repeat(4_300_000) });
    await expect(oversized).rejects.toThrow('Upstream "WooCommerce" answered HTTP 413.');

    expect(registry.states().get('id-woocommerce')?.status).toBe('connected');
    expect(await toolNames(client)).toEqual(['list_orders']);
    expect(text(await client.callTool({ name: 'list_orders', arguments: {} }))).toBe('list_orders done');
  });

  it('opens a new change stream after an upstream shuts down gracefully and comes back', async () => {
    const names = ['list_orders'];
    const woo = await startUpstream(names);
    const { registry } = await startGateway([upstream('woocommerce', 'WooCommerce', woo.url)]);

    await woo.close();
    const restarted = await startUpstream(names, { port: woo.port });
    // Lets the registry's client see the server end its stream before the next refresh runs.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await registry.refreshAll();
    names.push('create_product');
    restarted.notifyToolsChanged();

    await eventually(() =>
      expect(registry.listTools().map((tool) => tool.name)).toEqual(['create_product', 'list_orders']),
    );
  });

  it('keeps a running call alive while it opens a new change stream', async () => {
    const woo = await startUpstream(['sleep']);
    const { registry } = await startGateway([upstream('woocommerce', 'WooCommerce', woo.url)]);

    await woo.close();
    const restarted = await startUpstream(['sleep'], { port: woo.port });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const running = registry.callTool(registry.resolve('sleep')!, { ms: 400 });
    await eventually(() => expect(restarted.calls).toHaveLength(1));
    await registry.refreshAll();

    expect(text(await running)).toBe('sleep done');
  });

  it('stays connected when a restarted upstream refuses a new change stream', async () => {
    const woo = await startUpstream(['sleep']);
    const { registry } = await startGateway([upstream('woocommerce', 'WooCommerce', woo.url)]);

    await woo.close();
    const restarted = await startUpstream(['sleep'], { port: woo.port, maxSubscriptions: 0 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const running = registry.callTool(registry.resolve('sleep')!, { ms: 400 });
    await eventually(() => expect(restarted.calls).toHaveLength(1));
    await registry.refreshAll();

    expect(registry.states().get('id-woocommerce')?.status).toBe('connected');
    expect(text(await running)).toBe('sleep done');
  });

  it('applies overlapping reloads in order, so the latest rows win', async () => {
    const woo = await startUpstream(['list_orders']);
    const config = upstream('woocommerce', 'WooCommerce', woo.url);
    const registry = new UpstreamRegistry(TIMEOUTS);
    onCleanup(() => registry.close());
    const slowRead = Promise.withResolvers<void>();

    // The first read is slow. Applied out of order, it would re-enable the upstream after the second.
    const first = registry.reload(async () => {
      await slowRead.promise;
      return [config];
    });
    const second = registry.reload(async () => [{ ...config, enabled: false }]);
    slowRead.resolve();
    await Promise.all([first, second]);

    expect(registry.states().get('id-woocommerce')?.status).toBe('disabled');
  });
});
