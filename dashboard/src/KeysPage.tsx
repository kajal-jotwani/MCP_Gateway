import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { api, useAction, useApi } from './api';
import type { ApiKey, Member } from './api';
import { CopyField, ErrorText, formatTime } from './ui';

/** A member's own API keys. Admins can also see everyone's, and issue and revoke keys for anyone. */
export function KeysPage({ member: me }: { member: Member }) {
  const isAdmin = me.role === 'admin';
  const [showAll, setShowAll] = useState(false);
  const keys = useApi<{ keys: ApiKey[] }>(showAll ? '/keys?memberId=all' : '/keys');
  // Only admins can read the member list, which names key owners and whom a new key is for.
  const members = useApi<{ members: Member[] }>(isAdmin ? '/members' : undefined).data?.members ?? [me];

  return (
    <>
      <p className="muted">
        An API key lets an MCP client such as Claude Code, Cursor or MCP Inspector call tools as you. Every
        call is in the audit log under your name. A revoked key stops working on its next request.
      </p>
      {isAdmin ? (
        <AdminKeyForm me={me} members={members} onCreated={keys.reload} />
      ) : (
        <KeyForm memberId={me.id} onCreated={keys.reload} />
      )}
      <div className="row spread">
        <h2>{showAll ? 'All keys' : 'Your keys'}</h2>
        {isAdmin && (
          <label className="inline">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Show every member&apos;s keys
          </label>
        )}
      </div>
      <ErrorText message={keys.error} />
      {keys.data?.keys.length === 0 && <p className="muted">No keys yet.</p>}
      {keys.data && keys.data.keys.length > 0 && (
        <KeyTable keys={keys.data.keys} owners={showAll ? members : undefined} onChanged={keys.reload} />
      )}
    </>
  );
}

function AdminKeyForm({ me, members, onCreated }: { me: Member; members: Member[]; onCreated: () => void }) {
  const [memberId, setMemberId] = useState(me.id);
  const activeMembers = members.filter((member) => member.active);
  return (
    <KeyForm memberId={memberId} onCreated={onCreated}>
      <label>
        For
        <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
          {activeMembers.map((member) => (
            <option key={member.id} value={member.id}>
              {member.id === me.id ? 'Yourself' : `${member.name} (${member.email})`}
            </option>
          ))}
        </select>
      </label>
    </KeyForm>
  );
}

function KeyForm({
  memberId,
  onCreated,
  children,
}: {
  memberId: string;
  onCreated: () => void;
  children?: ReactNode;
}) {
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState<string>();
  const { busy, error, run } = useAction();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const created = await api<{ key: string }>('POST', '/keys', { name, memberId });
      setNewKey(created.key);
      setName('');
      onCreated();
    });
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Create a key</h2>
      <div className="row">
        <label className="grow">
          Name (where you will use it)
          <input
            required
            maxLength={100}
            placeholder="laptop, Cursor"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {children}
      </div>
      <ErrorText message={error} />
      <button type="submit" disabled={busy}>
        Create key
      </button>
      {newKey && (
        <>
          <p>Copy the key now. The gateway stores only its hash and cannot show it again.</p>
          <CopyField label="New API key" value={newKey} />
        </>
      )}
    </form>
  );
}

/** Lists keys, with an owner column when `owners` is given. */
function KeyTable({ keys, owners, onChanged }: { keys: ApiKey[]; owners?: Member[]; onChanged: () => void }) {
  const emails = new Map(owners?.map((member) => [member.id, member.email]));
  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          {owners && <th>Member</th>}
          <th>Key</th>
          <th>Created</th>
          <th>Last used</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((apiKey) => (
          <KeyRow
            key={apiKey.id}
            apiKey={apiKey}
            owner={owners && (emails.get(apiKey.memberId) ?? 'removed member')}
            onChanged={onChanged}
          />
        ))}
      </tbody>
    </table>
  );
}

function KeyRow({ apiKey, owner, onChanged }: { apiKey: ApiKey; owner?: string; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  const revoke = () => {
    if (!window.confirm(`Revoke ${apiKey.name}? Clients using it are rejected from their next request.`))
      return;
    void run(async () => {
      await api('DELETE', `/keys/${apiKey.id}`);
      onChanged();
    });
  };
  return (
    <tr>
      <td>{apiKey.name}</td>
      {owner !== undefined && <td>{owner}</td>}
      <td>
        <code>urk_{apiKey.displayPrefix}…</code>
      </td>
      <td>{formatTime(apiKey.createdAt)}</td>
      <td>{formatTime(apiKey.lastUsedAt)}</td>
      <td>
        {apiKey.revokedAt ? (
          `Revoked ${formatTime(apiKey.revokedAt)}`
        ) : (
          <button type="button" className="danger" disabled={busy} onClick={revoke}>
            Revoke
          </button>
        )}
        <ErrorText message={error} />
      </td>
    </tr>
  );
}
