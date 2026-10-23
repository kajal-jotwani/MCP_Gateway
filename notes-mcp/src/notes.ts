import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export interface Note {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
}

/** Notes keyed by title. Kept in memory: they are demo data and are lost when the pod restarts. */
export type NoteStore = Map<string, Note>;

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Builds the MCP server with the notes tools over a shared store. Called once per HTTP request. */
export function createNotesServer(notes: NoteStore): McpServer {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });

  server.registerTool(
    'save_note',
    {
      title: 'Save note',
      description: 'Save a note under a title. Saving again with the same title replaces the note.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        body: z.string().max(20_000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ title, body }) => {
      const note = {
        id: notes.get(title)?.id ?? randomUUID(),
        title,
        body,
        updatedAt: new Date().toISOString(),
      };
      notes.set(title, note);
      return textResult(note);
    },
  );

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description: 'List the titles of all saved notes, most recently updated first.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const summaries = [...notes.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
      return textResult(summaries);
    },
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description: 'Return the notes whose title or body contains the given text, ignoring case.',
      inputSchema: z.object({ query: z.string().min(1).max(200) }),
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const needle = query.toLowerCase();
      const matches = [...notes.values()].filter(
        (note) => note.title.toLowerCase().includes(needle) || note.body.toLowerCase().includes(needle),
      );
      return textResult(matches);
    },
  );

  return server;
}
