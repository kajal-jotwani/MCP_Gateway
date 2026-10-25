import type { Tool } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import { exposeToolNames, MAX_TOOL_NAME_LENGTH } from '../src/toolNames.js';
import type { UpstreamTools } from '../src/toolNames.js';

function tools(...names: string[]): Tool[] {
  return names.map((name) => ({ name, inputSchema: { type: 'object' } }));
}

function upstream(slug: string, ...names: string[]): UpstreamTools {
  return { upstreamId: `id-${slug}`, slug, alwaysPrefix: false, tools: tools(...names) };
}

function namesOf(upstreams: UpstreamTools[]): Record<string, string> {
  return Object.fromEntries(
    exposeToolNames(upstreams).map((tool) => [tool.name, `${tool.upstreamId}:${tool.originalName}`]),
  );
}

describe('exposeToolNames', () => {
  it('keeps plain upstream names when no two upstreams share one', () => {
    expect(
      namesOf([upstream('store', 'list_orders', 'create_product'), upstream('notes', 'save_note')]),
    ).toEqual({
      create_product: 'id-store:create_product',
      list_orders: 'id-store:list_orders',
      save_note: 'id-notes:save_note',
    });
  });

  it('prefixes every colliding tool with its slug and leaves the others alone', () => {
    expect(
      namesOf([upstream('notes', 'save_note', 'list_notes'), upstream('notes2', 'save_note', 'echo')]),
    ).toEqual({
      echo: 'id-notes2:echo',
      list_notes: 'id-notes:list_notes',
      notes__save_note: 'id-notes:save_note',
      notes2__save_note: 'id-notes2:save_note',
    });
  });

  it('gives the same names whatever order the upstreams are registered in', () => {
    const a = upstream('alpha', 'search', 'one');
    const b = upstream('beta', 'search', 'two');
    expect(exposeToolNames([a, b])).toEqual(exposeToolNames([b, a]));
  });

  it('replaces characters that clients reject with an underscore', () => {
    expect(namesOf([upstream('docs', 'docs.search', 'get page')])).toEqual({
      docs_search: 'id-docs:docs.search',
      get_page: 'id-docs:get page',
    });
  });

  it('shortens long names to the limit with a stable hash suffix', () => {
    const long = 'a'.repeat(70);
    const [first] = exposeToolNames([upstream('docs', long)]);
    const [again] = exposeToolNames([upstream('docs', long)]);
    expect(first?.name).toHaveLength(MAX_TOOL_NAME_LENGTH);
    expect(first?.name).toMatch(/^a{41}_[0-9a-f]{6}$/);
    expect(again?.name).toBe(first?.name);
    expect(first?.originalName).toBe(long);
  });

  it('keeps two long names with the same beginning apart', () => {
    const exposed = exposeToolNames([upstream('docs', `${'a'.repeat(60)}1`, `${'a'.repeat(60)}2`)]);
    expect(new Set(exposed.map((tool) => tool.name)).size).toBe(2);
    for (const tool of exposed) expect(tool.name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
  });

  it('separates names that only differ in characters that get replaced', () => {
    const exposed = exposeToolNames([upstream('docs', 'get.page', 'get_page')]);
    expect(exposed.map((tool) => tool.originalName).sort()).toEqual(['get.page', 'get_page']);
    expect(new Set(exposed.map((tool) => tool.name)).size).toBe(2);
  });

  it('separates a tool literally named like another upstream’s prefixed name', () => {
    const exposed = namesOf([upstream('notes', 'search'), upstream('store', 'search', 'notes__search')]);
    expect(Object.values(exposed).sort()).toEqual([
      'id-notes:search',
      'id-store:notes__search',
      'id-store:search',
    ]);
    expect(exposed['store__search']).toBe('id-store:search');
  });

  it('prefixes every tool of a store, and the tools it shares with other upstreams', () => {
    expect(
      namesOf([
        upstream('woocommerce', 'list_orders', 'get_order'),
        { ...upstream('delhi', 'list_orders', 'get_order'), alwaysPrefix: true },
        upstream('notes', 'save_note'),
      ]),
    ).toEqual({
      delhi__get_order: 'id-delhi:get_order',
      delhi__list_orders: 'id-delhi:list_orders',
      save_note: 'id-notes:save_note',
      woocommerce__get_order: 'id-woocommerce:get_order',
      woocommerce__list_orders: 'id-woocommerce:list_orders',
    });
  });

  it('prefixes a store’s tools even when it is the only upstream', () => {
    expect(namesOf([{ ...upstream('delhi', 'list_orders'), alwaysPrefix: true }])).toEqual({
      delhi__list_orders: 'id-delhi:list_orders',
    });
  });

  it('uses the first definition when an upstream lists a tool twice', () => {
    const duplicate: UpstreamTools = {
      upstreamId: 'id-docs',
      slug: 'docs',
      alwaysPrefix: false,
      tools: [
        { name: 'search', description: 'first', inputSchema: { type: 'object' } },
        { name: 'search', description: 'second', inputSchema: { type: 'object' } },
      ],
    };
    const exposed = exposeToolNames([duplicate]);
    expect(exposed).toHaveLength(1);
    expect(exposed[0]?.tool.description).toBe('first');
  });
});
