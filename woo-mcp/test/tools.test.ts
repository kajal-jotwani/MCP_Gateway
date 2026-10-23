import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WooMcpConfig } from '../src/config.js';
import { createWooServer } from '../src/tools.js';
import { createStoreClient } from '../src/woocommerce.js';

// Placeholder credentials, built at runtime so secret scanners do not mistake them for real keys.
const consumerKey = `ck_${'1'.repeat(40)}`;
const consumerSecret = `cs_${'2'.repeat(40)}`;

interface RecordedRequest {
  method: string;
  url: URL;
  body: string;
}

type Responder = (request: RecordedRequest, res: ServerResponse) => void;

const order = {
  id: 42,
  number: '42',
  status: 'processing',
  currency: 'INR',
  total: '499.00',
  date_created: '2026-10-23T10:15:00',
  payment_method_title: 'Cash on delivery',
  billing: { first_name: 'Asha', last_name: 'Rao', email: 'asha@example.com', address_1: '1 Main Road' },
  line_items: [{ product_id: 7, name: 'Mug', quantity: 1, total: '499.00', sku: 'MUG-1' }],
  customer_note: 'ring twice',
};

const product = {
  id: 7,
  name: 'Mug',
  status: 'publish',
  price: '499.00',
  regular_price: '499.00',
  stock_status: 'instock',
  permalink: 'http://store.localtest.me/product/mug/',
  description: '<p>A mug</p>',
};

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

let fakeStore: Server;
let requests: RecordedRequest[];
let respond: Responder;
let client: Client;
let handler: ReturnType<typeof createMcpHandler>;

async function startFakeStore(): Promise<URL> {
  fakeStore = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const recorded = { method: req.method ?? '', url: new URL(req.url ?? '/', 'http://fake'), body };
      requests.push(recorded);
      respond(recorded, res);
    });
  });
  await new Promise<void>((resolve) => fakeStore.listen(0, '127.0.0.1', resolve));
  return new URL(`http://127.0.0.1:${(fakeStore.address() as AddressInfo).port}`);
}

async function connect(apiUrl: URL): Promise<void> {
  const config: WooMcpConfig = {
    port: 0,
    apiUrl,
    siteUrl: new URL('http://store.localtest.me'),
    consumerKey,
    consumerSecret,
    storeTimezone: 'Asia/Kolkata',
  };
  handler = createMcpHandler(() => createWooServer(createStoreClient(config), config.storeTimezone));
  client = new Client({ name: 'test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://woo-mcp.test/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? '';
}

beforeEach(async () => {
  requests = [];
  respond = (_request, res) => json(res, 200, []);
  await connect(await startFakeStore());
});

afterEach(async () => {
  await client.close();
  await handler.close();
  await new Promise((resolve) => fakeStore.close(resolve));
});

describe('woo-mcp tools', () => {
  it('lists the five tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'create_product',
      'get_order',
      'list_orders',
      'list_products',
      'update_order_status',
    ]);
    const listOrders = tools.find((tool) => tool.name === 'list_orders');
    expect(listOrders?.description).toContain('Asia/Kolkata');
  });

  it('lists orders with the given filters and a signed query', async () => {
    respond = (_request, res) => json(res, 200, [order], { 'x-wp-totalpages': '3' });
    const result = await client.callTool({
      name: 'list_orders',
      arguments: { after: '2026-10-23T00:00:00', status: 'processing' },
    });

    expect(result.isError).toBeFalsy();
    const [request] = requests;
    expect(request?.method).toBe('GET');
    expect(request?.url.pathname).toBe('/wp-json/wc/v3/orders');
    expect(request?.url.searchParams.get('after')).toBe('2026-10-23T00:00:00');
    expect(request?.url.searchParams.get('status')).toBe('processing');
    expect(request?.url.searchParams.get('per_page')).toBe('20');
    expect(request?.url.searchParams.get('oauth_signature_method')).toBe('HMAC-SHA256');
    expect(request?.url.searchParams.get('oauth_signature')).toBeTruthy();

    expect(JSON.parse(resultText(result))).toEqual({
      page: 1,
      total_pages: 3,
      orders: [
        {
          id: 42,
          number: '42',
          status: 'processing',
          currency: 'INR',
          total: '499.00',
          date_created: '2026-10-23T10:15:00',
          customer: 'Asha Rao',
          payment_method: 'Cash on delivery',
          line_items: [{ product_id: 7, name: 'Mug', quantity: 1, total: '499.00' }],
        },
      ],
    });
  });

  it('leaves customer contact details out of order results', async () => {
    respond = (_request, res) => json(res, 200, order);
    const text = resultText(await client.callTool({ name: 'get_order', arguments: { id: 42 } }));
    expect(text).not.toContain('asha@example.com');
    expect(text).not.toContain('Main Road');
    expect(text).not.toContain('ring twice');
  });

  it('creates a published simple product from name and price', async () => {
    respond = (_request, res) => json(res, 201, product);
    const result = await client.callTool({
      name: 'create_product',
      arguments: { name: 'Mug', regular_price: '499.00' },
    });

    expect(result.isError).toBeFalsy();
    expect(requests[0]?.method).toBe('POST');
    expect(JSON.parse(requests[0]?.body ?? '')).toEqual({
      name: 'Mug',
      type: 'simple',
      regular_price: '499.00',
      status: 'publish',
    });
    expect(JSON.parse(resultText(result))).toMatchObject({ id: 7, permalink: product.permalink });
  });

  it('accepts a numeric price and sends it to WooCommerce as a string', async () => {
    respond = (_request, res) => json(res, 201, product);
    await client.callTool({ name: 'create_product', arguments: { name: 'Mug', regular_price: 19.5 } });
    expect(JSON.parse(requests[0]?.body ?? '')).toMatchObject({ regular_price: '19.5' });
  });

  it('updates an order status with PUT', async () => {
    respond = (_request, res) => json(res, 200, { ...order, status: 'completed' });
    const result = await client.callTool({
      name: 'update_order_status',
      arguments: { id: 42, status: 'completed' },
    });

    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.url.pathname).toBe('/wp-json/wc/v3/orders/42');
    expect(JSON.parse(requests[0]?.body ?? '')).toEqual({ status: 'completed' });
    expect(JSON.parse(resultText(result))).toMatchObject({ status: 'completed' });
  });

  it('rejects a date with a time zone offset before calling the store', async () => {
    const result = await client.callTool({
      name: 'list_orders',
      arguments: { after: '2026-10-23T00:00:00Z' },
    });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('passes on the WooCommerce error message for a rejected request', async () => {
    respond = (_request, res) =>
      json(res, 404, {
        code: 'woocommerce_rest_shop_order_invalid_id',
        message: 'Invalid ID.',
        data: { status: 404 },
      });
    const result = await client.callTool({ name: 'get_order', arguments: { id: 999 } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('The store rejected the request (HTTP 404): Invalid ID.');
  });

  it('reports an unexpected response format instead of passing it on', async () => {
    respond = (_request, res) => json(res, 200, { unexpected: true });
    const result = await client.callTool({ name: 'list_products', arguments: {} });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('The store returned a response in an unexpected format.');
  });

  it('reports an unreachable store without its address', async () => {
    await client.close();
    await handler.close();
    await connect(new URL('http://127.0.0.1:1'));
    const result = await client.callTool({ name: 'list_products', arguments: {} });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('The store is unreachable.');
  });
});
