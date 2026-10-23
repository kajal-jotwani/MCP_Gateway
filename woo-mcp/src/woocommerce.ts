import { randomBytes } from 'node:crypto';

import type { WooMcpConfig } from './config.js';
import { signQuery } from './oauth1.js';

// Below the gateway's 30 s call timeout, so the model gets this server's clearer message first.
const STORE_TIMEOUT_MS = 20_000;

/** A store failure whose message is safe to show to an MCP client and the model. */
export class StoreError extends Error {}

export interface StoreResponse {
  body: unknown;
  /** From WooCommerce's X-WP-TotalPages header on list endpoints. */
  totalPages: number | undefined;
}

export interface StoreRequest {
  method: 'GET' | 'POST' | 'PUT';
  /** Path below /wp-json/wc/v3/, such as `orders/42`. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  signal: AbortSignal;
}

export type StoreClient = (request: StoreRequest) => Promise<StoreResponse>;

/**
 * Creates a client for the WooCommerce REST API v3 that signs every request with OAuth 1.0a.
 * Throws StoreError for timeouts, connection failures, non-2xx answers and non-JSON bodies.
 * Logs one line per request with method, path, status and duration.
 */
export function createStoreClient(config: WooMcpConfig): StoreClient {
  return async ({ method, path, query = {}, body, signal }) => {
    const restPath = `/wp-json/wc/v3/${path}`;
    // WooCommerce signs against its home URL with the scheme of the request it received. The request
    // goes to the in-cluster Service over plain HTTP, so the scheme comes from the API URL.
    const signatureUrl = new URL(restPath, config.siteUrl);
    signatureUrl.protocol = config.apiUrl.protocol;
    const url = new URL(restPath, config.apiUrl);
    const signed = signQuery(
      method,
      signatureUrl.href,
      query,
      config,
      Math.floor(Date.now() / 1000),
      randomBytes(16).toString('hex'),
    );
    for (const [key, value] of Object.entries(signed)) url.searchParams.set(key, value);

    const started = performance.now();
    let status = 0;
    try {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(STORE_TIMEOUT_MS)]),
      });
      status = response.status;
      const text = await response.text();
      if (!response.ok) {
        throw new StoreError(
          `The store rejected the request (HTTP ${response.status}): ${wooErrorMessage(text)}`,
        );
      }
      const totalPages = response.headers.get('x-wp-totalpages');
      return { body: parseJson(text), totalPages: totalPages === null ? undefined : Number(totalPages) };
    } catch (error) {
      if (error instanceof StoreError || signal.aborted) throw error;
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new StoreError(`The store did not respond within ${STORE_TIMEOUT_MS / 1000} s.`);
      }
      throw new StoreError('The store is unreachable.');
    } finally {
      const durationMs = Math.round(performance.now() - started);
      console.log(JSON.stringify({ event: 'store_request', method, path, status, durationMs }));
    }
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new StoreError('The store returned a response that is not JSON.');
  }
}

/** WooCommerce errors look like {"code": "...", "message": "..."}; anything else is not passed on. */
function wooErrorMessage(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'message' in parsed &&
      typeof parsed.message === 'string'
    ) {
      return parsed.message.slice(0, 300);
    }
  } catch {
    // Not JSON, for example an HTML error page from a proxy.
  }
  return 'no details';
}
