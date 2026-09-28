import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { ErrorNote, Problems, TextField, Working, humanize } from '../components.js';
import { navigate } from '../router.js';
import type { CohesionIssue, ReviewView } from '../types.js';

const SEVERITY_ORDER = { blocker: 0, warning: 1, note: 2 } as const;

function IssueCard({
  issue,
  waiver,
  selected,
  canWaive,
  onSelect,
  onWaive,
}: {
  issue: CohesionIssue;
  waiver: { reason: string } | undefined;
  selected: boolean;
  canWaive: boolean;
  onSelect: () => void;
  onWaive: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  return (
    <li
      className={`issue ${issue.severity}${selected ? ' selected' : ''}${waiver ? ' waived' : ''}`}
    >
      <div className="toolbar">
        <span className={`badge ${issue.severity === 'blocker' ? 'anchor' : ''}`}>
          {humanize(issue.severity)}
        </span>
        <span className="badge">{humanize(issue.category)}</span>
        {issue.paragraph > 0 ? (
          <button className="quiet" onClick={onSelect} title="Show this paragraph">
            ¶{issue.paragraph}
          </button>
        ) : (
          <span className="muted small-print">whole chapter</span>
        )}
      </div>
      <p>{issue.description}</p>
      <p className="muted small-print">Evidence: {issue.evidence}</p>
      <p className="small-print">Fix: {issue.suggestedFix}</p>
      {waiver ? (
        <p className="muted small-print">Waived: {waiver.reason}</p>
      ) : (
        issue.severity === 'blocker' &&
        canWaive && (
          <div className="toolbar">
            <input
              aria-label="Reason for waiving"
              placeholder="Reason for waiving"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button className="quiet" disabled={!reason.trim()} onClick={() => onWaive(reason)}>
              Waive
            </button>
          </div>
        )
      )}
    </li>
  );
}

export function ReviewScreen({ projectId, chapterId }: { projectId: string; chapterId: string }) {
  const [view, setView] = useState<ReviewView | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [older, setOlder] = useState<{ version: number; prose: string } | null>(null);
  const draftRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      setView(await api<ReviewView>('GET', `/chapters/${chapterId}/draft`));
    } catch (err) {
      setError(errorText(err));
    }
  }, [chapterId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Drafting and checking run as jobs: poll while one is queued or running.
  const working = view?.job && (view.job.status === 'queued' || view.job.status === 'running');
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [working, reload]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      if (next && typeof next === 'object' && 'chapter' in next) setView(next as ReviewView);
      else await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function selectIssue(issue: CohesionIssue) {
    setSelected(issue.id);
    setOlder(null);
    draftRef.current
      ?.querySelector(`[data-paragraph="${issue.paragraph}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  if (!view) return <main className="shell">{error ? <ErrorNote error={error} /> : null}</main>;

  const { chapter, draft, report, gates } = view;
  const reviewable = chapter.status === 'review' || chapter.status === 'needs_recheck';
  const selectedIssue = report?.issues.find((i) => i.id === selected);
  const issues = [...(report?.issues ?? [])].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.paragraph - b.paragraph,
  );
  const waiverOf = (id: string) => report?.waived.find((w) => w.issueId === id);
  const paragraphs = older
    ? older.prose.split(/\n\s*\n/).filter((p) => p.trim() && !/^\s*(#|\*\s*\*\s*\*)\s*$/.test(p))
    : view.paragraphs;

  return (
    <main className="play">
      <div className="story">
        <header className="story-head">
          <button className="quiet" onClick={() => navigate(`/projects/${projectId}/chapters`)}>
            ← {view.project.title}
          </button>
          <h1>
            Chapter {chapter.number}: {view.plan.title}
          </h1>
          <span className="badge">{humanize(chapter.status)}</span>
        </header>

        {working && <Working label={`${view.job!.stage}…`} />}
        {view.job?.status === 'failed' && (
          <Problems
            title={`${view.job.stage} failed`}
            problems={[view.job.error ?? 'Unknown error']}
          />
        )}
        <ErrorNote error={error} />

        {draft && editing === null && (
          <div className="toolbar">
            <span className="muted">
              Version {older?.version ?? draft.version}
              {older ? ' (older version, read only)' : ''} · {draft.wordCount} words
              {draft.notes && !older ? ` · ${draft.notes}` : ''}
            </span>
            {older && (
              <button className="quiet" onClick={() => setOlder(null)}>
                Back to current
              </button>
            )}
            {reviewable && !older && (
              <button className="quiet" disabled={busy} onClick={() => setEditing(draft.prose)}>
                Edit
              </button>
            )}
            {view.versions.length > 1 && (
              <select
                aria-label="Version history"
                value={older?.version ?? draft.version}
                onChange={async (e) => {
                  const v = Number(e.target.value);
                  if (v === draft.version) return setOlder(null);
                  const found = await api<{ version: number; prose: string }>(
                    'GET',
                    `/chapters/${chapterId}/draft/versions/${v}`,
                  );
                  setOlder(found);
                }}
              >
                {view.versions.map((v) => (
                  <option key={v.id} value={v.version}>
                    v{v.version} · {v.wordCount} words{v.notes ? ` · ${v.notes}` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {editing !== null ? (
          <div className="stack">
            <textarea
              aria-label="Draft"
              className="pane"
              rows={24}
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
            />
            <div className="toolbar">
              <button
                disabled={busy || !editing.trim()}
                onClick={() =>
                  run(async () => {
                    const next = await api<ReviewView>('PATCH', `/chapters/${chapterId}/draft`, {
                      prose: editing,
                    });
                    setEditing(null);
                    return next;
                  })
                }
              >
                Save as a new version
              </button>
              <button className="quiet" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : draft ? (
          <article className="pane draft" ref={draftRef}>
            {paragraphs.map((p, i) => (
              <p
                key={i}
                data-paragraph={i + 1}
                className={!older && selectedIssue?.paragraph === i + 1 ? 'highlight' : ''}
              >
                <span className="para-no" aria-hidden>
                  {i + 1}
                </span>
                {p}
              </p>
            ))}
          </article>
        ) : (
          !working && <p className="muted">No draft yet.</p>
        )}

        {(reviewable || (chapter.status === 'drafting' && !working)) && (
          <div className="card stack">
            <TextField
              label="Regenerate with notes"
              multiline
              value={notes}
              onChange={setNotes}
              placeholder="What should change in the next draft?"
            />
            <div className="toolbar">
              <button
                className="quiet"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const next = await api('POST', `/chapters/${chapterId}/draft/regenerate`, {
                      notes,
                    });
                    setNotes('');
                    return next;
                  })
                }
              >
                {chapter.status !== 'drafting'
                  ? 'Regenerate'
                  : draft
                    ? 'Draft again'
                    : 'Write the draft'}
              </button>
              <button
                className="quiet"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api('POST', `/chapters/${chapterId}/reopen`);
                    navigate(`/projects/${projectId}/play/${chapterId}`);
                  })
                }
              >
                Return to play
              </button>
            </div>
          </div>
        )}
      </div>

      <aside className="side">
        <section>
          <h2>Cohesion report</h2>
          {!report && !working && <p className="muted">Not checked yet.</p>}
          {report && !report.current && (
            <div className="notice stack">
              <p>The draft has changed since it was last checked.</p>
              {reviewable && (
                <div>
                  <button
                    className="quiet"
                    disabled={busy || !!working}
                    onClick={() => run(() => api('POST', `/chapters/${chapterId}/draft/check`))}
                  >
                    Check again
                  </button>
                </div>
              )}
            </div>
          )}
          {report && issues.length === 0 && <p>No issues found.</p>}
          <ul className="issues">
            {issues.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                waiver={waiverOf(issue.id)}
                selected={issue.id === selected}
                canWaive={reviewable && report!.current}
                onSelect={() => selectIssue(issue)}
                onWaive={(reason) =>
                  run(() =>
                    api('POST', `/chapters/${chapterId}/issues/${issue.id}/waive`, { reason }),
                  )
                }
              />
            ))}
          </ul>
        </section>

        {reviewable && (
          <section className="stack">
            <h2>Lock</h2>
            {gates.pendingCards.length > 0 && (
              <p className="notice">
                Approve {gates.pendingCards.map((c) => c.name).join(', ')} first:{' '}
                <a
                  href={`/projects/${projectId}/characters`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/projects/${projectId}/characters`);
                  }}
                >
                  open Characters
                </a>
              </p>
            )}
            {gates.openBlockers > 0 && (
              <p className="muted">{gates.openBlockers} blocker(s) to fix or waive.</p>
            )}
            <div>
              <button
                disabled={!view.canLock || busy}
                onClick={() => {
                  if (
                    confirm(
                      'Lock this chapter? Its facts, promises, and card changes become canon, and the remaining outline is re-planned.',
                    )
                  ) {
                    void run(() => api('POST', `/chapters/${chapterId}/lock`));
                  }
                }}
              >
                {chapter.status === 'needs_recheck' ? 'Confirm lock' : 'Lock chapter'}
              </button>
            </div>
          </section>
        )}

        {chapter.status === 'locked' && (
          <section className="stack">
            <h2>Locked</h2>
            <div className="toolbar">
              <a
                className="button quiet"
                href={`/api/chapters/${chapterId}/download.docx`}
                download
              >
                Download .docx
              </a>
              <button
                className="quiet"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      'Unlock this chapter? It returns to review, and every later locked chapter is flagged for a recheck.',
                    )
                  ) {
                    void run(
                      async () =>
                        (await api<{ review: ReviewView }>('POST', `/chapters/${chapterId}/unlock`))
                          .review,
                    );
                  }
                }}
              >
                Unlock
              </button>
            </div>
          </section>
        )}

        {report?.summary && (
          <section>
            <details>
              <summary>
                <h2 className="inline-heading">Chapter summary</h2>
              </summary>
              <p className="small-print">{report.summary}</p>
            </details>
          </section>
        )}
      </aside>
    </main>
  );
}
