import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { ErrorNote, Working } from '../components.js';
import { navigate } from '../router.js';
import type { InterviewAnswer, InterviewRound, InterviewStep, Project } from '../types.js';

const MAX_ROUNDS = 5;

type Draft = Record<string, InterviewAnswer>;

export function InterviewScreen({
  project,
  onAdvance,
}: {
  project: Project;
  onAdvance: () => Promise<void>;
}) {
  const [rounds, setRounds] = useState<InterviewRound[] | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);
  // Guards against a second concurrent request (StrictMode double effects, double clicks).
  const inFlight = useRef(false);

  const live = project.status === 'intake';
  const pending = rounds?.find((r) => r.answers === null) ?? null;
  const answered = rounds?.filter((r) => r.answers !== null) ?? [];

  const handleStep = useCallback(
    async (step: InterviewStep) => {
      if (step.kind === 'bible') {
        await onAdvance();
        navigate(`/projects/${project.id}/bible`);
        return;
      }
      setRounds((prev) => [...(prev ?? []).filter((r) => r.id !== step.round.id), step.round]);
      setDraft({});
    },
    [onAdvance, project.id],
  );

  const advance = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setThinking(true);
    setError(null);
    try {
      await handleStep(await api<InterviewStep>('POST', `/projects/${project.id}/interview/next`));
    } catch (err) {
      setError(errorText(err));
    } finally {
      inFlight.current = false;
      setThinking(false);
    }
  }, [handleStep, project.id]);

  useEffect(() => {
    api<InterviewRound[]>('GET', `/projects/${project.id}/interview`).then(setRounds, (e) =>
      setError(errorText(e)),
    );
  }, [project.id]);

  // With no pending round, ask the interviewer for the next one.
  useEffect(() => {
    if (live && rounds !== null && !pending && !thinking && !error) void advance();
  }, [live, rounds, pending, thinking, error, advance]);

  async function submit() {
    if (!pending || inFlight.current) return;
    inFlight.current = true;
    setThinking(true);
    setError(null);
    try {
      const answers = pending.questions.map(
        (q) => draft[q.id] ?? { questionId: q.id, kind: 'skip' as const, text: '' },
      );
      await handleStep(
        await api<InterviewStep>('POST', `/projects/${project.id}/interview/answers`, {
          roundId: pending.id,
          answers,
        }),
      );
      setRounds((prev) => (prev ?? []).map((r) => (r.id === pending.id ? { ...r, answers } : r)));
    } catch (err) {
      setError(errorText(err));
    } finally {
      inFlight.current = false;
      setThinking(false);
    }
  }

  const set = (questionId: string, patch: Partial<InterviewAnswer>) =>
    setDraft((d) => {
      const prev = d[questionId] ?? { questionId, kind: 'answer' as const, text: '' };
      return { ...d, [questionId]: { ...prev, ...patch } };
    });

  return (
    <section className="stack">
      <details className="card">
        <summary>Your pitch</summary>
        <p>{project.createdFromPitch}</p>
      </details>

      {answered.map((r) => (
        <details key={r.id} className="card">
          <summary>Round {r.roundNo}</summary>
          <dl className="qa">
            {r.questions.map((q) => {
              const a = r.answers?.find((x) => x.questionId === q.id);
              return (
                <div key={q.id}>
                  <dt>{q.question}</dt>
                  <dd>
                    {!a || a.kind === 'skip' ? (
                      <em>Skipped</em>
                    ) : a.kind === 'you_decide' ? (
                      <em>You decide</em>
                    ) : (
                      a.text
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </details>
      ))}

      {live && pending && (
        <div className="card stack">
          <h2>
            Round {pending.roundNo} <span className="muted">of up to {MAX_ROUNDS}</span>
          </h2>
          {pending.questions.map((q) => {
            const a = draft[q.id];
            const kind = a?.kind ?? 'answer';
            return (
              <div key={q.id} className="question">
                <label htmlFor={`q-${q.id}`}>{q.question}</label>
                <textarea
                  id={`q-${q.id}`}
                  rows={2}
                  disabled={kind !== 'answer' || thinking}
                  value={kind === 'answer' ? (a?.text ?? '') : ''}
                  placeholder={
                    kind === 'skip' ? 'Skipped' : kind === 'you_decide' ? 'The AI will decide' : ''
                  }
                  onChange={(e) => set(q.id, { kind: 'answer', text: e.target.value })}
                />
                <div className="choice" role="group" aria-label="Answer options">
                  <button
                    type="button"
                    className={kind === 'skip' ? 'quiet on' : 'quiet'}
                    aria-pressed={kind === 'skip'}
                    onClick={() => set(q.id, { kind: kind === 'skip' ? 'answer' : 'skip' })}
                  >
                    Skip
                  </button>
                  <button
                    type="button"
                    className={kind === 'you_decide' ? 'quiet on' : 'quiet'}
                    aria-pressed={kind === 'you_decide'}
                    onClick={() =>
                      set(q.id, { kind: kind === 'you_decide' ? 'answer' : 'you_decide' })
                    }
                  >
                    You decide
                  </button>
                </div>
              </div>
            );
          })}
          <div>
            <button onClick={submit} disabled={thinking}>
              Send answers
            </button>
          </div>
        </div>
      )}

      {thinking && <Working label={pending ? 'Reading your answers…' : 'Thinking of questions…'} />}
      <ErrorNote error={error} />
      {error && live && !pending && (
        <div>
          <button onClick={advance} disabled={thinking}>
            Try again
          </button>
        </div>
      )}
      {!live && <p className="muted">The interview is finished.</p>}
    </section>
  );
}
