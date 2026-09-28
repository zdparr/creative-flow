import { type FormEvent, useEffect, useState } from 'react';
import { PlayScreen } from './pages/Play.js';
import { ProjectPage } from './pages/Project.js';
import { ProjectsPage } from './pages/Projects.js';
import { ReviewScreen } from './pages/Review.js';
import { match, navigate, usePath } from './router.js';
import type { Me } from './types.js';

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

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setState({ kind: 'signedOut' });
  }

  return (
    <>
      <header className="topbar">
        <a
          href="/"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
        >
          Story Forge
        </a>
        <span className="muted">
          {state.me.email}{' '}
          <button className="quiet" onClick={signOut}>
            Sign out
          </button>
        </span>
      </header>
      <Routes />
    </>
  );
}

function Routes() {
  const path = usePath();
  const play = match('/projects/:id/play/:chapterId', path);
  if (play) return <PlayScreen projectId={play.id!} chapterId={play.chapterId!} />;
  const review = match('/projects/:id/review/:chapterId', path);
  if (review) return <ReviewScreen projectId={review.id!} chapterId={review.chapterId!} />;
  const project = match('/projects/:id', path) ?? match('/projects/:id/:tab', path);
  if (project) return <ProjectPage id={project.id!} tab={project.tab} />;
  return <ProjectsPage />;
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
      <form onSubmit={submit} className="stack">
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
