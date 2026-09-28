import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import {
  ErrorNote,
  LinesField,
  ListEditor,
  NumberField,
  SelectField,
  TextField,
  Working,
  humanize,
} from '../components.js';
import type { CardContent, CardVersion, CharacterTier, CharacterView, Project } from '../types.js';

const TIERS: readonly CharacterTier[] = ['walk_on', 'minor', 'major'];
const tierLabel = (t: string) => (t === 'walk_on' ? 'Walk-on' : humanize(t));

const LABELS: Partial<Record<keyof CardContent, string>> = {
  relationshipToProtagonist: 'Relationship to protagonist',
  fearOrFlaw: 'Fear or flaw',
  storyRole: 'Story role',
  voiceNote: 'Voice note',
  arcStart: 'Arc start',
  arcEnd: 'Arc end',
};
const label = (field: keyof CardContent) => LABELS[field] ?? humanize(field);

/** The card fields a tier uses, in display order. */
function CardFields({
  tier,
  card,
  onChange,
  readOnly,
  missing,
}: {
  tier: CharacterTier;
  card: CardContent;
  onChange: (card: CardContent) => void;
  readOnly?: boolean;
  missing: string[];
}) {
  const set = <K extends keyof CardContent>(key: K, value: CardContent[K]) =>
    onChange({ ...card, [key]: value });
  const text = (key: keyof CardContent, multiline = false) => (
    <TextField
      label={`${label(key)}${missing.includes(key) ? ' (required)' : ''}`}
      value={String(card[key] ?? '')}
      multiline={multiline}
      rows={2}
      readOnly={readOnly}
      onChange={(v) => set(key, v as never)}
    />
  );
  return (
    <div className="stack">
      <div className="row">
        {text('role')}
        {text('location')}
        {text('trait')}
      </div>
      {tier !== 'walk_on' && (
        <>
          <div className="row">
            {text('storyRole', true)}
            {text('want', true)}
          </div>
          <div className="row">
            {text('relationshipToProtagonist', true)}
            {text('voiceNote', true)}
          </div>
        </>
      )}
      {tier === 'major' && (
        <>
          <LinesField
            label={`Core principles: what they will never do${missing.includes('principles') ? ' (required)' : ''}`}
            value={card.principles}
            readOnly={readOnly}
            onChange={(v) => set('principles', v)}
          />
          <div className="row">
            {text('goal', true)}
            {text('fearOrFlaw', true)}
            {text('secret', true)}
          </div>
          <div className="row">
            {text('arcStart', true)}
            {text('arcEnd', true)}
          </div>
          <ListEditor
            label="Arc checkpoints"
            items={card.checkpoints}
            readOnly={readOnly}
            onChange={(v) => set('checkpoints', v)}
            newItem={() => ({ chapter: 1, description: '', met: false })}
            addLabel="Add checkpoint"
            render={(cp, update) => (
              <div className="row">
                <NumberField
                  label="Chapter"
                  value={cp.chapter}
                  readOnly={readOnly}
                  onChange={(n) => update({ ...cp, chapter: n })}
                />
                <TextField
                  label={cp.met ? 'Where the arc stands (met)' : 'Where the arc stands'}
                  value={cp.description}
                  readOnly={readOnly}
                  onChange={(v) => update({ ...cp, description: v })}
                />
              </div>
            )}
          />
          <ListEditor
            label="Key relationships"
            items={card.keyRelationships}
            readOnly={readOnly}
            onChange={(v) => set('keyRelationships', v)}
            newItem={() => ({ name: '', relationship: '' })}
            addLabel="Add relationship"
            render={(r, update) => (
              <div className="row">
                <TextField
                  label="Name"
                  value={r.name}
                  readOnly={readOnly}
                  onChange={(v) => update({ ...r, name: v })}
                />
                <TextField
                  label="Relationship"
                  value={r.relationship}
                  readOnly={readOnly}
                  onChange={(v) => update({ ...r, relationship: v })}
                />
              </div>
            )}
          />
          <LinesField
            label={`Voice samples${missing.includes('voiceSamples') ? ' (required)' : ''}`}
            value={card.voiceSamples}
            readOnly={readOnly}
            onChange={(v) => set('voiceSamples', v)}
          />
        </>
      )}
    </div>
  );
}

function VersionHistory({ versions, tier }: { versions: CardVersion[]; tier: CharacterTier }) {
  const [open, setOpen] = useState<string | null>(null);
  if (versions.length === 0) return null;
  return (
    <details>
      <summary className="muted">Version history ({versions.length})</summary>
      <ul className="plain versions">
        {versions.map((v) => (
          <li key={v.id}>
            <button className="quiet" onClick={() => setOpen(open === v.id ? null : v.id)}>
              v{v.version}
            </button>{' '}
            {humanize(v.source)}, from chapter {v.effectiveChapter},{' '}
            {v.approvedAt ? 'approved' : <strong>pending</strong>}{' '}
            <span className="muted">{new Date(v.createdAt).toLocaleString()}</span>
            {open === v.id && (
              <div className="card">
                <CardFields tier={tier} card={v.card} onChange={() => {}} readOnly missing={[]} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Review and edit one character's card: approve a draft, save edits, change tier or promote,
 * regenerate with notes, merge a duplicate, or reject a provisional character.
 */
export function CardEditor({
  character,
  others,
  onChange,
}: {
  character: CharacterView;
  others: { id: string; name: string }[];
  onChange: () => void;
}) {
  const shown = character.pendingVersion ?? character.approvedVersion;
  const [card, setCard] = useState<CardContent>(shown?.card ?? character.card);
  const [notes, setNotes] = useState('');
  const [mergeInto, setMergeInto] = useState('');
  const [aliases, setAliases] = useState(character.aliases);
  const [history, setHistory] = useState<CardVersion[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);
  const [busy, setBusy] = useState(false);

  // A new draft or approval replaces what is being edited; polling alone does not.
  const versionKey = `${shown?.id ?? 'none'}:${character.tier}:${character.aliases.join('|')}`;
  useEffect(() => {
    setCard(shown?.card ?? character.card);
    setAliases(character.aliases);
  }, [versionKey]);

  useEffect(() => {
    api<CharacterView>('GET', `/characters/${character.id}`).then(
      (c) => setHistory(c.versions ?? []),
      () => setHistory([]),
    );
  }, [character.id, shown?.id]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const approve = () => run(() => api('POST', `/characters/${character.id}/approve`, { card }));
  const save = () => run(() => api('PATCH', `/characters/${character.id}`, { card, aliases }));
  const setTier = (tier: CharacterTier) =>
    run(() => api('PATCH', `/characters/${character.id}`, { tier }));
  const regenerate = () =>
    run(async () => {
      await api('POST', `/characters/${character.id}/draft`, { notes });
      setNotes('');
    });
  const merge = () => {
    const target = others.find((o) => o.id === mergeInto);
    if (target && confirm(`Merge ${character.name} into ${target.name}? This cannot be undone.`)) {
      void run(() => api('POST', `/characters/${character.id}/merge`, { intoId: mergeInto }));
    }
  };
  const reject = () => {
    if (confirm(`Reject ${character.name}? They will be removed from the chronicle's cast.`)) {
      void run(() => api('POST', `/characters/${character.id}/reject`));
    }
  };

  return (
    <div className="stack">
      {character.drafting && <Working label="Drafting the card…" />}
      {character.promotion && (
        <div className="notice toolbar">
          <span>
            Suggest promoting to {tierLabel(character.promotion.to)}: they{' '}
            {character.promotion.reasons.join(', and ')}.
          </span>
          <button
            className="quiet"
            disabled={busy}
            onClick={() => setTier(character.promotion!.to)}
          >
            Promote
          </button>
        </div>
      )}
      <div className="row">
        <SelectField
          label="Tier"
          value={character.tier}
          options={TIERS}
          format={tierLabel}
          readOnly={busy}
          onChange={setTier}
        />
        <TextField
          label="Also known as (comma separated)"
          value={aliases.join(', ')}
          onChange={(v) => setAliases(v.split(',').map((a) => a.trimStart()))}
        />
      </div>
      <CardFields
        tier={character.tier}
        card={card}
        onChange={setCard}
        missing={character.missing}
      />
      <ErrorNote error={error} />
      <div className="toolbar">
        {character.needsApproval ? (
          <button disabled={busy || character.drafting} onClick={approve}>
            Approve card
          </button>
        ) : (
          <button disabled={busy} onClick={save}>
            Save changes
          </button>
        )}
        {character.status === 'provisional' && (
          <button className="quiet" disabled={busy} onClick={reject}>
            Reject
          </button>
        )}
      </div>
      <details>
        <summary className="muted">Regenerate with notes</summary>
        <div className="stack">
          <TextField
            label="Notes for the card drafter"
            multiline
            value={notes}
            onChange={setNotes}
          />
          <div>
            <button className="quiet" disabled={busy || !notes.trim()} onClick={regenerate}>
              Regenerate card
            </button>
          </div>
        </div>
      </details>
      {others.length > 0 && (
        <details>
          <summary className="muted">This is the same person as…</summary>
          <div className="toolbar">
            <select
              aria-label="Merge into"
              value={mergeInto}
              onChange={(e) => setMergeInto(e.target.value)}
            >
              <option value="">Choose a character</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <button className="quiet" disabled={busy || !mergeInto} onClick={merge}>
              Merge
            </button>
          </div>
        </details>
      )}
      {history && <VersionHistory versions={history} tier={character.tier} />}
    </div>
  );
}

export function CharacterSummary({ c }: { c: CharacterView }) {
  return (
    <span className="inline">
      <strong>{c.name}</strong>
      <span className="badge">{tierLabel(c.tier)}</span>
      {c.needsApproval && <span className="badge anchor">Needs approval</span>}
      {c.drafting && <span className="badge">Drafting</span>}
      {c.promotion && <span className="badge plant">Promotion suggested</span>}
      {c.chapters.length > 0 && (
        <span className="muted small-print">chapters {c.chapters.join(', ')}</span>
      )}
    </span>
  );
}

/** Every character card in the book, with those needing the author first. */
export function CharactersScreen({ project }: { project: Project }) {
  const [characters, setCharacters] = useState<CharacterView[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);

  const reload = useCallback(async () => {
    try {
      setCharacters(await api<CharacterView[]>('GET', `/projects/${project.id}/characters`));
    } catch (err) {
      setError(errorText(err));
    }
  }, [project.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Card drafts are background jobs; poll while any are running.
  const drafting = characters?.some((c) => c.drafting);
  useEffect(() => {
    if (!drafting) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [drafting, reload]);

  if (error) return <ErrorNote error={error} />;
  if (!characters) return null;
  if (characters.length === 0) {
    return <p className="muted">Characters appear here once the first chapter is played.</p>;
  }

  const order = (c: CharacterView) => (c.needsApproval ? 0 : c.promotion ? 1 : 2);
  const sorted = [...characters].sort((a, b) => order(a) - order(b));
  return (
    <ul className="chapters">
      {sorted.map((c) => (
        <li key={c.id} className="card">
          <details open={c.needsApproval}>
            <summary>
              <CharacterSummary c={c} />
            </summary>
            <CardEditor
              character={c}
              others={characters.filter((o) => o.id !== c.id)}
              onChange={reload}
            />
          </details>
        </li>
      ))}
    </ul>
  );
}
