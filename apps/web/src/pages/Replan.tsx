import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import { ErrorNote, Problems, Working } from '../components.js';
import type { OutlineChapter, ReplanView } from '../types.js';

type Field = { label: string; render: (c: OutlineChapter) => string };

const FIELDS: Field[] = [
  { label: 'Title', render: (c) => c.title },
  { label: 'Purpose', render: (c) => c.purpose },
  {
    label: 'Required beats',
    render: (c) => c.requiredBeats.map((b) => `• ${b.description}`).join('\n'),
  },
  {
    label: 'Arcs moved',
    render: (c) => c.arcsMoved.map((a) => `• ${a.character}: ${a.change}`).join('\n'),
  },
  {
    label: 'Promises',
    render: (c) =>
      [
        ...c.promises.planted.map((p) => `• Plants: ${p.description} (by ch ${p.payoffChapter})`),
        ...c.promises.paid.map((p) => `• Pays: ${p}`),
      ].join('\n'),
  },
];

/** Re-plan diffs proposed after each lock; the author accepts or rejects every change. */
export function ReplanPanel({
  projectId,
  onApplied,
}: {
  projectId: string;
  onApplied: () => void;
}) {
  const [view, setView] = useState<ReplanView | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setView(await api<ReplanView>('GET', `/projects/${projectId}/replan`));
    } catch (err) {
      setError(errorText(err));
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const working = view?.job?.status === 'queued' || view?.job?.status === 'running';
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [working, reload]);

  async function decide(diffId: string, itemId: string, decision: 'accept' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      setView(
        await api<ReplanView>('POST', `/projects/${projectId}/replan/${diffId}`, {
          itemId,
          decision,
        }),
      );
      if (decision === 'accept') onApplied();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!view) return null;
  return (
    <>
      {working && <Working label="Re-planning the remaining chapters…" />}
      {view.job?.status === 'failed' && (
        <Problems title="The re-plan failed" problems={[view.job.error ?? 'Unknown error']} />
      )}
      <ErrorNote error={error} />
      {view.diffs.map((diff) => (
        <div key={diff.id} className="card stack replan">
          <h2>Proposed changes after chapter {diff.afterChapter} locked</h2>
          {diff.items.map((item) => (
            <div key={item.id} className="stack replan-item">
              <div className="toolbar">
                <strong>Chapter {item.chapter}</strong>
                <span className="muted">{item.reason}</span>
              </div>
              <dl className="diff">
                {FIELDS.filter((f) => f.render(item.before) !== f.render(item.after)).map((f) => (
                  <div key={f.label}>
                    <dt>{f.label}</dt>
                    <dd>
                      <del>{f.render(item.before) || '(none)'}</del>
                      <ins>{f.render(item.after) || '(none)'}</ins>
                    </dd>
                  </div>
                ))}
              </dl>
              {item.decision ? (
                <span className="badge">
                  {item.decision === 'accepted' ? 'Accepted' : 'Rejected'}
                </span>
              ) : (
                <div className="toolbar">
                  <button disabled={busy} onClick={() => decide(diff.id, item.id, 'accept')}>
                    Accept
                  </button>
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={() => decide(diff.id, item.id, 'reject')}
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
