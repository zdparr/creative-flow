import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText, streamPost } from '../api.js';
import { ErrorNote, Working, humanize } from '../components.js';
import { navigate } from '../router.js';
import type { Beat, DriftView, PlayState, Turn } from '../types.js';
import { CardEditor, CharacterSummary } from './Characters.js';

type InputKind = 'in_character' | 'author_note';

function Prose({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .map((p, i) => (
          <p key={i}>{p}</p>
        ))}
    </>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === 'director') {
    return (
      <div className="narration">
        <Prose text={turn.content} />
      </div>
    );
  }
  if (turn.role === 'npc') return null; // Woven into the director's narration.
  if (turn.inputKind === 'author_note') {
    return <p className="author-note">Author note: {turn.content}</p>;
  }
  return <p className="player-move">{turn.content}</p>;
}

const DRIFT_LABELS: Record<DriftView['kind'], string> = {
  beat: 'Off the planned beat',
  contradiction: 'Contradicts the ledger',
  thread: 'New major thread',
  principle: 'A character breaks type',
};
const ADOPT_LABELS: Record<DriftView['kind'], string> = {
  beat: 'the outline beat becomes',
  contradiction: 'the ledger fact becomes',
  thread: 'a new promise to pay off',
  principle: "the character's card records",
};

/** A drift notice, inline after the turn that raised it: steer back or adopt. Never silent. */
function DriftNotice({
  drift,
  actionable,
  onResolve,
}: {
  drift: DriftView;
  actionable: boolean;
  onResolve: (resolution: 'steer' | 'adopt') => void;
}) {
  return (
    <aside className={`drift${drift.resolution ? ' resolved' : ''}`} role="note">
      <strong>{DRIFT_LABELS[drift.kind]}:</strong> {drift.description}
      {drift.adoptText && (
        <div className="muted small-print">
          If adopted, {ADOPT_LABELS[drift.kind]}: {drift.adoptText}
        </div>
      )}
      {drift.resolution ? (
        <div className="muted small-print">
          {drift.resolution === 'steer' ? 'Steering back to the plan.' : 'Adopted.'}
        </div>
      ) : (
        actionable && (
          <div className="toolbar">
            <button className="quiet" onClick={() => onResolve('steer')}>
              Steer back
            </button>
            <button className="quiet" onClick={() => onResolve('adopt')}>
              Adopt
            </button>
          </div>
        )
      )}
    </aside>
  );
}

export function PlayScreen({ projectId, chapterId }: { projectId: string; chapterId: string }) {
  const [state, setState] = useState<PlayState | null>(null);
  const [live, setLive] = useState<{ author?: Turn; text: string; npc?: string } | null>(null);
  const [kind, setKind] = useState<InputKind>('in_character');
  const [text, setText] = useState('');
  const [interiority, setInteriority] = useState('');
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);
  const [busy, setBusy] = useState(false);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const inFlight = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    setState(await api<PlayState>('GET', `/chapters/${chapterId}`));
  }, [chapterId]);

  useEffect(() => {
    reload().catch((e) => setError(errorText(e)));
  }, [reload]);

  // Card drafts run as background jobs; refresh the tray while any are being drafted.
  const drafting = state?.cardTray.some((c) => c.drafting);
  useEffect(() => {
    if (!drafting || busy) return;
    const timer = setInterval(() => void reload().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [drafting, busy, reload]);

  // Open at the latest turn, then leave scrolling to the reader: when a turn starts streaming,
  // bring its start into view once and let the text grow below without following it.
  const loaded = state !== null;
  useEffect(() => {
    if (loaded) endRef.current?.scrollIntoView({ block: 'end' });
  }, [loaded]);
  const streaming = live !== null;
  useEffect(() => {
    if (streaming) liveRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [streaming]);

  /** Runs one streamed turn: shows text as it arrives, then reloads the authoritative state. */
  async function stream(path: string, body?: unknown, author?: Turn) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setWarning(null);
    setLive({ author, text: '' });
    try {
      await streamPost(path, body, (event, data) => {
        if (event === 'delta') {
          const delta = (data as { text: string }).text;
          setLive((l) => ({ ...l, text: (l?.text ?? '') + delta, npc: undefined }));
        } else if (event === 'npc') {
          setLive((l) => ({ ...l, text: l?.text ?? '', npc: (data as { name: string }).name }));
        } else if (event === 'warning') {
          setWarning((data as { message: string }).message);
        } else if (event === 'chronicle') {
          const beats = (data as { beats: Beat[] }).beats;
          setState((s) => (s ? { ...s, beats } : s));
        }
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      await reload().catch(() => {});
      setLive(null);
      setBusy(false);
      inFlight.current = false;
    }
  }

  async function send() {
    const trimmed = text.trim();
    if (!trimmed || !state) return;
    const author: Turn = {
      id: 'pending',
      seq: 0,
      role: 'author',
      inputKind: kind,
      content: trimmed,
    };
    setText('');
    const note = interiority;
    setInteriority('');
    await stream(
      `/chapters/${chapterId}/turns`,
      { kind, text: trimmed, interiority: note || undefined },
      author,
    );
  }

  async function action(fn: () => Promise<PlayState>) {
    setError(null);
    try {
      setState(await fn());
    } catch (err) {
      setError(errorText(err));
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };

  if (!state) return <main className="shell">{error ? <ErrorNote error={error} /> : null}</main>;

  const { chapter, plan } = state;
  const playing = chapter.status === 'playing';
  const notStarted = chapter.status === 'planned' || (playing && state.turns.length === 0);

  return (
    <main className="play">
      <div className="story">
        <header className="story-head">
          <button className="quiet" onClick={() => navigate(`/projects/${projectId}/chapters`)}>
            ← {state.project.title}
          </button>
          <h1>
            Chapter {chapter.number}: {plan.title}
          </h1>
          <span className="badge">{humanize(chapter.status)}</span>
        </header>

        <article className="pane" aria-live="polite">
          {state.turns.map((t) => (
            <div key={t.id}>
              <TurnView turn={t} />
              {state.drift
                .filter((d) => d.turnId === t.id)
                .map((d) => (
                  <DriftNotice
                    key={d.id}
                    drift={d}
                    actionable={playing && !busy}
                    onResolve={(resolution) =>
                      action(() =>
                        api<PlayState>('POST', `/chapters/${chapterId}/drift/${d.id}`, {
                          resolution,
                        }),
                      )
                    }
                  />
                ))}
            </div>
          ))}
          {live && (
            <div ref={liveRef}>
              {live.author && <TurnView turn={live.author} />}
              <div className="narration streaming">
                <Prose text={live.text} />
                {live.npc && <p className="muted">{live.npc} is responding…</p>}
                {!live.text && !live.npc && <Working label="The story continues…" />}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </article>

        {warning && <p className="notice">{warning}</p>}
        <ErrorNote error={error} />

        {notStarted && !busy && (
          <div>
            <button onClick={() => stream(`/chapters/${chapterId}/start`)}>
              {chapter.status === 'planned' ? 'Begin chapter' : 'Try the opening again'}
            </button>
          </div>
        )}

        {playing && state.awaitingResponse && !busy && (
          <div>
            <button onClick={() => stream(`/chapters/${chapterId}/turns/retry`)}>
              Retry the last turn
            </button>
          </div>
        )}

        {playing && !notStarted && !state.awaitingResponse && (
          <div className="composer card">
            <div className="choice" role="radiogroup" aria-label="Input type">
              {(['in_character', 'author_note'] as const).map((k) => (
                <button
                  key={k}
                  role="radio"
                  aria-checked={kind === k}
                  className={kind === k ? 'quiet on' : 'quiet'}
                  onClick={() => setKind(k)}
                >
                  {k === 'in_character' ? 'In character' : 'Author note'}
                </button>
              ))}
            </div>
            <label htmlFor="turn-input" className="visually-hidden">
              Your turn
            </label>
            <textarea
              id="turn-input"
              rows={3}
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              placeholder={
                kind === 'in_character'
                  ? 'What does the protagonist do or say?'
                  : 'Direct the story out of character, e.g. "a storm breaks"'
              }
            />
            <details>
              <summary className="muted">What is going through their head? (optional)</summary>
              <textarea
                rows={2}
                value={interiority}
                disabled={busy}
                aria-label="Interiority note"
                onChange={(e) => setInteriority(e.target.value)}
                placeholder="Saved with this moment for the prose draft"
              />
            </details>
            <div className="toolbar">
              <button onClick={send} disabled={busy || !text.trim()}>
                Send
              </button>
              <span className="muted small-print">Ctrl+Enter to send</span>
            </div>
          </div>
        )}

        {!playing && chapter.status !== 'planned' && (
          <div className="card stack">
            <p>
              {chapter.status === 'drafting'
                ? 'Chapter ended. The prose draft is being written and checked.'
                : chapter.status === 'locked'
                  ? 'This chapter is locked.'
                  : 'The draft is ready for your review.'}
            </p>
            <div className="toolbar">
              <button onClick={() => navigate(`/projects/${projectId}/review/${chapterId}`)}>
                Open review
              </button>
            </div>
          </div>
        )}
      </div>

      <aside className="side">
        <section>
          <h2>Chapter goal</h2>
          <p>{plan.purpose}</p>
        </section>

        <section>
          <h2>Beats</h2>
          <ul className="beats">
            {state.beats.map((b) => (
              <li key={b.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={b.hit}
                    disabled={!playing || busy || b.source === 'play'}
                    title={b.source === 'play' ? 'Hit in play' : 'Mark as hit by hand'}
                    onChange={(e) =>
                      action(() =>
                        api<PlayState>('POST', `/chapters/${chapterId}/beats/${b.id}`, {
                          hit: e.target.checked,
                        }),
                      )
                    }
                  />{' '}
                  {b.description}
                  {b.source === 'author' && <span className="muted"> (marked by you)</span>}
                </label>
              </li>
            ))}
          </ul>
          {playing && (
            <button
              disabled={!state.canEnd || busy}
              title={state.canEnd ? undefined : 'Every beat must land first'}
              onClick={() => {
                if (confirm('End this chapter? You can return to play until it is drafted.')) {
                  void action(() => api<PlayState>('POST', `/chapters/${chapterId}/end`));
                }
              }}
            >
              End chapter
            </button>
          )}
        </section>

        {state.cardTray.length > 0 && (
          <section>
            <h2>Cards to review ({state.cardTray.length})</h2>
            {busy ? (
              <p className="muted small-print">Available when this turn finishes.</p>
            ) : (
              <ul className="plain tray">
                {state.cardTray.map((c) => (
                  <li key={c.id}>
                    <button
                      className="quiet"
                      aria-expanded={openCard === c.id}
                      onClick={() => setOpenCard(openCard === c.id ? null : c.id)}
                    >
                      <CharacterSummary c={c} />
                    </button>
                    {openCard === c.id && (
                      <div className="card">
                        <CardEditor
                          character={c}
                          others={[...state.sceneCharacters, ...state.cardTray].filter(
                            (o, i, all) =>
                              o.id !== c.id && all.findIndex((x) => x.id === o.id) === i,
                          )}
                          onChange={() => void reload().catch(() => {})}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section>
          <h2>In scene</h2>
          {state.sceneCharacters.length === 0 ? (
            <p className="muted">No one yet.</p>
          ) : (
            <ul className="plain">
              {state.sceneCharacters.map((c) => (
                <li key={c.id}>
                  {c.name} <span className="muted">({humanize(c.tier)})</span>
                  {c.status === 'provisional' && <span className="badge">New</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        {state.openPromises.length > 0 && (
          <section>
            <h2>Open promises</h2>
            <ul className="plain">
              {state.openPromises.map((p) => (
                <li key={p.description}>
                  {p.description} <span className="muted">(by chapter {p.payoffChapter})</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <details>
            <summary>
              <h2 className="inline-heading">Chronicle ({state.chronicle.length})</h2>
            </summary>
            <ol className="chronicle">
              {state.chronicle.map((e) => (
                <li key={e.id} className={e.isCanon ? '' : 'struck'}>
                  {e.summary}
                  {playing && (
                    <button
                      className="quiet"
                      onClick={() =>
                        action(() =>
                          api<PlayState>('PATCH', `/chapters/${chapterId}/chronicle/${e.id}`, {
                            isCanon: !e.isCanon,
                          }),
                        )
                      }
                    >
                      {e.isCanon ? 'Remove from canon' : 'Restore'}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </details>
        </section>
      </aside>
    </main>
  );
}
