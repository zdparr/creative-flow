import { type FormEvent, useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import { ErrorNote, STATUS_LABELS, TextField } from '../components.js';
import { navigate } from '../router.js';
import type { Project } from '../types.js';

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [pitch, setPitch] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);

  useEffect(() => {
    api<Project[]>('GET', '/projects').then(setProjects, (e) => setError(errorText(e)));
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const project = await api<Project>('POST', '/projects', { pitch, title: title || undefined });
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <section className="card">
        <h1>Start a book</h1>
        <form onSubmit={create} className="stack">
          <TextField
            label="Your pitch"
            multiline
            rows={4}
            value={pitch}
            onChange={setPitch}
            placeholder="A lighthouse keeper finds letters addressed to her dead sister, written in the future…"
          />
          <TextField label="Working title (optional)" value={title} onChange={setTitle} />
          <ErrorNote error={error} />
          <div>
            <button type="submit" disabled={busy || pitch.trim().length < 10}>
              {busy ? 'Creating…' : 'Start the interview'}
            </button>
          </div>
        </form>
      </section>

      <h2>Your books</h2>
      {projects === null ? null : projects.length === 0 ? (
        <p className="muted">No books yet.</p>
      ) : (
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <a
                href={`/projects/${p.id}`}
                className="card project-card"
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/projects/${p.id}`);
                }}
              >
                <strong>{p.title}</strong>
                <span className="badge">{STATUS_LABELS[p.status]}</span>
                <span className="muted clamp">{p.createdFromPitch}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
