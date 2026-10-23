import { useEffect, useState } from 'react';
import type { FormEvent, MouseEvent, ReactNode } from 'react';

import { api, ApiError, useAction } from './api';
import type { Member, Role } from './api';
import { AuditPage } from './AuditPage';
import { ChatPage } from './ChatPage';
import { ConnectPage } from './ConnectPage';
import { KeysPage } from './KeysPage';
import { MembersPage } from './MembersPage';
import { ServersPage } from './ServersPage';
import { ErrorText } from './ui';

interface Page {
  path: string;
  title: string;
  adminOnly?: boolean;
  render: (member: Member) => ReactNode;
}

const PAGES: Page[] = [
  { path: '/servers', title: 'Servers', render: (member) => <ServersPage member={member} /> },
  { path: '/chat', title: 'Chat', render: () => <ChatPage /> },
  { path: '/keys', title: 'API keys', render: (member) => <KeysPage member={member} /> },
  {
    path: '/members',
    title: 'Members',
    adminOnly: true,
    render: (member) => <MembersPage member={member} />,
  },
  { path: '/audit', title: 'Audit log', render: (member) => <AuditPage member={member} /> },
  { path: '/connect', title: 'Connect a client', render: () => <ConnectPage /> },
];

/** The current path, kept in step with the back and forward buttons. */
function useLocationPath(): [string, (path: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const navigate = (to: string) => {
    window.history.pushState(null, '', to);
    setPath(to);
  };
  return [path, navigate];
}

export function App() {
  const [path, navigate] = useLocationPath();
  // undefined while the session is being checked, null when signed out.
  const [member, setMember] = useState<Member | null>();
  const [sessionError, setSessionError] = useState<string>();

  useEffect(() => {
    api<{ member: Member }>('GET', '/me').then(
      ({ member }) => setMember(member),
      (error: Error) => {
        if (error instanceof ApiError && error.status === 401) setMember(null);
        else setSessionError(error.message);
      },
    );
  }, []);

  const signedIn = (signedInMember: Member) => {
    setMember(signedInMember);
    navigate('/servers');
  };

  if (path === '/invite') return <InvitePage onAccepted={signedIn} />;
  if (sessionError) return <ErrorText message={sessionError} />;
  if (member === undefined) return null;
  if (member === null) return <LoginPage onSignedIn={signedIn} />;

  const pages = PAGES.filter((page) => !page.adminOnly || member.role === 'admin');
  const page = pages.find((candidate) => candidate.path === path) ?? pages[0]!;
  const signOut = async () => {
    await api('POST', '/logout');
    setMember(null);
  };

  return (
    <div className="layout">
      <header className="topbar">
        <strong>Team MCP gateway</strong>
        <nav>
          {pages.map((candidate) => (
            <a
              key={candidate.path}
              href={candidate.path}
              aria-current={candidate === page ? 'page' : undefined}
              onClick={(event: MouseEvent) => {
                event.preventDefault();
                navigate(candidate.path);
              }}
            >
              {candidate.title}
            </a>
          ))}
        </nav>
        <span className="muted">
          {member.name} ({member.role})
        </span>
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <main>
        <h1>{page.title}</h1>
        {page.render(member)}
      </main>
    </div>
  );
}

function LoginPage({ onSignedIn }: { onSignedIn: (member: Member) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const { member } = await api<{ member: Member }>('POST', '/login', { email, password });
      onSignedIn(member);
    });
  };

  return (
    <main className="narrow">
      <h1>Sign in</h1>
      <form onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <ErrorText message={error} />
        <button type="submit" disabled={busy}>
          Sign in
        </button>
      </form>
    </main>
  );
}

/** Opens from an invite link. The token is in the URL fragment, so it never reaches a server log. */
function InvitePage({ onAccepted }: { onAccepted: (member: Member) => void }) {
  const [token] = useState(() => window.location.hash.slice(1));
  const [invite, setInvite] = useState<{ email: string; role: Role }>();
  const [inviteError, setInviteError] = useState<string>();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!token) return;
    api<{ email: string; role: Role }>('POST', '/invites/preview', { token }).then(
      setInvite,
      (failure: Error) => setInviteError(failure.message),
    );
  }, [token]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const { member } = await api<{ member: Member }>('POST', '/invites/accept', { token, name, password });
      onAccepted(member);
    });
  };

  return (
    <main className="narrow">
      <h1>Join the team</h1>
      <ErrorText
        message={token ? inviteError : 'This invite link is incomplete. Ask your admin for a new one.'}
      />
      {invite && (
        <form onSubmit={submit}>
          <p>
            You are invited as <strong>{invite.email}</strong> with the {invite.role} role.
          </p>
          <label>
            Your name
            <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Password (at least 12 characters)
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <ErrorText message={error} />
          <button type="submit" disabled={busy}>
            Create account
          </button>
        </form>
      )}
    </main>
  );
}
