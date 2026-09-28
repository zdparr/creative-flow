import { type FormEvent, useEffect, useState } from 'react';

type Me = { id: string; email: string; displayName: string | null };
type State = { kind: 'loading' } | { kind: 'signedOut' } | { kind: 'signedIn'; me: Me };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    fetch('/api/me')
      .then(async (res) =>
        res.ok
          ? setState({ kind: 'signedIn', me: await res.json() })
          : setState({ kind: 'signedOut' }),
      )
      .catch(() => setState({ kind: 'signedOut' }));
  }, []);

  if (state.kind === 'loading') return null;
  if (state.kind === 'signedOut') return <Login />;
  return <Projects me={state.me} onSignOut={() => setState({ kind: 'signedOut' })} />;
}

function Login() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const expired = new URLSearchParams(location.search).get('login') === 'expired';

  async function submit(e: FormEvent) {
    e.preventDefault();
    await fetch('/api/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    setSent(true);
  }

  return (
    <main className="shell narrow">
      <h1>Story Forge</h1>
      {expired && <p className="notice">That sign-in link expired. Request a new one.</p>}
      {sent ? (
        <p>If that address is allowed, a sign-in link is on its way.</p>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button type="submit">Send sign-in link</button>
        </form>
      )}
    </main>
  );
}

function Projects({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    onSignOut();
  }

  return (
    <main className="shell">
      <header className="bar">
        <h1>Story Forge</h1>
        <span>
          {me.email} <button onClick={signOut}>Sign out</button>
        </span>
      </header>
      <p className="muted">No books yet. Pitching a new book arrives in Phase 2.</p>
    </main>
  );
}
