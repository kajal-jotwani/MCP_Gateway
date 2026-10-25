import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import Anthropic from '@anthropic-ai/sdk';

import { onCleanup } from './fakeUpstreams.js';

export type ScriptedBlock =
  { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: unknown };

export interface ScriptedResponse {
  blocks: ScriptedBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
}

export interface FakeClaude {
  /** An Anthropic client pointed at the fake. */
  anthropic: Anthropic;
  /** The JSON bodies and beta headers of the requests received, in order. */
  requests: { body: Record<string, unknown>; betas: string | undefined }[];
}

function sse(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
}

/** The Messages API stream events for one scripted response. */
function streamEvents(response: ScriptedResponse, index: number): string {
  const events = [
    sse('message_start', {
      message: {
        id: `msg_${index}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
  ];
  response.blocks.forEach((block, position) => {
    if (block.type === 'text') {
      events.push(sse('content_block_start', { index: position, content_block: { type: 'text', text: '' } }));
      events.push(
        sse('content_block_delta', { index: position, delta: { type: 'text_delta', text: block.text } }),
      );
    } else {
      const id = `toolu_${index}_${position}`;
      events.push(
        sse('content_block_start', {
          index: position,
          content_block: { type: 'tool_use', id, name: block.name, input: {} },
        }),
      );
      events.push(
        sse('content_block_delta', {
          index: position,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        }),
      );
    }
    events.push(sse('content_block_stop', { index: position }));
  });
  events.push(
    sse('message_delta', {
      delta: { stop_reason: response.stopReason, stop_sequence: null },
      usage: { output_tokens: 20 },
    }),
  );
  events.push(sse('message_stop', {}));
  return events.join('');
}

/**
 * A stand-in for the Messages API that streams the scripted responses in order, one per request,
 * and answers 500 once the script runs out.
 */
export async function startFakeClaude(script: ScriptedResponse[]): Promise<FakeClaude> {
  const requests: FakeClaude['requests'] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      requests.push({ body: JSON.parse(body), betas: req.headers['anthropic-beta'] as string | undefined });
      const response = script[requests.length - 1];
      if (!response) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'script exhausted' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(streamEvents(response, requests.length));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanup(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as AddressInfo;
  return {
    anthropic: new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 }),
    requests,
  };
}
