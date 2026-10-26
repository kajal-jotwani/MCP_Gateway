import { useState } from 'react';
import type { FormEvent } from 'react';

import { api, useAction, useApi } from './api';
import type { AuthType, Member, Upstream, UpstreamStats, UpstreamStatus, UpstreamTool } from './api';
import { ErrorText, formatTime } from './ui';

// Matches the gateway's refresh loop closely enough that a dead server shows as Unreachable within
// seconds of the gateway noticing.
const POLL_MS = 5000;

const COLLAPSE_AFTER = 10;

const STATUS_LABELS: Record<UpstreamStatus, string> = {
  connected: 'Connected',
  unreachable: 'Unreachable',
  disabled: 'Disabled',
};

export function ServersPage({ member }: { member: Member }) {
  const { data, error, reload } = useApi<{ upstreams: Upstream[] }>('/upstreams', POLL_MS);
  const [adding, setAdding] = useState(false);
  const isAdmin = member.role === 'admin';

  return (
    <>
      <p className="muted">
        Every tool of a connected server is available through the gateway&apos;s one MCP endpoint and in the
        chat. A tool name gets the server&apos;s slug in front of it when two servers have a tool with the
        same name, and always for a store created on the Stores page.
      </p>
      <ErrorText message={error} />
      {isAdmin &&
        (adding ? (
          <ServerForm
            onDone={() => {
              setAdding(false);
              reload();
            }}
          />
        ) : (
          <button type="button" onClick={() => setAdding(true)}>
            Add server
          </button>
        ))}
      {data?.upstreams.length === 0 && <p>No servers are registered.</p>}
      {data?.upstreams.map((upstream) => (
        <ServerCard key={upstream.id} upstream={upstream} isAdmin={isAdmin} onChanged={reload} />
      ))}
    </>
  );
}

function describeCredential(upstream: Upstream): string {
  if (upstream.authType === 'bearer') return 'Bearer token (stored, never shown)';
  if (upstream.authType === 'header') return `${upstream.authHeaderName} header (stored, never shown)`;
  return 'No credential';
}

function describeStats(stats: UpstreamStats): string {
  if (stats.calls === 0) return 'No calls in the last 24 hours.';
  const answered = stats.calls - stats.rejected;
  const parts = [`${stats.calls} call${stats.calls === 1 ? '' : 's'} in the last 24 hours`];
  if (answered > 0) {
    const errorRate = ((stats.errors / answered) * 100).toFixed(1);
    parts.push(`${errorRate}% errors${stats.timedOut ? ` (${stats.timedOut} timed out)` : ''}`);
    parts.push(`p50 ${stats.p50Ms} ms, p95 ${stats.p95Ms} ms`);
  }
  if (stats.rejected) parts.push(`${stats.rejected} rejected`);
  return parts.join(' · ');
}

function renameReason(tool: UpstreamTool, upstream: Upstream): string {
  if (upstream.storeId && tool.name === `${upstream.slug}__${tool.originalName}`) {
    return 'Prefixed with the store’s slug, so the name says which store it acts on.';
  }
  return tool.name.endsWith(`__${tool.originalName}`)
    ? `Prefixed because another server also has a tool named ${tool.originalName}.`
    : `Renamed from ${tool.originalName} to fit the characters and length MCP clients accept.`;
}

function ServerCard({
  upstream,
  isAdmin,
  onChanged,
}: {
  upstream: Upstream;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction();

  const setEnabled = (enabled: boolean) =>
    run(async () => {
      await api('PATCH', `/upstreams/${upstream.id}`, { enabled });
      onChanged();
    });
  const remove = () => {
    if (!window.confirm(`Remove ${upstream.name}? Its tools disappear for every member and client.`)) return;
    void run(async () => {
      await api('DELETE', `/upstreams/${upstream.id}`);
      onChanged();
    });
  };

  if (editing) {
    return (
      <ServerForm
        existing={upstream}
        onDone={() => {
          setEditing(false);
          onChanged();
        }}
      />
    );
  }

  return (
    <section className="card">
      <div className="row spread">
        <h2>
          {upstream.name} <code className="muted">{upstream.slug}</code>
        </h2>
        <span className={`badge ${upstream.status}`}>{STATUS_LABELS[upstream.status]}</span>
      </div>
      {upstream.error && <p className="error">{upstream.error}</p>}
      {isAdmin && (
        <p className="muted">
          <code>{upstream.url}</code> · {describeCredential(upstream)}
        </p>
      )}
      <p className="muted">Last checked: {formatTime(upstream.checkedAt)}</p>
      {upstream.stats && <p className="muted">{describeStats(upstream.stats)}</p>}
      {upstream.storeId && (
        <p className="muted">Registered by its store. Delete the store on the Stores page to remove it.</p>
      )}
      {isAdmin && (
        <div className="row">
          {!upstream.storeId && (
            <button type="button" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void setEnabled(!upstream.enabled)}>
            {upstream.enabled ? 'Disable' : 'Enable'}
          </button>
          {!upstream.storeId && (
            <button type="button" className="danger" disabled={busy} onClick={remove}>
              Remove
            </button>
          )}
          {busy && <span className="muted">Saving and reconnecting…</span>}
        </div>
      )}
      <ErrorText message={error} />
      {upstream.tools.length > 0 && (
        // Long lists start folded so the page stays scannable with several servers.
        <details open={upstream.tools.length <= COLLAPSE_AFTER}>
          <summary>
            {upstream.tools.length} tool{upstream.tools.length === 1 ? '' : 's'}
            {upstream.status === 'unreachable' &&
              ', last known; hidden from clients until the server is back'}
          </summary>
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {upstream.tools.map((tool) => (
                <tr key={tool.name}>
                  <td>
                    <code>{tool.name}</code>
                    {tool.name !== tool.originalName && (
                      <div className="muted">{renameReason(tool, upstream)}</div>
                    )}
                  </td>
                  <td className="description">{tool.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

/** Adds a server, or edits one when `existing` is given. Secrets are write-only: an empty field keeps the stored one. */
function ServerForm({ existing, onDone }: { existing?: Upstream; onDone: () => void }) {
  const [name, setName] = useState(existing?.name ?? '');
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [authType, setAuthType] = useState<AuthType>(existing?.authType ?? 'none');
  const [headerName, setHeaderName] = useState(existing?.authHeaderName ?? '');
  const [secret, setSecret] = useState('');
  const { busy, error, run } = useAction();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const auth =
      authType === 'none'
        ? { type: 'none' }
        : { type: authType, secret: secret || undefined, ...(authType === 'header' && { headerName }) };
    const body = { name, url, auth, ...(slug && { slug }) };
    void run(async () => {
      if (existing) await api('PATCH', `/upstreams/${existing.id}`, body);
      else await api('POST', '/upstreams', body);
      onDone();
    });
  };

  const keepsSecret = existing && existing.authType !== 'none' && url === existing.url;
  return (
    <form className="card" onSubmit={submit}>
      <h2>{existing ? `Edit ${existing.name}` : 'Add a server'}</h2>
      <label>
        Name
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Slug (used as the tool prefix on name collisions; 2-16 of a-z, 0-9 and -)
        <input
          pattern="[a-z0-9-]{2,16}"
          placeholder={existing ? undefined : 'derived from the name'}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        />
      </label>
      <label>
        MCP endpoint URL (Streamable HTTP)
        <input
          type="url"
          required
          placeholder="http://notes-mcp.gateway.svc.cluster.local:3000/mcp"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label>
        Credential
        <select value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
          <option value="none">None</option>
          <option value="bearer">Bearer token (Authorization header)</option>
          <option value="header">Custom header</option>
        </select>
      </label>
      {authType === 'header' && (
        <label>
          Header name
          <input
            required
            placeholder="x-api-key"
            value={headerName}
            onChange={(e) => setHeaderName(e.target.value)}
          />
        </label>
      )}
      {authType !== 'none' && (
        <label>
          {authType === 'bearer' ? 'Token' : 'Header value'}
          <input
            type="password"
            autoComplete="off"
            required={!keepsSecret}
            placeholder={keepsSecret ? 'Leave empty to keep the stored value' : undefined}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
      )}
      <ErrorText message={error} />
      <div className="row">
        <button type="submit" disabled={busy}>
          {existing ? 'Save' : 'Add server'}
        </button>
        <button type="button" disabled={busy} onClick={onDone}>
          Cancel
        </button>
        {busy && <span className="muted">Saving and connecting…</span>}
      </div>
    </form>
  );
}
