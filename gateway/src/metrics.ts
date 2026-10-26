import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

import type { Outcome, Via } from './audit.js';
import type { UpstreamState } from './registry.js';

// Metrics live for the whole process, like the upstream registry. Each replica reports its own calls;
// Prometheus sums them.
const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

// Label for calls that never reached an upstream, such as an unknown tool or a refused API key.
const NO_UPSTREAM = 'none';

const toolCalls = new Counter({
  name: 'gateway_tool_calls_total',
  help: 'Tool calls by upstream slug, outcome and whether they came over MCP or from the chat agent.',
  labelNames: ['upstream', 'outcome', 'via'],
  registers: [metricsRegistry],
});

const toolCallDuration = new Histogram({
  name: 'gateway_tool_call_duration_seconds',
  help: 'Duration of tool calls that reached an upstream, by upstream slug.',
  labelNames: ['upstream'],
  // The call timeout is 30 s, so the last bucket holds the timed-out calls.
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

let upstreamStates: () => Iterable<UpstreamState> = () => [];

new Gauge({
  name: 'gateway_upstream_up',
  help: '1 while the gateway reaches the upstream, 0 while it is unreachable. Disabled upstreams are left out.',
  labelNames: ['upstream'],
  registers: [metricsRegistry],
  collect() {
    this.reset();
    for (const state of upstreamStates()) {
      if (state.status !== 'disabled')
        this.set({ upstream: state.slug }, state.status === 'connected' ? 1 : 0);
    }
  },
});

/** Makes gateway_upstream_up report the states `source` returns at each scrape. */
export function reportUpstreamStates(source: () => Iterable<UpstreamState>): void {
  upstreamStates = source;
}

/** Counts one tool call. `upstream` is the slug, or undefined when the call reached no upstream. */
export function recordToolCall(call: {
  upstream: string | undefined;
  outcome: Outcome;
  via: Via;
  durationMs: number;
}): void {
  const upstream = call.upstream ?? NO_UPSTREAM;
  toolCalls.inc({ upstream, outcome: call.outcome, via: call.via });
  if (call.upstream && call.outcome !== 'rejected') {
    toolCallDuration.observe({ upstream }, call.durationMs / 1000);
  }
}

/**
 * Serves GET /metrics in the Prometheus text format on its own port, so the Ingress, which routes
 * only the main port, never exposes it.
 */
export function startMetricsServer(port: number): Server {
  return createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    metricsRegistry.metrics().then(
      (body) => res.writeHead(200, { 'content-type': metricsRegistry.contentType }).end(body),
      (error: unknown) => {
        console.error(JSON.stringify({ event: 'metrics_failed', message: (error as Error).message }));
        res.writeHead(500).end();
      },
    );
  }).listen(port);
}
