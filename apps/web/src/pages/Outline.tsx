import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import {
  ErrorNote,
  ListEditor,
  Problems,
  SelectField,
  TextField,
  Working,
  humanize,
} from '../components.js';
import { ReplanPanel } from './Replan.js';
import type { OutlineChapter, OutlineView, Project } from '../types.js';
import { VersionPicker } from './Bible.js';

const ANCHOR_OPTIONS = [
  'none',
  'inciting_incident',
  'midpoint_reversal',
  'dark_moment',
  'climax',
  'other',
] as const;
const POLL_MS = 3000;

export function OutlineScreen({
  project,
  onChange,
}: {
  project: Project;
  onChange: () => Promise<void>;
}) {
  const [view, setView] = useState<OutlineView | null>(null);
  const [latest, setLatest] = useState<number | null>(null);
  const [draft, setDraft] = useState<OutlineChapter[] | null>(null);
  // Stable React keys that travel with chapters when they are reordered.
  const [keys, setKeys] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const load = useCallback(
    async (version?: number) => {
      const v = await api<OutlineView>(
        'GET',
        `/projects/${project.id}/outline${version ? `?version=${version}` : ''}`,
      );
      setView((prev) => ({
        ...v,
        versions: v.versions ?? prev?.versions,
        job: v.job ?? prev?.job ?? null,
      }));
      if (!version && v.outline) setLatest(v.outline.version);
      setDraft(v.outline ? structuredClone(v.outline.chapters) : null);
      setKeys(v.outline ? v.outline.chapters.map((_, i) => `${v.outline!.version}-${i}`) : []);
    },
    [project.id],
  );

  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
  }, [load]);

  const generating = view?.job?.status === 'queued' || view?.job?.status === 'running';

  // Poll while the outliner job runs in the worker.
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => load().catch(() => {}), POLL_MS);
    return () => clearInterval(timer);
  }, [generating, load]);

  if (!view) return error ? <ErrorNote error={error} /> : null;

  const outline = view.outline;
  const viewingOld = outline !== null && latest !== null && outline.version !== latest;
  const readOnly = project.status !== 'outline_review' || viewingOld || generating;
  const dirty = !!outline && JSON.stringify(draft) !== JSON.stringify(outline.chapters);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const generate = () =>
    run('Queueing…', async () => {
      await api('POST', `/projects/${project.id}/outline/generate`, { notes: notes || undefined });
      setNotes('');
      await load();
    });

  const save = () =>
    run('Saving…', async () => {
      await api('PATCH', `/projects/${project.id}/outline`, { chapters: draft });
      await load();
    });

  const approve = () =>
    run('Approving…', async () => {
      await api('POST', `/projects/${project.id}/outline/approve`);
      await onChange();
      await load();
    });

  const move = (from: number, to: number) => {
    if (!draft || to < 0 || to >= draft.length || from === to) return;
    const reorder = <T,>(list: T[]) => {
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return next;
    };
    setDraft(reorder(draft).map((c, i) => ({ ...c, number: i + 1 })));
    setKeys(reorder(keys));
  };
  const update = (i: number, chapter: OutlineChapter) =>
    setDraft(draft!.map((c, j) => (j === i ? chapter : c)));

  return (
    <section className="stack">
      {(project.status === 'writing' || project.status === 'assembling') && (
        <ReplanPanel projectId={project.id} onApplied={() => void load().catch(() => {})} />
      )}
      {generating && (
        <Working
          label={
            outline ? 'Revising the outline…' : 'Drafting the outline. This takes a minute or two…'
          }
        />
      )}
      {view.job?.status === 'failed' && !generating && (
        <Problems
          title="Outline generation failed"
          problems={[view.job.error ?? 'Unknown error']}
        />
      )}

      {!outline && !generating && project.status === 'outline_review' && (
        <div>
          <button onClick={generate} disabled={!!busy}>
            Generate outline
          </button>
        </div>
      )}

      {outline && draft && (
        <>
          <div className="toolbar">
            <VersionPicker
              versions={view.versions?.map((v) => v.version) ?? []}
              current={outline.version}
              onPick={(v) => run('Loading…', () => load(v === latest ? undefined : v))}
            />
            {!readOnly && (
              <>
                <button onClick={save} disabled={!dirty || !!busy}>
                  Save changes
                </button>
                <button
                  onClick={approve}
                  disabled={dirty || outline.problems.length > 0 || !!busy}
                  title={dirty ? 'Save your changes first' : undefined}
                >
                  Approve outline
                </button>
              </>
            )}
            {outline.approvedAt && <span className="badge">Approved</span>}
          </div>
          {viewingOld && (
            <p className="notice">
              Viewing version {outline.version}. Older versions are read-only.
            </p>
          )}
          {!readOnly && <Problems title="Fix before approving:" problems={outline.problems} />}

          <ol className="chapters">
            {draft.map((c, i) => (
              <li
                key={keys[i] ?? i}
                className={dragIndex === i ? 'card chapter dragging' : 'card chapter'}
                draggable={!readOnly}
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null) move(dragIndex, i);
                  setDragIndex(null);
                }}
                onDragEnd={() => setDragIndex(null)}
              >
                <div className="chapter-head">
                  <span className="chapter-no">Chapter {c.number}</span>
                  {c.isAnchor && c.anchorType && (
                    <span className="badge anchor">{humanize(c.anchorType)}</span>
                  )}
                  {c.promises.planted.map((p) => (
                    <span
                      key={p.description}
                      className="badge plant"
                      title={`Pays off in chapter ${p.payoffChapter}`}
                    >
                      Plants: {p.description}
                    </span>
                  ))}
                  {c.promises.paid.map((p) => (
                    <span key={p} className="badge pay">
                      Pays off: {p}
                    </span>
                  ))}
                  {!readOnly && (
                    <span className="reorder">
                      <button
                        className="quiet"
                        aria-label="Move up"
                        disabled={i === 0}
                        onClick={() => move(i, i - 1)}
                      >
                        ↑
                      </button>
                      <button
                        className="quiet"
                        aria-label="Move down"
                        disabled={i === draft.length - 1}
                        onClick={() => move(i, i + 1)}
                      >
                        ↓
                      </button>
                    </span>
                  )}
                </div>
                <div className="row">
                  <TextField
                    label="Title"
                    value={c.title}
                    readOnly={readOnly}
                    onChange={(title) => update(i, { ...c, title })}
                  />
                  <SelectField
                    label="Anchor"
                    value={c.anchorType ?? 'none'}
                    options={ANCHOR_OPTIONS}
                    readOnly={readOnly}
                    onChange={(v) =>
                      update(i, {
                        ...c,
                        isAnchor: v !== 'none',
                        anchorType: v === 'none' ? null : v,
                      })
                    }
                  />
                </div>
                <TextField
                  label="Purpose"
                  multiline
                  rows={2}
                  value={c.purpose}
                  readOnly={readOnly}
                  onChange={(purpose) => update(i, { ...c, purpose })}
                />
                <ListEditor
                  label="Required beats"
                  items={c.requiredBeats}
                  readOnly={readOnly}
                  addLabel="Add beat"
                  newItem={() => ({
                    id: `c${c.number}-b${Date.now().toString(36)}`,
                    description: '',
                  })}
                  onChange={(requiredBeats) => update(i, { ...c, requiredBeats })}
                  render={(beat, set) => (
                    <TextField
                      label={beat.id}
                      value={beat.description}
                      readOnly={readOnly}
                      onChange={(description) => set({ ...beat, description })}
                    />
                  )}
                />
                <ListEditor
                  label="Arcs moved"
                  items={c.arcsMoved}
                  readOnly={readOnly}
                  addLabel="Add arc move"
                  newItem={() => ({ character: '', change: '' })}
                  onChange={(arcsMoved) => update(i, { ...c, arcsMoved })}
                  render={(arc, set) => (
                    <div className="row">
                      <TextField
                        label="Character"
                        value={arc.character}
                        readOnly={readOnly}
                        onChange={(character) => set({ ...arc, character })}
                      />
                      <TextField
                        label="Change"
                        value={arc.change}
                        readOnly={readOnly}
                        onChange={(change) => set({ ...arc, change })}
                      />
                    </div>
                  )}
                />
              </li>
            ))}
          </ol>

          {!readOnly && (
            <div className="card stack">
              <TextField
                label="Regenerate the outline with notes"
                multiline
                rows={2}
                value={notes}
                onChange={setNotes}
                placeholder="e.g. Slow down the middle; give Tomas a chapter of his own"
              />
              <div>
                <button
                  onClick={generate}
                  disabled={dirty || !!busy}
                  title={dirty ? 'Save or discard your changes first' : undefined}
                >
                  Regenerate outline
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {busy && <Working label={busy} />}
      <ErrorNote error={error} />
    </section>
  );
}
