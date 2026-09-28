import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import { ErrorNote, Problems, Working, humanize } from '../components.js';
import { navigate } from '../router.js';
import type { BookFormat, BookView, Project } from '../types.js';

const FORMATS: { format: BookFormat; label: string }[] = [
  { format: 'epub', label: 'EPUB' },
  { format: 'docx', label: 'Word' },
  { format: 'pdf', label: 'PDF' },
  { format: 'markdown', label: 'Markdown' },
];

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const size = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
const running = (j: { status: string } | null) => j?.status === 'queued' || j?.status === 'running';

function PromiseRow({
  p,
  chapterCount,
  onChange,
}: {
  p: BookView['promises'][number];
  chapterCount: number;
  onChange: (change: { status?: 'open' | 'dropped'; extendTo?: number }) => void;
}) {
  const [extendTo, setExtendTo] = useState(Math.min(p.window.to + 1, chapterCount));
  return (
    <tr className={p.status === 'dropped' ? 'struck' : ''}>
      <td>{p.description}</td>
      <td>{humanize(p.type)}</td>
      <td>{p.plantedChapter}</td>
      <td>
        {p.window.from}-{p.window.to}
      </td>
      <td>{p.status === 'paid' ? `Paid in ch ${p.paidChapter}` : humanize(p.status)}</td>
      <td>
        {p.status === 'open' && (
          <span className="inline">
            {p.window.to < chapterCount && (
              <>
                <input
                  type="number"
                  aria-label="Extend to chapter"
                  min={p.window.to + 1}
                  max={chapterCount}
                  value={extendTo}
                  onChange={(e) => setExtendTo(Number(e.target.value))}
                  className="narrow-input"
                />
                <button className="quiet" onClick={() => onChange({ extendTo })}>
                  Extend
                </button>
              </>
            )}
            <button className="quiet" onClick={() => onChange({ status: 'dropped' })}>
              Drop
            </button>
          </span>
        )}
        {p.status === 'dropped' && (
          <button className="quiet" onClick={() => onChange({ status: 'open' })}>
            Reopen
          </button>
        )}
      </td>
    </tr>
  );
}

/** Track and finish the book: chapters, cohesion structures, usage, assembly, and export. */
export function BookScreen({ project, onChange }: { project: Project; onChange: () => void }) {
  const [book, setBook] = useState<BookView | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setBook(await api<BookView>('GET', `/projects/${project.id}/book`));
    } catch (err) {
      setError(errorText(err));
    }
  }, [project.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const working = book && (running(book.reviewJob) || running(book.exportJob));
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [working, reload]);

  async function run(fn: () => Promise<unknown>, statusChanges = false) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
      if (statusChanges) onChange();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!book) return error ? <ErrorNote error={error} /> : null;

  const locked = book.chapters.filter((c) => c.status === 'locked').length;
  const status = book.project.status;
  return (
    <div className="stack book">
      <ErrorNote error={error} />

      <section className="card stack">
        <div className="toolbar">
          <h2>Manuscript</h2>
          <span className="muted">
            {book.totalWords.toLocaleString()} words · {locked}/{book.chapters.length} chapters
            locked · {usd(book.usage.total.costUsd)} spent
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Chapter</th>
              <th>Title</th>
              <th>Status</th>
              <th>Words</th>
            </tr>
          </thead>
          <tbody>
            {book.chapters.map((c) => (
              <tr key={c.id}>
                <td>{c.number}</td>
                <td>
                  <a
                    href={`/projects/${project.id}/review/${c.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(
                        `/projects/${project.id}/${c.status === 'planned' || c.status === 'playing' ? 'play' : 'review'}/${c.id}`,
                      );
                    }}
                  >
                    {c.title}
                  </a>
                </td>
                <td>{humanize(c.status)}</td>
                <td>{c.wordCount ? c.wordCount.toLocaleString() : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card stack">
        <h2>Assemble and review</h2>
        {status === 'writing' && (
          <>
            <p className="muted">
              When every chapter is locked, assemble the book for a whole-book review of pacing,
              repetition, theme drift, and dropped threads.
            </p>
            <div>
              <button
                disabled={!book.canAssemble || busy}
                onClick={() => run(() => api('POST', `/projects/${project.id}/assemble`), true)}
              >
                Assemble the book
              </button>
            </div>
          </>
        )}
        {running(book.reviewJob) && <Working label="Reviewing the whole book…" />}
        {book.reviewJob?.status === 'failed' && (
          <Problems
            title="The book review failed"
            problems={[book.reviewJob.error ?? 'Unknown error']}
          />
        )}
        {book.review && (
          <div className="stack">
            <p>{book.review.summary}</p>
            {book.review.issues.length > 0 && (
              <ul className="issues">
                {book.review.issues.map((issue, i) => (
                  <li key={i} className={`issue ${issue.severity}`}>
                    <div className="toolbar">
                      <span className={`badge ${issue.severity === 'blocker' ? 'anchor' : ''}`}>
                        {humanize(issue.severity)}
                      </span>
                      <span className="badge">{humanize(issue.category)}</span>
                      <span className="muted">
                        {issue.chapter ? `Chapter ${issue.chapter}` : 'Whole book'}
                      </span>
                    </div>
                    <p>{issue.description}</p>
                    <p className="small-print">Suggestion: {issue.suggestion}</p>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small-print">
              To revise a flagged chapter, open it and unlock it; the book returns to writing.
            </p>
          </div>
        )}
        {status === 'assembling' && (
          <div className="toolbar">
            <button
              className="quiet"
              disabled={busy || running(book.reviewJob)}
              onClick={() => run(() => api('POST', `/projects/${project.id}/assemble`))}
            >
              Review again
            </button>
            <button
              className="quiet"
              disabled={busy}
              onClick={() => {
                if (confirm('Mark the book complete? Chapters can no longer be unlocked.')) {
                  void run(() => api('POST', `/projects/${project.id}/complete`), true);
                }
              }}
            >
              Mark complete
            </button>
          </div>
        )}
      </section>

      <section className="card stack">
        <h2>Export</h2>
        {!book.canExport && <p className="muted">Assemble the book to export it.</p>}
        <div className="toolbar">
          {FORMATS.map((f) => (
            <button
              key={f.format}
              className="quiet"
              disabled={!book.canExport || busy || running(book.exportJob)}
              onClick={() =>
                run(() => api('POST', `/projects/${project.id}/export`, { format: f.format }))
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        {running(book.exportJob) && (
          <Working
            label={`Exporting ${FORMATS.find((f) => f.format === book.exportJob?.input.format)?.label ?? 'the book'}…`}
          />
        )}
        {book.exportJob?.status === 'failed' && (
          <Problems
            title="The export failed"
            problems={[book.exportJob.error ?? 'Unknown error']}
          />
        )}
        {book.exports.length > 0 && (
          <ul className="plain">
            {book.exports.map((e) => (
              <li key={e.id}>
                <a href={`/api/projects/${project.id}/exports/${e.id}/download`}>{e.fileName}</a>{' '}
                <span className="muted small-print">
                  {size(e.byteSize)} · {new Date(e.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack">
        <h2>Promise registry</h2>
        {book.promises.length === 0 ? (
          <p className="muted">Promises are recorded as chapters lock.</p>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Promise</th>
                  <th>Type</th>
                  <th>Planted</th>
                  <th>Window</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {book.promises.map((p) => (
                  <PromiseRow
                    key={p.id}
                    p={p}
                    chapterCount={book.chapters.length}
                    onChange={(change) =>
                      run(() => api('PATCH', `/projects/${project.id}/promises/${p.id}`, change))
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card stack">
        <details>
          <summary>
            <h2 className="inline-heading">Continuity ledger ({book.ledger.length})</h2>
          </summary>
          <ul className="plain">
            {book.ledger.map((f) => (
              <li key={f.id} className={f.superseded ? 'struck' : ''}>
                <span className="muted small-print">
                  ch {f.chapter} · {f.kind}
                </span>{' '}
                {f.statement}
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section className="card stack">
        <details>
          <summary>
            <h2 className="inline-heading">Usage and cost ({usd(book.usage.total.costUsd)})</h2>
          </summary>
          <div className="row">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Calls</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {book.usage.byAgent.map((a) => (
                  <tr key={a.agent}>
                    <td>{humanize(a.agent)}</td>
                    <td>{a.calls}</td>
                    <td>{tokens(a.inputTokens)}</td>
                    <td>{tokens(a.outputTokens)}</td>
                    <td>{usd(a.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table>
              <thead>
                <tr>
                  <th>Chapter</th>
                  <th>Calls</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {book.usage.byChapter.map((c) => (
                  <tr key={c.chapter ?? 'none'}>
                    <td>{c.chapter ?? 'Setup and book'}</td>
                    <td>{c.calls}</td>
                    <td>{usd(c.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </div>
  );
}
