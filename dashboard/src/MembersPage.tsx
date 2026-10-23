import { useState } from 'react';
import type { FormEvent } from 'react';

import { api, useAction, useApi } from './api';
import type { Invite, Member, Role } from './api';
import { CopyField, ErrorText, formatTime } from './ui';

/** Admins only: invite people and change members' roles and access. */
export function MembersPage({ member: me }: { member: Member }) {
  const members = useApi<{ members: Member[] }>('/members');
  const invites = useApi<{ invites: Invite[] }>('/invites');

  return (
    <>
      <InviteForm onCreated={invites.reload} />
      <h2>Pending invites</h2>
      <ErrorText message={invites.error} />
      {invites.data?.invites.length === 0 && <p className="muted">No pending invites.</p>}
      {invites.data && invites.data.invites.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invites.data.invites.map((invite) => (
              <InviteRow key={invite.id} invite={invite} onChanged={invites.reload} />
            ))}
          </tbody>
        </table>
      )}

      <h2>Members</h2>
      <ErrorText message={members.error} />
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Access</th>
          </tr>
        </thead>
        <tbody>
          {members.data?.members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              isMe={member.id === me.id}
              onChanged={members.reload}
            />
          ))}
        </tbody>
      </table>
    </>
  );
}

function InviteForm({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [inviteUrl, setInviteUrl] = useState<string>();
  const { busy, error, run } = useAction();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const created = await api<{ inviteUrl: string }>('POST', '/invites', { email, role });
      setInviteUrl(created.inviteUrl);
      setEmail('');
      onCreated();
    });
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Invite someone</h2>
      <div className="row">
        <label className="grow">
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">Member (uses tools)</option>
            <option value="admin">Admin (also manages servers and members)</option>
          </select>
        </label>
      </div>
      <ErrorText message={error} />
      <button type="submit" disabled={busy}>
        Create invite link
      </button>
      {inviteUrl && (
        <>
          <p>
            Send this link to the person. It works once, expires in 72 hours, and is not shown again. The
            gateway sends no email.
          </p>
          <CopyField label="Invite link" value={inviteUrl} />
        </>
      )}
    </form>
  );
}

function InviteRow({ invite, onChanged }: { invite: Invite; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  const revoke = () =>
    run(async () => {
      await api('DELETE', `/invites/${invite.id}`);
      onChanged();
    });
  return (
    <tr>
      <td>{invite.email}</td>
      <td>{invite.role}</td>
      <td>{formatTime(invite.expiresAt)}</td>
      <td>
        <button type="button" disabled={busy} onClick={() => void revoke()}>
          Revoke
        </button>
        <ErrorText message={error} />
      </td>
    </tr>
  );
}

function MemberRow({ member, isMe, onChanged }: { member: Member; isMe: boolean; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  const change = (changes: { role?: Role; active?: boolean }) =>
    run(async () => {
      await api('PATCH', `/members/${member.id}`, changes);
      onChanged();
    });

  return (
    <tr>
      <td>
        {member.name}
        {isMe && <span className="muted"> (you)</span>}
      </td>
      <td>{member.email}</td>
      <td>
        <select
          aria-label={`Role of ${member.name}`}
          value={member.role}
          disabled={busy || isMe}
          onChange={(e) => void change({ role: e.target.value as Role })}
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
      </td>
      <td>
        {member.active ? 'Active' : 'Deactivated'}{' '}
        {!isMe && (
          <button type="button" disabled={busy} onClick={() => void change({ active: !member.active })}>
            {member.active ? 'Deactivate' : 'Reactivate'}
          </button>
        )}
        <ErrorText message={error} />
      </td>
    </tr>
  );
}
