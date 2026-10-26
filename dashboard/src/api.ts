import { useCallback, useEffect, useState } from 'react';

export type Role = 'admin' | 'member';

export interface Member {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

export interface ApiKey {
  id: string;
  memberId: string;
  name: string;
  displayPrefix: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** An app a member allowed through OAuth. `label` is what the audit log shows for its calls. */
export interface OAuthGrant {
  id: string;
  memberId: string;
  clientName: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type AuthType = 'none' | 'bearer' | 'header';
export type UpstreamStatus = 'connected' | 'unreachable' | 'disabled';

export interface UpstreamTool {
  name: string;
  originalName: string;
  title: string | null;
  description: string | null;
  /** Sent to admins only: members cannot see or call the tool. */
  adminOnly?: boolean;
}

/** Calls to one server in the last 24 hours. */
export interface UpstreamStats {
  calls: number;
  errors: number;
  timedOut: number;
  rejected: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** An upstream server. url, authType, authHeaderName, stats and adminOnly are only sent to admins. */
export interface Upstream {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  url?: string;
  authType?: AuthType;
  authHeaderName?: string | null;
  stats?: UpstreamStats;
  /** Sent to admins only: members cannot see the server or call its tools. */
  adminOnly?: boolean;
  status: UpstreamStatus;
  error: string | null;
  checkedAt: string | null;
  tools: UpstreamTool[];
  /** Set on a provisioned store's server, which is changed through its store. */
  storeId: string | null;
}

export type StoreStatus = 'provisioning' | 'ready' | 'failed' | 'deleting';

export interface Store {
  id: string;
  slug: string;
  name: string;
  url: string;
  ownerId: string;
  ownerName: string;
  status: StoreStatus;
  reason: string | null;
  createdAt: string;
}

export type Outcome = 'succeeded' | 'failed' | 'timed_out' | 'rejected';

export interface AuditEntry {
  id: string;
  at: string;
  memberId: string | null;
  memberEmail: string | null;
  keyPrefix: string | null;
  via: 'mcp' | 'chat';
  upstreamName: string | null;
  tool: string | null;
  durationMs: number;
  outcome: Outcome;
  reason: string | null;
}

/** What /api/chat streams, one JSON object per line. */
export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; server: string | null; input: unknown }
  | { type: 'tool_result'; id: string; isError: boolean; preview: string }
  // discardText: the text streamed since the last tool call is part of a declined answer.
  | { type: 'error'; message: string; discardText?: true }
  | { type: 'done' };

/** An error response from the gateway, with the message it chose to show. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Sends a request to the gateway's dashboard API with the session cookie and the header its CSRF
 * check wants. Throws ApiError with the gateway's message when the response is not 2xx.
 */
export async function apiResponse(
  method: Method,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      'x-requested-with': 'urumi-dashboard',
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, payload.error ?? `Request failed (HTTP ${response.status}).`);
  }
  return response;
}

/** Calls the dashboard API and returns its JSON body, or undefined for a 204. */
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const response = await apiResponse(method, path, body);
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/**
 * Loads a GET endpoint, and again every pollMs when given; nothing while path is undefined. `reload`
 * fetches it now, for example after a change. A failed load keeps the last data and sets `error`.
 */
export function useApi<T>(
  path: string | undefined,
  pollMs?: number,
): { data?: T; error?: string; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (path === undefined) return;
    let cancelled = false;
    const load = () =>
      api<T>('GET', path).then(
        (loaded) => {
          if (cancelled) return;
          setData(loaded);
          setError(undefined);
        },
        (failure: Error) => {
          if (!cancelled) setError(failure.message);
        },
      );
    void load();
    const timer = pollMs ? setInterval(load, pollMs) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path, pollMs, version]);

  const reload = useCallback(() => setVersion((current) => current + 1), []);
  return { data, error, reload };
}

/**
 * Runs a change against the API, such as a form submit, tracking whether it is in flight and the
 * error message of the last failure. `run` resolves to whether the change succeeded.
 */
export function useAction(): {
  busy: boolean;
  error?: string;
  run: (change: () => Promise<void>) => Promise<boolean>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = useCallback(async (change: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await change();
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}
