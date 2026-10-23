import { useCallback, useEffect, useState } from 'react';

import { api, useAction } from './api';
import type { AuditEntry, Member, Outcome } from './api';
import { ErrorText, formatTime } from './ui';

const PAGE_SIZE = 50;

const OUTCOME_LABELS: Record<Outcome, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  timed_out: 'Timed out',
  rejected: 'Rejected',
};

function caller(entry: AuditEntry): string {
  if (entry.memberEmail) return entry.memberEmail;
  // A rejected request whose key matched no active member.
  return entry.keyPrefix ? `unknown key urk_${entry.keyPrefix}…` : 'no key';
}

/** Every tool call, newest first. Admins see the whole team's calls; members see their own. */
export function AuditPage({ member }: { member: Member }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const { busy, error, run } = useAction();

  const load = useCallback(
    (before?: string) =>
      run(async () => {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE), ...(before && { before }) });
        const page = await api<{ entries: AuditEntry[] }>('GET', `/audit?${query}`);
        setEntries((current) => (before ? [...current, ...page.entries] : page.entries));
        setHasMore(page.entries.length === PAGE_SIZE);
      }),
    [run],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="row spread">
        <p className="muted">
          {member.role === 'admin' ? 'Tool calls by every member.' : 'Your tool calls.'} Rejected requests,
          such as a revoked key, are listed too.
        </p>
        <button type="button" disabled={busy} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <ErrorText message={error} />
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Member</th>
            <th>Via</th>
            <th>Server</th>
            <th>Tool</th>
            <th>Outcome</th>
            <th>Duration</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{formatTime(entry.at)}</td>
              <td>{caller(entry)}</td>
              <td>{entry.via === 'chat' ? 'Chat' : 'MCP client'}</td>
              <td>{entry.upstreamName ?? '–'}</td>
              <td>{entry.tool ? <code>{entry.tool}</code> : '–'}</td>
              <td>
                <span className={`badge ${entry.outcome}`}>{OUTCOME_LABELS[entry.outcome]}</span>
              </td>
              <td>{entry.durationMs} ms</td>
              <td className="description">{entry.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {entries.length === 0 && !busy && <p className="muted">No tool calls yet.</p>}
      {hasMore && (
        <button type="button" disabled={busy} onClick={() => void load(entries.at(-1)?.id)}>
          Load older entries
        </button>
      )}
    </>
  );
}
