import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import {
  ErrorNote,
  LinesField,
  ListEditor,
  NumberField,
  Problems,
  SelectField,
  TextField,
  Working,
} from '../components.js';
import { navigate } from '../router.js';
import type { BibleContent, BibleView, Project } from '../types.js';

type Tab = 'spine' | 'world' | 'characters' | 'style';
const TABS: { key: Tab; label: string }[] = [
  { key: 'spine', label: 'Spine' },
  { key: 'world', label: 'World' },
  { key: 'characters', label: 'Characters' },
  { key: 'style', label: 'Style' },
];
// The cast lives in the world section, so both tabs regenerate "world".
const SECTION: Record<Tab, 'spine' | 'world' | 'styleGuide'> = {
  spine: 'spine',
  world: 'world',
  characters: 'world',
  style: 'styleGuide',
};

const ANCHOR_TYPES = [
  'inciting_incident',
  'midpoint_reversal',
  'dark_moment',
  'climax',
  'other',
] as const;
const POVS = ['first', 'second', 'third_limited', 'third_omniscient'] as const;
const TENSES = ['past', 'present'] as const;

export function BibleScreen({
  project,
  onChange,
}: {
  project: Project;
  onChange: () => Promise<void>;
}) {
  const [view, setView] = useState<BibleView | null>(null);
  const [latest, setLatest] = useState<number | null>(null);
  const [draft, setDraft] = useState<BibleContent | null>(null);
  const [tab, setTab] = useState<Tab>('spine');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);

  const load = useCallback(
    async (version?: number) => {
      const v = await api<BibleView>(
        'GET',
        `/projects/${project.id}/bible${version ? `?version=${version}` : ''}`,
      );
      setView((prev) => ({ ...v, versions: v.versions ?? prev?.versions }));
      if (!version) setLatest(v.version);
      setDraft(structuredClone(v.content));
    },
    [project.id],
  );

  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
  }, [load]);

  if (!view || !draft) return error ? <ErrorNote error={error} /> : null;

  const viewingOld = latest !== null && view.version !== latest;
  const readOnly = project.status !== 'bible_review' || viewingOld;
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.content);

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

  const save = () =>
    run('Saving…', async () => {
      await api('PATCH', `/projects/${project.id}/bible`, draft);
      await load();
    });

  const regenerate = () =>
    run('Rewriting this section…', async () => {
      await api('POST', `/projects/${project.id}/bible/regenerate`, {
        section: SECTION[tab],
        notes,
      });
      setNotes('');
      await load();
    });

  const approve = () =>
    run('Approving…', async () => {
      await api('POST', `/projects/${project.id}/bible/approve`);
      await onChange();
      navigate(`/projects/${project.id}/outline`);
    });

  const set = (patch: Partial<BibleContent>) => setDraft({ ...draft, ...patch });
  const spine = draft.spine;
  const world = draft.world;
  const style = draft.styleGuide;

  return (
    <section className="stack">
      <div className="toolbar">
        <VersionPicker
          versions={view.versions?.map((v) => v.version) ?? []}
          current={view.version}
          onPick={(v) => run('Loading…', () => load(v === latest ? undefined : v))}
        />
        {!readOnly && (
          <>
            <button onClick={save} disabled={!dirty || !!busy}>
              Save changes
            </button>
            <button
              onClick={approve}
              disabled={dirty || view.spineProblems.length > 0 || !!busy}
              title={dirty ? 'Save your changes first' : undefined}
            >
              Approve bible
            </button>
          </>
        )}
        {view.approvedAt && <span className="badge">Approved</span>}
      </div>
      {viewingOld && (
        <p className="notice">Viewing version {view.version}. Older versions are read-only.</p>
      )}
      {!readOnly && (
        <Problems title="Complete the spine before approving:" problems={view.spineProblems} />
      )}

      <TextField
        label="Title"
        value={draft.title}
        readOnly={readOnly}
        onChange={(title) => set({ title })}
      />

      <nav className="tabs" aria-label="Bible sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={t.key === tab ? 'tab active' : 'tab'}
            aria-current={t.key === tab ? 'page' : undefined}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'spine' && (
        <div className="stack">
          <TextField
            label="Central dramatic question"
            multiline
            value={spine.centralQuestion}
            readOnly={readOnly}
            onChange={(centralQuestion) => set({ spine: { ...spine, centralQuestion } })}
          />
          <TextField
            label="Theme statement"
            value={spine.theme}
            readOnly={readOnly}
            onChange={(theme) => set({ spine: { ...spine, theme } })}
          />
          <div className="row">
            <TextField
              label="Ending: how it resolves"
              multiline
              value={spine.ending.resolution}
              readOnly={readOnly}
              onChange={(resolution) =>
                set({ spine: { ...spine, ending: { ...spine.ending, resolution } } })
              }
            />
            <TextField
              label="Ending: what it costs"
              multiline
              value={spine.ending.cost}
              readOnly={readOnly}
              onChange={(cost) => set({ spine: { ...spine, ending: { ...spine.ending, cost } } })}
            />
          </div>
          <div className="row">
            <NumberField
              label="Chapters"
              value={spine.chapterCount}
              readOnly={readOnly}
              onChange={(chapterCount) => set({ spine: { ...spine, chapterCount } })}
            />
            <NumberField
              label="Target words"
              value={spine.targetWordCount}
              readOnly={readOnly}
              onChange={(targetWordCount) => set({ spine: { ...spine, targetWordCount } })}
            />
          </div>
          <ListEditor
            label="Anchor beats (3-5)"
            items={spine.anchorBeats}
            readOnly={readOnly}
            addLabel="Add anchor beat"
            newItem={() => ({
              type: 'other' as const,
              label: '',
              description: '',
              targetChapter: 1,
            })}
            onChange={(anchorBeats) => set({ spine: { ...spine, anchorBeats } })}
            render={(beat, update) => (
              <>
                <div className="row">
                  <SelectField
                    label="Type"
                    value={beat.type}
                    options={ANCHOR_TYPES}
                    readOnly={readOnly}
                    onChange={(type) => update({ ...beat, type })}
                  />
                  <NumberField
                    label="Chapter"
                    value={beat.targetChapter}
                    readOnly={readOnly}
                    onChange={(targetChapter) => update({ ...beat, targetChapter })}
                  />
                  <TextField
                    label="Label"
                    value={beat.label}
                    readOnly={readOnly}
                    onChange={(label) => update({ ...beat, label })}
                  />
                </div>
                <TextField
                  label="What happens"
                  multiline
                  rows={2}
                  value={beat.description}
                  readOnly={readOnly}
                  onChange={(description) => update({ ...beat, description })}
                />
              </>
            )}
          />
        </div>
      )}

      {tab === 'world' && (
        <div className="stack">
          <TextField
            label="Logline"
            multiline
            rows={2}
            value={world.logline}
            readOnly={readOnly}
            onChange={(logline) => set({ world: { ...world, logline } })}
          />
          <div className="row">
            <TextField
              label="Genre"
              value={world.genre}
              readOnly={readOnly}
              onChange={(genre) => set({ world: { ...world, genre } })}
            />
            <TextField
              label="Tone"
              value={world.tone}
              readOnly={readOnly}
              onChange={(tone) => set({ world: { ...world, tone } })}
            />
          </div>
          <TextField
            label="Setting"
            multiline
            value={world.setting}
            readOnly={readOnly}
            onChange={(setting) => set({ world: { ...world, setting } })}
          />
          <ListEditor
            label="Locations"
            items={world.locations}
            readOnly={readOnly}
            addLabel="Add location"
            newItem={() => ({ name: '', description: '' })}
            onChange={(locations) => set({ world: { ...world, locations } })}
            render={(loc, update) => (
              <div className="row">
                <TextField
                  label="Name"
                  value={loc.name}
                  readOnly={readOnly}
                  onChange={(name) => update({ ...loc, name })}
                />
                <TextField
                  label="Description"
                  value={loc.description}
                  readOnly={readOnly}
                  onChange={(description) => update({ ...loc, description })}
                />
              </div>
            )}
          />
          <LinesField
            label="World rules"
            value={world.rules}
            readOnly={readOnly}
            onChange={(rules) => set({ world: { ...world, rules } })}
          />
        </div>
      )}

      {tab === 'characters' && (
        <ListEditor
          label="Cast"
          items={world.cast}
          readOnly={readOnly}
          addLabel="Add character"
          newItem={() => ({
            name: '',
            role: 'supporting' as const,
            tier: 'minor' as const,
            summary: '',
            want: '',
            flaw: '',
            arcStart: '',
            arcEnd: '',
          })}
          onChange={(cast) => set({ world: { ...world, cast } })}
          render={(c, update) => (
            <>
              <div className="row">
                <TextField
                  label="Name"
                  value={c.name}
                  readOnly={readOnly}
                  onChange={(name) => update({ ...c, name })}
                />
                <SelectField
                  label="Role"
                  value={c.role}
                  options={['protagonist', 'antagonist', 'supporting'] as const}
                  readOnly={readOnly}
                  onChange={(role) => update({ ...c, role })}
                />
                <SelectField
                  label="Tier"
                  value={c.tier}
                  options={['major', 'minor'] as const}
                  readOnly={readOnly}
                  onChange={(tier) => update({ ...c, tier })}
                />
              </div>
              <TextField
                label="Summary"
                value={c.summary}
                readOnly={readOnly}
                onChange={(summary) => update({ ...c, summary })}
              />
              <div className="row">
                <TextField
                  label="Want"
                  value={c.want}
                  readOnly={readOnly}
                  onChange={(want) => update({ ...c, want })}
                />
                <TextField
                  label="Fear or flaw"
                  value={c.flaw}
                  readOnly={readOnly}
                  onChange={(flaw) => update({ ...c, flaw })}
                />
              </div>
              <div className="row">
                <TextField
                  label="Arc: start"
                  value={c.arcStart}
                  readOnly={readOnly}
                  onChange={(arcStart) => update({ ...c, arcStart })}
                />
                <TextField
                  label="Arc: end"
                  value={c.arcEnd}
                  readOnly={readOnly}
                  onChange={(arcEnd) => update({ ...c, arcEnd })}
                />
              </div>
            </>
          )}
        />
      )}

      {tab === 'style' && (
        <div className="stack">
          <div className="row">
            <SelectField
              label="Point of view"
              value={style.pov}
              options={POVS}
              readOnly={readOnly}
              onChange={(pov) => set({ styleGuide: { ...style, pov } })}
            />
            <TextField
              label="POV character"
              value={style.povCharacter}
              readOnly={readOnly}
              onChange={(povCharacter) => set({ styleGuide: { ...style, povCharacter } })}
            />
            <SelectField
              label="Tense"
              value={style.tense}
              options={TENSES}
              readOnly={readOnly}
              onChange={(tense) => set({ styleGuide: { ...style, tense } })}
            />
          </div>
          <TextField
            label="Prose register"
            value={style.register}
            readOnly={readOnly}
            onChange={(register) => set({ styleGuide: { ...style, register } })}
          />
          <LinesField
            label="Banned phrases"
            value={style.bannedPhrases}
            readOnly={readOnly}
            onChange={(bannedPhrases) => set({ styleGuide: { ...style, bannedPhrases } })}
          />
          <ListEditor
            label="Sample paragraphs (2-3)"
            items={style.samples}
            readOnly={readOnly}
            addLabel="Add sample"
            newItem={() => ''}
            onChange={(samples) => set({ styleGuide: { ...style, samples } })}
            render={(sample, update) => (
              <TextField
                label="Sample"
                multiline
                rows={4}
                value={sample}
                readOnly={readOnly}
                onChange={update}
              />
            )}
          />
        </div>
      )}

      {!readOnly && (
        <div className="card stack">
          <TextField
            label={`Regenerate ${TABS.find((t) => t.key === tab)!.label.toLowerCase()} with notes`}
            multiline
            rows={2}
            value={notes}
            onChange={setNotes}
            placeholder="e.g. Make the antagonist sympathetic; move the midpoint later"
          />
          <div>
            <button
              onClick={regenerate}
              disabled={dirty || !!busy}
              title={dirty ? 'Save or discard your changes first' : undefined}
            >
              Regenerate section
            </button>
          </div>
        </div>
      )}

      {busy && <Working label={busy} />}
      <ErrorNote error={error} />
    </section>
  );
}

export function VersionPicker(props: {
  versions: number[];
  current: number;
  onPick: (version: number) => void;
}) {
  if (props.versions.length <= 1) return <span className="muted">Version {props.current}</span>;
  return (
    <label className="inline">
      Version{' '}
      <select value={props.current} onChange={(e) => props.onPick(Number(e.target.value))}>
        {props.versions.map((v, i) => (
          <option key={v} value={v}>
            {v}
            {i === 0 ? ' (latest)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
