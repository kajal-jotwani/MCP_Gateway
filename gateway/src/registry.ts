import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';

import { exposeToolNames } from './toolNames.js';
import type { ExposedTool } from './toolNames.js';

export type UpstreamStatus = 'connected' | 'unreachable' | 'disabled';

export interface UpstreamConfig {
  id: string;
  slug: string;
  name: string;
  url: string;
  /** Sent as a header on every request to the upstream. Never leaves the gateway. */
  credential?: { header: string; value: string };
  enabled: boolean;
}

export interface UpstreamState {
  status: UpstreamStatus;
  /** Why the upstream is unreachable, with no URL or credential in it. */
  error?: string;
  checkedAt?: Date;
  /** Last known tools under the names clients see. Empty while disabled. */
  tools: ExposedTool[];
}

export interface RegistryTimeouts {
  connectMs: number;
  listMs: number;
  callMs: number;
}

/** A tool the gateway can route, with the upstream name that error messages and audit entries use. */
export interface RoutedTool extends ExposedTool {
  upstreamName: string;
}

/** A failed upstream call. The message is safe to show to clients and to the model. */
export class UpstreamCallError extends Error {
  constructor(
    readonly outcome: 'failed' | 'timed_out',
    message: string,
  ) {
    super(message);
  }
}

interface Connection {
  config: UpstreamConfig;
  client?: Client;
  status: UpstreamStatus;
  error?: string;
  checkedAt?: Date;
  tools: Tool[];
  refreshing?: Promise<void>;
}

// Upstream tool definitions and results are untrusted. These caps keep one server from filling the
// model's context or the gateway's memory.
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_RESULT_BYTES = 1_000_000;
const MAX_UPSTREAM_ERROR_LENGTH = 500;

/**
 * Holds one long-lived MCP client per enabled upstream, its status and its last known tools.
 * Client-facing listing is served from this state and never waits on an upstream.
 */
export class UpstreamRegistry {
  private readonly connections = new Map<string, Connection>();
  private readonly toolsChangedListeners: (() => void)[] = [];
  /** Tools of every enabled upstream, including unreachable ones, so names stay stable while one is down. */
  private routable = new Map<string, RoutedTool>();
  private visible: RoutedTool[] = [];
  private visibleSignature = '[]';

  constructor(private readonly timeouts: RegistryTimeouts) {}

  /** Registers a listener that runs whenever the tools clients can see change. */
  onToolsChanged(listener: () => void): void {
    this.toolsChangedListeners.push(listener);
  }

  /**
   * Applies the configured upstreams: connects new, re-enabled and edited ones, and closes removed
   * and disabled ones. Resolves once every upstream that changed has been checked.
   */
  async sync(configs: UpstreamConfig[]): Promise<void> {
    const configured = new Set(configs.map((config) => config.id));
    for (const [id, connection] of this.connections) {
      if (configured.has(id)) continue;
      this.connections.delete(id);
      this.disconnect(connection);
    }

    const checks: Promise<void>[] = [];
    for (const config of configs) {
      const existing = this.connections.get(config.id);
      if (existing && !endpointChanged(existing.config, config)) {
        existing.config = config;
        continue;
      }
      // A new object per endpoint, so a check still running against the old endpoint cannot write
      // its result over the new one.
      if (existing) this.disconnect(existing);
      const connection: Connection = {
        config,
        status: config.enabled ? 'unreachable' : 'disabled',
        tools: [],
      };
      this.connections.set(config.id, connection);
      if (config.enabled) checks.push(this.refresh(connection));
    }
    this.publish();
    await Promise.all(checks);
  }

  /** Re-lists tools on every enabled upstream in parallel. Each upstream costs at most its own timeouts. */
  async refreshAll(): Promise<void> {
    const enabled = [...this.connections.values()].filter((connection) => connection.config.enabled);
    await Promise.all(enabled.map((connection) => this.refresh(connection)));
  }

  /** The tools clients can call now: those of connected upstreams, sorted by name. */
  listTools(): RoutedTool[] {
    return this.visible;
  }

  /** Maps an exposed name back to its upstream. Undefined for names no enabled upstream has. */
  resolve(name: string): RoutedTool | undefined {
    return this.routable.get(name);
  }

  /** Status and tools of every configured upstream, keyed by upstream id. */
  states(): Map<string, UpstreamState> {
    const tools = [...this.routable.values()];
    return new Map(
      [...this.connections.values()].map(({ config, status, error, checkedAt }) => [
        config.id,
        { status, error, checkedAt, tools: tools.filter((tool) => tool.upstreamId === config.id) },
      ]),
    );
  }

  /**
   * Calls a tool on its upstream with the upstream's own credential and the call timeout.
   * Throws UpstreamCallError on timeout, transport failure or an upstream protocol error. A transport
   * failure marks the upstream unreachable right away instead of at the next refresh.
   */
  async callTool(
    tool: RoutedTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const connection = this.connections.get(tool.upstreamId);
    const client = connection?.client;
    if (!connection || !client || connection.status !== 'connected') {
      throw new UpstreamCallError('failed', `Upstream "${tool.upstreamName}" is unreachable.`);
    }
    let result: CallToolResult;
    try {
      result = await client.callTool(
        { name: tool.originalName, arguments: args },
        { timeout: this.timeouts.callMs, signal },
      );
    } catch (error) {
      throw this.toCallError(connection, client, tool.upstreamName, error, signal);
    }
    return forwardedResult(result, tool.upstreamName);
  }

  /** Closes every upstream client. */
  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map((connection) => connection.client?.close()));
  }

  private refresh(connection: Connection): Promise<void> {
    // Concurrent triggers (the refresh loop, an admin edit, a change notification) share one check.
    connection.refreshing ??= this.check(connection).finally(() => {
      connection.refreshing = undefined;
    });
    return connection.refreshing;
  }

  private async check(connection: Connection): Promise<void> {
    const started = Date.now();
    try {
      connection.client ??= await this.connect(connection);
      const { tools } = await connection.client.listTools(undefined, {
        timeout: this.timeouts.listMs,
        cacheMode: 'refresh',
      });
      if (!this.isCurrent(connection)) return this.disconnect(connection);
      connection.tools = tools.map(storedTool);
      this.setStatus(connection, 'connected', undefined, started);
    } catch (error) {
      this.disconnect(connection);
      if (!this.isCurrent(connection)) return;
      this.setStatus(connection, 'unreachable', describeFailure(error), started);
    }
    connection.checkedAt = new Date();
    this.publish();
  }

  private async connect(connection: Connection): Promise<Client> {
    const { url, credential } = connection.config;
    const client = new Client(
      { name: 'urumi-gateway', version: '1.0.0' },
      {
        versionNegotiation: { mode: 'auto' },
        // The registry lists tools itself, so a change notification only needs to trigger a check.
        listChanged: { tools: { autoRefresh: false, onChanged: () => void this.refresh(connection) } },
      },
    );
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      // redirect: 'error' keeps the credential from following a redirect to another host.
      requestInit: {
        headers: credential ? { [credential.header]: credential.value } : {},
        redirect: 'error',
      },
    });
    await client.connect(transport, { timeout: this.timeouts.connectMs });
    // A dropped change-notification stream usually means the upstream went away. Checking right away
    // marks it unreachable without waiting for the next refresh, or reconnects with a new stream.
    void client.autoOpenedSubscription?.closed.then((reason) => {
      if (reason !== 'remote' || connection.client !== client) return;
      this.disconnect(connection);
      void this.refresh(connection);
    });
    return client;
  }

  private toCallError(
    connection: Connection,
    client: Client,
    upstreamName: string,
    error: unknown,
    signal: AbortSignal | undefined,
  ): UpstreamCallError {
    if (signal?.aborted) return new UpstreamCallError('failed', 'The call was cancelled by the client.');
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
      return new UpstreamCallError(
        'timed_out',
        `Upstream "${upstreamName}" did not respond within ${this.timeouts.callMs / 1000} s.`,
      );
    }
    if (error instanceof ProtocolError) {
      const message = error.message.slice(0, MAX_UPSTREAM_ERROR_LENGTH);
      return new UpstreamCallError('failed', `Upstream "${upstreamName}" returned an error: ${message}`);
    }
    if (error instanceof SdkError && error.code === SdkErrorCode.InvalidResult) {
      return new UpstreamCallError('failed', `Upstream "${upstreamName}" returned an invalid result.`);
    }
    if (connection.client === client && this.isCurrent(connection)) {
      this.disconnect(connection);
      this.setStatus(connection, 'unreachable', describeFailure(error), Date.now());
      connection.checkedAt = new Date();
      this.publish();
    }
    return new UpstreamCallError('failed', `Upstream "${upstreamName}" is unreachable.`);
  }

  private isCurrent(connection: Connection): boolean {
    return this.connections.get(connection.config.id) === connection;
  }

  private disconnect(connection: Connection): void {
    const { client } = connection;
    if (!client) return;
    connection.client = undefined;
    client.close().catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: 'upstream_close_failed',
          upstream: connection.config.slug,
          reason: describeFailure(error),
        }),
      );
    });
  }

  private setStatus(
    connection: Connection,
    status: UpstreamStatus,
    error: string | undefined,
    started: number,
  ): void {
    if (connection.status !== status || connection.error !== error) {
      console.log(
        JSON.stringify({
          event: 'upstream_status',
          upstream: connection.config.slug,
          status,
          reason: error,
          durationMs: Date.now() - started,
        }),
      );
    }
    connection.status = status;
    connection.error = error;
  }

  /** Recomputes exposed names and notifies listeners when the tools clients can see changed. */
  private publish(): void {
    const enabled = [...this.connections.values()].filter((connection) => connection.config.enabled);
    const names = new Map(enabled.map(({ config }) => [config.id, config.name]));
    const exposed = exposeToolNames(
      enabled.map(({ config, tools }) => ({ upstreamId: config.id, slug: config.slug, tools })),
    ).map((tool) => ({ ...tool, upstreamName: names.get(tool.upstreamId) ?? '' }));
    const connected = new Set(enabled.filter((c) => c.status === 'connected').map((c) => c.config.id));

    this.routable = new Map(exposed.map((tool) => [tool.name, tool]));
    this.visible = exposed.filter((tool) => connected.has(tool.upstreamId));
    const signature = JSON.stringify(this.visible);
    if (signature === this.visibleSignature) return;
    this.visibleSignature = signature;
    for (const listener of this.toolsChangedListeners) listener();
  }
}

function endpointChanged(previous: UpstreamConfig, next: UpstreamConfig): boolean {
  return (
    previous.url !== next.url ||
    previous.enabled !== next.enabled ||
    previous.credential?.header !== next.credential?.header ||
    previous.credential?.value !== next.credential?.value
  );
}

/** Keeps only the fields clients need from an upstream tool definition, with a capped description. */
function storedTool(tool: Tool): Tool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description?.slice(0, MAX_DESCRIPTION_LENGTH),
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  };
}

/** Passes on content, structured content and the error flag; drops the upstream's _meta. */
function forwardedResult(result: CallToolResult, upstreamName: string): CallToolResult {
  const forwarded: CallToolResult = { content: result.content };
  if (result.structuredContent !== undefined) forwarded.structuredContent = result.structuredContent;
  if (result.isError) forwarded.isError = true;
  if (Buffer.byteLength(JSON.stringify(forwarded)) > MAX_RESULT_BYTES) {
    throw new UpstreamCallError('failed', `Upstream "${upstreamName}" returned a result larger than 1 MB.`);
  }
  return forwarded;
}

/** A short reason for the dashboard and logs. Never includes URLs, headers or credentials. */
function describeFailure(error: unknown): string {
  if (error instanceof SdkHttpError) {
    return error.status === 401 || error.status === 403
      ? `rejected the gateway's credential (HTTP ${error.status})`
      : `HTTP ${error.status}`;
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) return 'timed out';
  if (error instanceof ProtocolError) return `protocol error ${error.code}`;
  return 'connection failed';
}
