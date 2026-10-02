import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { ErrorNote, Problems, ProseText, TextField, Working, humanize } from '../components.js';
import { navigate } from '../router.js';
import type { ApprovedFix, CohesionIssue, FixProposal, ReviewView } from '../types.js';

const SEVERITY_ORDER = { blocker: 0, warning: 1, note: 2 } as const;
const SCENE_BREAK = /^\s*(#|\*\s*\*\s*\*)\s*$/;

/** Replaces the nth paragraph (1-based, scene breaks not counted) in the prose. */
function replaceParagraph(prose: string, n: number, text: string): string {
  let count = 0;
  return prose
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .filter((b) => b.trim())
    .map((block) => {
      if (SCENE_BREAK.test(block)) return block.trim();
      count += 1;
      return count === n ? text.trim() : block.trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Cuts a label to `max` characters, so long version notes cannot stretch the layout. */
const shorten = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** A short label for an issue: severity, category, and where. */
const issueLabel = (issue: CohesionIssue) =>
  `${humanize(issue.severity)} · ${humanize(issue.category)}${issue.paragraph > 0 ? ` ¶${issue.paragraph}` : ''}`;

/** A revision note for the novelizer describing one issue. */
const issueNote = (issue: CohesionIssue) =>
  `${issue.paragraph > 0 ? `Paragraph ${issue.paragraph}: ` : ''}${issue.description} Fix: ${issue.suggestedFix}`;

/** The AI's proposed rewrite of one or more issues, shown beside the original for approval. */
function FixPanel({
  proposal,
  busy,
  describeIssue,
  onApprove,
  onDiscard,
}: {
  proposal: FixProposal;
  busy: boolean;
  /** A short label for an issue, for listing the ones the AI could not fix. */
  describeIssue: (issueId: string) => string;
  onApprove: (fix: ApprovedFix) => void;
  onDiscard: () => void;
}) {
  const [texts, setTexts] = useState(proposal.edits.map((e) => e.after));
  const [beat, setBeat] = useState(proposal.move?.beat ?? '');
  const { move } = proposal;
  const key = proposal.issueIds.join('-');
  return (
    <div className="fix stack">
      <p className="small-print">{proposal.explanation}</p>
      {proposal.skipped.length > 0 && (
        <div className="stack">
          <span className="muted small-print">
            Not fixed by this revision (waive or handle these):
          </span>
          <ul className="small-print">
            {proposal.skipped.map((sk) => (
              <li key={sk.issueId}>
                {describeIssue(sk.issueId)}: {sk.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {move && (
        <div className="stack">
          <span className="muted small-print">
            Moves to chapter {move.toChapter} (cut from this chapter):
          </span>
          {move.paragraphs.map((p) => (
            <del key={p.paragraph} className="small-print">
              ¶{p.paragraph} {p.text}
            </del>
          ))}
          {move.scenes.length > 0 && (
            <>
              <span className="muted small-print">
                These played scenes move with it, so their facts are not locked into this chapter:
              </span>
              <ul className="small-print">
                {move.scenes.map((s) => (
                  <li key={s.id}>{s.summary}</li>
                ))}
              </ul>
            </>
          )}
          <label className="muted small-print" htmlFor={`fix-${key}-beat`}>
            New required beat for chapter {move.toChapter} (you can edit it):
          </label>
          <textarea
            id={`fix-${key}-beat`}
            rows={Math.max(3, Math.ceil(beat.length / 45))}
            value={beat}
            onChange={(ev) => setBeat(ev.target.value)}
          />
        </div>
      )}
      {proposal.edits.map((e, i) => (
        <div key={e.paragraph} className="stack">
          <span className="muted small-print">¶{e.paragraph} now reads:</span>
          <del className="small-print">{e.before}</del>
          <label className="muted small-print" htmlFor={`fix-${key}-${e.paragraph}`}>
            Proposed (you can edit it before approving):
          </label>
          <textarea
            id={`fix-${key}-${e.paragraph}`}
            rows={Math.max(4, Math.ceil(texts[i]!.length / 45))}
            value={texts[i]}
            onChange={(ev) => setTexts(texts.map((t, j) => (j === i ? ev.target.value : t)))}
          />
        </div>
      ))}
      <div className="toolbar">
        <button
          disabled={
            busy ||
            (proposal.edits.length === 0 && !move) ||
            texts.some((t) => !t.trim()) ||
            (!!move && !beat.trim())
          }
          onClick={() =>
            onApprove({
              edits: proposal.edits.map((e, i) => ({ paragraph: e.paragraph, text: texts[i]! })),
              move: move && {
                paragraphs: move.paragraphs.map((p) => p.paragraph),
                sceneIds: move.scenes.map((s) => s.id),
                beat,
              },
            })
          }
        >
          {move
            ? `Approve and move to chapter ${move.toChapter}`
            : proposal.issueIds.length > 1
              ? `Approve fixes for ${proposal.issueIds.length - proposal.skipped.length} issues`
              : 'Approve fix'}
        </button>
        <button className="quiet" disabled={busy} onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}

/**
 * Fixes every open blocker and warning in one AI revision: one approval, one new version, and
 * one re-check, instead of a fix-and-check round per issue.
 */
function FixAll({
  issues,
  onPropose,
  onApply,
}: {
  issues: CohesionIssue[];
  onPropose: (issueIds: string[]) => Promise<FixProposal | null>;
  onApply: (proposal: FixProposal, fix: ApprovedFix) => Promise<void>;
}) {
  const [proposal, setProposal] = useState<FixProposal | null>(null);
  const [fixing, setFixing] = useState(false);
  const byId = new Map(issues.map((i) => [i.id, i]));

  async function propose() {
    setFixing(true);
    try {
      setProposal(await onPropose(issues.map((i) => i.id)));
    } finally {
      setFixing(false);
    }
  }

  async function apply(fix: ApprovedFix) {
    if (!proposal) return;
    setFixing(true);
    try {
      await onApply(proposal, fix);
      setProposal(null);
    } finally {
      setFixing(false);
    }
  }

  return (
    <div className="card stack">
      {proposal ? (
        <FixPanel
          proposal={proposal}
          busy={fixing}
          describeIssue={(id) => (byId.has(id) ? issueLabel(byId.get(id)!) : 'An issue')}
          onApprove={apply}
          onDiscard={() => setProposal(null)}
        />
      ) : (
        <>
          <p className="small-print">
            Fix all {issues.length} open blockers and warnings in one revision, then check once.
          </p>
          <div>
            <button
              disabled={fixing}
              onClick={propose}
              title="Have the AI rewrite the text to fix every open blocker and warning together"
            >
              {fixing ? `Writing fixes for ${issues.length} issues…` : `Fix all ${issues.length}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function IssueCard({
  issue,
  waiver,
  selected,
  canWaive,
  canFix,
  onSelect,
  onWaive,
  onEdit,
  onAddNote,
  onPropose,
  onApply,
}: {
  issue: CohesionIssue;
  waiver: { reason: string } | undefined;
  selected: boolean;
  canWaive: boolean;
  canFix: boolean;
  onSelect: () => void;
  onWaive: (reason: string) => Promise<void>;
  onEdit: () => void;
  onAddNote: () => void;
  onPropose: () => Promise<FixProposal | null>;
  onApply: (proposal: FixProposal, fix: ApprovedFix) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [proposal, setProposal] = useState<FixProposal | null>(null);
  const [fixing, setFixing] = useState(false);

  async function propose() {
    setFixing(true);
    try {
      setProposal(await onPropose());
    } finally {
      setFixing(false);
    }
  }

  async function apply(fix: ApprovedFix) {
    if (!proposal) return;
    setFixing(true);
    try {
      await onApply(proposal, fix);
    } finally {
      setFixing(false);
    }
  }
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
      <p className="small-print">Suggested fix: {issue.suggestedFix}</p>
      {canFix && !waiver && !proposal && (
        <div className="toolbar">
          <button
            disabled={fixing}
            onClick={propose}
            title="Have the AI rewrite the text to fix this"
          >
            {fixing ? 'Writing a fix…' : 'Suggest a fix'}
          </button>
          {issue.paragraph > 0 && (
            <button className="quiet" onClick={onEdit} title="Rewrite this paragraph yourself">
              Edit ¶{issue.paragraph}
            </button>
          )}
          <button
            className="quiet"
            onClick={onAddNote}
            title="Add this fix to the notes for the next AI revision"
          >
            Add to revision notes
          </button>
        </div>
      )}
      {proposal && canFix && (
        <FixPanel
          proposal={proposal}
          busy={fixing}
          describeIssue={() => issueLabel(issue)}
          onApprove={apply}
          onDiscard={() => setProposal(null)}
        />
      )}
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
  const [editingPara, setEditingPara] = useState<{ n: number; text: string } | null>(null);
  const draftRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLDivElement>(null);

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

  function editParagraph(n: number) {
    if (!view) return;
    setOlder(null);
    setEditingPara({ n, text: view.paragraphs[n - 1] ?? '' });
    setTimeout(
      () =>
        draftRef.current
          ?.querySelector(`[data-paragraph="${n}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
      0,
    );
  }

  function addNote(issue: CohesionIssue) {
    const note = issueNote(issue);
    setNotes((current) =>
      current.includes(note) ? current : `${current.trim()}\n- ${note}`.trim(),
    );
    notesRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  const saveParagraph = () =>
    run(async () => {
      if (!view?.draft || !editingPara) return;
      const next = await api<ReviewView>('PATCH', `/chapters/${chapterId}/draft`, {
        prose: replaceParagraph(view.draft.prose, editingPara.n, editingPara.text),
      });
      setEditingPara(null);
      return next;
    });

  if (!view) return <main className="shell">{error ? <ErrorNote error={error} /> : null}</main>;

  const { chapter, draft, report, gates } = view;
  const reviewable = chapter.status === 'review' || chapter.status === 'needs_recheck';
  const selectedIssue = report?.issues.find((i) => i.id === selected);
  const issues = [...(report?.issues ?? [])].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.paragraph - b.paragraph,
  );
  const waiverOf = (id: string) => report?.waived.find((w) => w.issueId === id);
  // What "fix all" covers: blockers and warnings not waived. Notes are suggestions.
  const openIssues = issues.filter((i) => i.severity !== 'note' && !waiverOf(i.id));
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
              {draft.notes && !older ? ` · ${shorten(draft.notes, 60)}` : ''}
            </span>
            {older && (
              <button className="quiet" onClick={() => setOlder(null)}>
                Back to current
              </button>
            )}
            {reviewable && !older && (
              <button className="quiet" disabled={busy} onClick={() => setEditing(draft.prose)}>
                Edit whole chapter
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
                    v{v.version} · {v.wordCount} words{v.notes ? ` · ${shorten(v.notes, 40)}` : ''}
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
            {paragraphs.map((p, i) =>
              editingPara?.n === i + 1 ? (
                <div key={i} data-paragraph={i + 1} className="para-edit stack">
                  <textarea
                    aria-label={`Paragraph ${i + 1}`}
                    rows={Math.max(4, Math.ceil(editingPara.text.length / 70))}
                    value={editingPara.text}
                    autoFocus
                    onChange={(e) => setEditingPara({ n: i + 1, text: e.target.value })}
                  />
                  <div className="toolbar">
                    <button disabled={busy || !editingPara.text.trim()} onClick={saveParagraph}>
                      Save paragraph
                    </button>
                    <button className="quiet" onClick={() => setEditingPara(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p
                  key={i}
                  data-paragraph={i + 1}
                  className={`${!older && selectedIssue?.paragraph === i + 1 ? 'highlight' : ''}${reviewable && !older ? ' editable' : ''}`}
                  title={reviewable && !older ? 'Click to edit this paragraph' : undefined}
                  onClick={() => reviewable && !older && !editingPara && editParagraph(i + 1)}
                >
                  <span className="para-no" aria-hidden>
                    {i + 1}
                  </span>
                  <ProseText text={p} />
                </p>
              ),
            )}
          </article>
        ) : (
          !working && (
            <div className="card stack">
              <p>
                {view.job?.status === 'failed'
                  ? 'The draft could not be written. Try again, or return to play.'
                  : 'This chapter has ended but its prose draft has not been written yet.'}
              </p>
              <div className="toolbar">
                <button
                  disabled={busy}
                  onClick={() =>
                    run(() => api('POST', `/chapters/${chapterId}/draft/regenerate`, { notes: '' }))
                  }
                >
                  Write the draft
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
          )
        )}

        {reviewable && !older && draft && (
          <p className="muted small-print">
            Click any paragraph to rewrite it yourself, or add issues to the revision notes below
            and let the AI redraft the chapter. After changing the draft, check it again.
          </p>
        )}

        {reviewable && !older && draft && (
          <div className="toolbar">
            <button
              className="quiet"
              disabled={busy || !!working}
              title="Adds interiority, consequence, and continuity to this draft without rewriting it, as a new version"
              onClick={() => run(() => api('POST', `/chapters/${chapterId}/draft/deepen`))}
            >
              Deepen prose
            </button>
          </div>
        )}

        {(reviewable || (chapter.status === 'drafting' && draft && !working)) && (
          <div className="card stack" ref={notesRef}>
            <TextField
              label="Revise with AI: notes for the next draft"
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
                {chapter.status === 'drafting' ? 'Draft again' : 'Redraft with these notes'}
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
          {report && !report.current && working && (
            <p className="notice">
              Re-checking the new version. These issues are from the previous one; fixes and waivers
              come back when the check finishes.
            </p>
          )}
          {report && !report.current && !working && (
            <div className="notice stack">
              <p>The draft has changed since it was last checked. Check it again before locking.</p>
              {reviewable && (
                <div>
                  <button
                    className=""
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
          {reviewable && !!draft && report?.current && !working && openIssues.length > 1 && (
            <FixAll
              key={`${report.id}:${openIssues.map((i) => i.id).join(',')}`}
              issues={openIssues}
              onPropose={async (issueIds) => {
                setError(null);
                try {
                  return await api<FixProposal>('POST', `/chapters/${chapterId}/fixes`, {
                    issueIds,
                  });
                } catch (err) {
                  setError(errorText(err));
                  return null;
                }
              }}
              onApply={(proposal, fix) =>
                run(() =>
                  api('POST', `/chapters/${chapterId}/fixes/apply`, {
                    issueIds: proposal.issueIds,
                    draftVersion: proposal.draftVersion,
                    ...fix,
                  }),
                )
              }
            />
          )}
          <ul className="issues">
            {issues.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                waiver={waiverOf(issue.id)}
                selected={issue.id === selected}
                canWaive={reviewable && report!.current}
                canFix={reviewable && !!draft && report!.current}
                onSelect={() => selectIssue(issue)}
                onEdit={() => editParagraph(issue.paragraph)}
                onAddNote={() => addNote(issue)}
                onPropose={async () => {
                  setError(null);
                  try {
                    return await api<FixProposal>(
                      'POST',
                      `/chapters/${chapterId}/issues/${issue.id}/fix`,
                    );
                  } catch (err) {
                    setError(errorText(err));
                    return null;
                  }
                }}
                onApply={(proposal, fix) =>
                  run(() =>
                    api('POST', `/chapters/${chapterId}/issues/${issue.id}/fix/apply`, {
                      draftVersion: proposal.draftVersion,
                      ...fix,
                    }),
                  )
                }
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
