import { useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import { ErrorNote, humanize } from '../components.js';
import { navigate } from '../router.js';
import type { ChapterListItem, Project } from '../types.js';

/** A chapter can be opened once it has started, or when it is next in line. */
function openable(chapters: ChapterListItem[], c: ChapterListItem) {
  if (c.status !== 'planned') return true;
  return c.number === 1 || chapters.find((p) => p.number === c.number - 1)?.status === 'locked';
}

export function ChaptersScreen({ project }: { project: Project }) {
  const [chapters, setChapters] = useState<ChapterListItem[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);

  useEffect(() => {
    api<ChapterListItem[]>('GET', `/projects/${project.id}/chapters`).then(setChapters, (e) =>
      setError(errorText(e)),
    );
  }, [project.id]);

  if (error) return <ErrorNote error={error} />;
  if (!chapters) return null;

  return (
    <ol className="chapters">
      {chapters.map((c) => {
        const canOpen = openable(chapters, c);
        const inPlay = c.status === 'planned' || c.status === 'playing';
        const label =
          c.status === 'planned' ? 'Play' : c.status === 'playing' ? 'Continue' : 'Review';
        return (
          <li key={c.id} className="card chapter">
            <div className="chapter-head">
              <span className="chapter-no">Chapter {c.number}</span>
              <strong>{c.title}</strong>
              <span className="badge">{humanize(c.status)}</span>
              <span className="reorder">
                {c.status !== 'planned' && !inPlay && (
                  <button
                    className="quiet"
                    onClick={() => navigate(`/projects/${project.id}/play/${c.id}`)}
                  >
                    Play log
                  </button>
                )}
                {c.status === 'locked' && (
                  <a className="button quiet" href={`/api/chapters/${c.id}/download.docx`} download>
                    Download .docx
                  </a>
                )}
                <button
                  disabled={!canOpen}
                  title={canOpen ? undefined : 'The previous chapter must be locked first'}
                  onClick={() =>
                    navigate(`/projects/${project.id}/${inPlay ? 'play' : 'review'}/${c.id}`)
                  }
                >
                  {label}
                </button>
              </span>
            </div>
            <p className="muted">{c.purpose}</p>
          </li>
        );
      })}
    </ol>
  );
}
