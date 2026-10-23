import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { StoreError } from './woocommerce.js';
import type { StoreClient } from './woocommerce.js';

const ORDER_STATUSES = [
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
] as const;
const PRODUCT_STATUSES = ['publish', 'draft', 'pending', 'private'] as const;

// WooCommerce reads `after` and `before` as store-local time unless told otherwise, so the tool takes
// local date-times without an offset and says which time zone they are in.
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'must look like 2026-10-23T00:00:00 (store local time)');

const pagination = {
  page: z.number().int().min(1).default(1).describe('Page number, starting at 1'),
  per_page: z.number().int().min(1).max(50).default(20).describe('Results per page, at most 50'),
};

// Response schemas keep only the fields a person needs. Unknown keys are dropped, which also keeps
// customer addresses, emails and phone numbers out of the model's context.
const wooProduct = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  price: z.string(),
  regular_price: z.string(),
  stock_status: z.string(),
  permalink: z.string(),
});

const wooOrder = z.object({
  id: z.number(),
  number: z.string(),
  status: z.string(),
  currency: z.string(),
  total: z.string(),
  date_created: z.string(),
  payment_method_title: z.string(),
  billing: z.object({ first_name: z.string(), last_name: z.string() }),
  line_items: z.array(
    z.object({ product_id: z.number(), name: z.string(), quantity: z.number(), total: z.string() }),
  ),
});

type WooOrder = z.infer<typeof wooOrder>;

function summarizeOrder(order: WooOrder) {
  const { billing, payment_method_title, ...rest } = order;
  return {
    ...rest,
    customer: `${billing.first_name} ${billing.last_name}`.trim(),
    payment_method: payment_method_title,
  };
}

/** Validates an upstream response at the boundary; a mismatch means the store's API changed. */
function parseStoreBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new StoreError('The store returned a response in an unexpected format.');
  return parsed.data;
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Builds the MCP server with the five WooCommerce tools. Called once per HTTP request. */
export function createWooServer(store: StoreClient, storeTimezone: string): McpServer {
  const server = new McpServer({ name: 'woocommerce', version: '1.0.0' });

  server.registerTool(
    'list_products',
    {
      title: 'List products',
      description: 'List products in the WooCommerce store, newest first. Optionally search by name.',
      inputSchema: z.object({
        search: z.string().max(100).optional().describe('Text to match against product names'),
        status: z.enum(PRODUCT_STATUSES).optional().describe('Only products with this status'),
        ...pagination,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ search, status, page, per_page }, ctx) => {
      const query: Record<string, string> = { page: String(page), per_page: String(per_page) };
      if (search) query.search = search;
      if (status) query.status = status;
      const response = await store({ method: 'GET', path: 'products', query, signal: ctx.mcpReq.signal });
      const products = parseStoreBody(z.array(wooProduct), response.body);
      return textResult({ page, total_pages: response.totalPages, products });
    },
  );

  server.registerTool(
    'create_product',
    {
      title: 'Create product',
      description:
        'Create a simple product in the WooCommerce store. It is published unless status is draft.',
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        regular_price: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal number such as 19.99')
          .describe('Price in the store currency, as a string such as "19.99"'),
        description: z.string().max(5000).optional(),
        status: z.enum(['publish', 'draft']).default('publish'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, regular_price, description, status }, ctx) => {
      const response = await store({
        method: 'POST',
        path: 'products',
        body: { name, type: 'simple', regular_price, description, status },
        signal: ctx.mcpReq.signal,
      });
      return textResult(parseStoreBody(wooProduct, response.body));
    },
  );

  server.registerTool(
    'list_orders',
    {
      title: 'List orders',
      description:
        `List orders in the WooCommerce store, newest first. Dates in the input and the output are ` +
        `store local time, time zone ${storeTimezone}. For today's orders, set after to today's date at 00:00:00.`,
      inputSchema: z.object({
        after: localDateTime.optional().describe('Only orders created after this local date-time'),
        before: localDateTime.optional().describe('Only orders created before this local date-time'),
        status: z.enum(ORDER_STATUSES).optional().describe('Only orders with this status'),
        ...pagination,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ after, before, status, page, per_page }, ctx) => {
      const query: Record<string, string> = { page: String(page), per_page: String(per_page) };
      if (after) query.after = after;
      if (before) query.before = before;
      if (status) query.status = status;
      const response = await store({ method: 'GET', path: 'orders', query, signal: ctx.mcpReq.signal });
      const orders = parseStoreBody(z.array(wooOrder), response.body);
      return textResult({ page, total_pages: response.totalPages, orders: orders.map(summarizeOrder) });
    },
  );

  server.registerTool(
    'get_order',
    {
      title: 'Get order',
      description: `Get one order by its id. Dates are store local time, time zone ${storeTimezone}.`,
      inputSchema: z.object({ id: z.number().int().positive().describe('Order id') }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }, ctx) => {
      const response = await store({ method: 'GET', path: `orders/${id}`, signal: ctx.mcpReq.signal });
      return textResult(summarizeOrder(parseStoreBody(wooOrder, response.body)));
    },
  );

  server.registerTool(
    'update_order_status',
    {
      title: 'Update order status',
      description: 'Change the status of one order, for example to completed or cancelled.',
      inputSchema: z.object({
        id: z.number().int().positive().describe('Order id'),
        status: z.enum(ORDER_STATUSES),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, status }, ctx) => {
      const response = await store({
        method: 'PUT',
        path: `orders/${id}`,
        body: { status },
        signal: ctx.mcpReq.signal,
      });
      return textResult(summarizeOrder(parseStoreBody(wooOrder, response.body)));
    },
  );

  return server;
}
