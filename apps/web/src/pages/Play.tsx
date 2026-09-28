import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText, streamPost } from '../api.js';
import { ErrorNote, Working, humanize } from '../components.js';
import { navigate } from '../router.js';
import type { Beat, PlayState, Turn } from '../types.js';

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

export function PlayScreen({ projectId, chapterId }: { projectId: string; chapterId: string }) {
  const [state, setState] = useState<PlayState | null>(null);
  const [live, setLive] = useState<{ author?: Turn; text: string; npc?: string } | null>(null);
  const [kind, setKind] = useState<InputKind>('in_character');
  const [text, setText] = useState('');
  const [interiority, setInteriority] = useState('');
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    setState(await api<PlayState>('GET', `/chapters/${chapterId}`));
  }, [chapterId]);

  useEffect(() => {
    reload().catch((e) => setError(errorText(e)));
  }, [reload]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [live?.text, state?.turns.length]);

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
            <TurnView key={t.id} turn={t} />
          ))}
          {live?.author && <TurnView turn={live.author} />}
          {live && (
            <div className="narration streaming">
              <Prose text={live.text} />
              {live.npc && <p className="muted">{live.npc} is responding…</p>}
              {!live.text && !live.npc && <Working label="The story continues…" />}
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

        {chapter.status === 'drafting' && (
          <div className="card stack">
            <p>Chapter ended. Novelizing and review arrive in Phase 5.</p>
            <div>
              <button
                onClick={() =>
                  action(() => api<PlayState>('POST', `/chapters/${chapterId}/reopen`))
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
