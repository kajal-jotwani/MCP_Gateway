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

export type AuthType = 'none' | 'bearer' | 'header';
export type UpstreamStatus = 'connected' | 'unreachable' | 'disabled';

export interface UpstreamTool {
  name: string;
  originalName: string;
  title: string | null;
  description: string | null;
}

/** An upstream server. url, authType and authHeaderName are only sent to admins. */
export interface Upstream {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  url?: string;
  authType?: AuthType;
  authHeaderName?: string | null;
  status: UpstreamStatus;
  error: string | null;
  checkedAt: string | null;
  tools: UpstreamTool[];
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

/** An error response from the gateway, with the message it chose to show. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Calls the gateway's dashboard API with the session cookie and the header its CSRF check wants.
 * Throws ApiError with the gateway's message when the response is not 2xx.
 */
export async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      'x-requested-with': 'urumi-dashboard',
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok)
    throw new ApiError(response.status, payload.error ?? `Request failed (HTTP ${response.status}).`);
  return payload as T;
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
