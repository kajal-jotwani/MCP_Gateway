import { describe, expect, it } from 'vitest';

import type { RoutedTool } from '../src/registry.js';
import { searchTools } from '../src/toolSearch.js';

function tool(
  name: string,
  description: string,
  upstreamName = 'WooCommerce',
  upstreamSlug = 'woocommerce',
): RoutedTool {
  return {
    name,
    originalName: name,
    upstreamId: upstreamSlug,
    upstreamName,
    upstreamSlug,
    tool: { name, description, inputSchema: { type: 'object' } },
  };
}

const tools = [
  tool('list_orders', 'Lists orders, newest first.'),
  tool('get_order', 'Gets one order with its line items.'),
  tool('create_product', 'Creates a simple product with a name and price.'),
  tool('delhi__list_orders', 'Lists orders, newest first.', 'Delhi', 'delhi'),
  tool('save_note', 'Saves a note.', 'Notes', 'notes'),
];

describe('tool search', () => {
  it('ranks name matches above description matches and finds plurals and prefixes', () => {
    expect(searchTools(tools, 'orders', 10).map((t) => t.name)).toEqual([
      'delhi__list_orders',
      'get_order',
      'list_orders',
    ]);
    expect(searchTools(tools, 'create product', 10).map((t) => t.name)).toEqual(['create_product']);
  });

  it('uses the server name, so a store can be named in the query', () => {
    expect(searchTools(tools, 'delhi orders', 10)[0]!.name).toBe('delhi__list_orders');
    expect(searchTools(tools, 'notes', 10).map((t) => t.name)).toEqual(['save_note']);
  });

  it('returns nothing for unrelated words and respects the limit', () => {
    expect(searchTools(tools, 'weather forecast', 10)).toEqual([]);
    expect(searchTools(tools, 'order', 2)).toHaveLength(2);
  });
});
