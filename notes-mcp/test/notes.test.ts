import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNotesHttpServer } from '../src/http.js';

const token = 'test-token-'.padEnd(40, 'x');
let server: Server;
let url: URL;

function connect(authorization: string | undefined): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const headers: Record<string, string> = authorization ? { authorization } : {};
  return client
    .connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }))
    .then(() => client);
}

function resultJson(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const [first] = result.content as { type: string; text: string }[];
  return JSON.parse(first?.text ?? 'null');
}

beforeEach(async () => {
  server = createNotesHttpServer(token, new Map());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('notes-mcp', () => {
  it('rejects requests without the bearer token', async () => {
    await expect(connect(undefined)).rejects.toThrow();
    await expect(connect('Bearer wrong-token')).rejects.toThrow();
  });

  it('saves, lists and searches notes', async () => {
    const client = await connect(`Bearer ${token}`);
    await client.callTool({
      name: 'save_note',
      arguments: { title: 'Orders today', body: 'Order 42, Asha Rao, 499.00' },
    });
    await client.callTool({ name: 'save_note', arguments: { title: 'Ideas', body: 'Restock mugs' } });

    const listed = resultJson(await client.callTool({ name: 'list_notes', arguments: {} })) as {
      title: string;
    }[];
    expect(listed.map((note) => note.title).sort()).toEqual(['Ideas', 'Orders today']);

    const found = resultJson(await client.callTool({ name: 'search_notes', arguments: { query: 'asha' } }));
    expect(found).toMatchObject([{ title: 'Orders today', body: 'Order 42, Asha Rao, 499.00' }]);
    await client.close();
  });

  it('replaces a note saved again under the same title and keeps its id', async () => {
    const client = await connect(`Bearer ${token}`);
    const first = resultJson(
      await client.callTool({ name: 'save_note', arguments: { title: 'Orders today', body: 'none yet' } }),
    ) as { id: string };
    const second = resultJson(
      await client.callTool({ name: 'save_note', arguments: { title: 'Orders today', body: 'Order 42' } }),
    ) as { id: string; body: string };
    expect(second).toMatchObject({ id: first.id, body: 'Order 42' });
    await client.close();
  });
});
