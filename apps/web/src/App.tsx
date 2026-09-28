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
  if (state.kind === 'signedOut')
    return <Login onSignIn={(me) => setState({ kind: 'signedIn', me })} />;
  return <Projects me={state.me} onSignOut={() => setState({ kind: 'signedOut' })} />;
}

function Login({ onSignIn }: { onSignIn: (me: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Sign-in failed');
        return;
      }
      const me = await fetch('/api/me');
      if (me.ok) onSignIn(await me.json());
    } catch {
      setError('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell narrow">
      <h1>Story Forge</h1>
      <form onSubmit={submit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="notice">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
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
