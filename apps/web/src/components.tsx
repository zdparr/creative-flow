import { type ReactNode, useId } from 'react';

export function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  rows?: number;
  readOnly?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      {props.multiline ? (
        <textarea
          id={id}
          rows={props.rows ?? 3}
          value={props.value}
          readOnly={props.readOnly}
          placeholder={props.placeholder}
          onChange={(e) => props.onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          value={props.value}
          readOnly={props.readOnly}
          placeholder={props.placeholder}
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
    </div>
  );
}

export function NumberField(props: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  readOnly?: boolean;
}) {
  const id = useId();
  return (
    <div className="field small">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        type="number"
        min={0}
        value={Number.isFinite(props.value) ? props.value : ''}
        readOnly={props.readOnly}
        onChange={(e) => props.onChange(Number.parseInt(e.target.value, 10))}
      />
    </div>
  );
}

export function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  readOnly?: boolean;
  format?: (value: T) => string;
}) {
  const id = useId();
  return (
    <div className="field small">
      <label htmlFor={id}>{props.label}</label>
      <select
        id={id}
        value={props.value}
        disabled={props.readOnly}
        onChange={(e) => props.onChange(e.target.value as T)}
      >
        {props.options.map((o) => (
          <option key={o} value={o}>
            {props.format ? props.format(o) : humanize(o)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Edits an array of items with add, remove, and per-item rendering. */
export function ListEditor<T>(props: {
  label: string;
  items: T[];
  onChange: (items: T[]) => void;
  newItem: () => T;
  render: (item: T, update: (item: T) => void) => ReactNode;
  readOnly?: boolean;
  addLabel?: string;
}) {
  const update = (i: number, item: T) =>
    props.onChange(props.items.map((x, j) => (j === i ? item : x)));
  return (
    <fieldset className="list">
      <legend>{props.label}</legend>
      {props.items.map((item, i) => (
        <div className="list-item" key={i}>
          <div className="list-body">{props.render(item, (next) => update(i, next))}</div>
          {!props.readOnly && (
            <button
              type="button"
              className="quiet"
              aria-label={`Remove item ${i + 1}`}
              onClick={() => props.onChange(props.items.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      {!props.readOnly && (
        <button
          type="button"
          className="quiet"
          onClick={() => props.onChange([...props.items, props.newItem()])}
        >
          {props.addLabel ?? 'Add'}
        </button>
      )}
    </fieldset>
  );
}

/** One string per line, for simple string lists. */
export function LinesField(props: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  readOnly?: boolean;
}) {
  return (
    <TextField
      label={`${props.label} (one per line)`}
      multiline
      rows={Math.max(3, props.value.length + 1)}
      value={props.value.join('\n')}
      readOnly={props.readOnly}
      onChange={(v) => props.onChange(v.split('\n'))}
    />
  );
}

export function Problems({ title, problems }: { title: string; problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <div className="problems" role="alert">
      <strong>{title}</strong>
      <ul>
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

export function ErrorNote({ error }: { error: { message: string; problems: string[] } | null }) {
  if (!error) return null;
  return <Problems title={error.message} problems={error.problems.length ? error.problems : []} />;
}

export function Working({ label }: { label: string }) {
  return (
    <p className="working" role="status">
      <span className="dot" aria-hidden /> {label}
    </p>
  );
}

export function humanize(value: string): string {
  const s = value.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const STATUS_LABELS: Record<string, string> = {
  intake: 'Interview',
  bible_review: 'Bible review',
  outline_review: 'Outline review',
  writing: 'Writing',
  assembling: 'Assembling',
  complete: 'Complete',
};

/** Prose with its *italic* markers rendered as emphasis. */
export function ProseText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(/\*([^*\n]+)\*/g)) {
    if (m.index > at) parts.push(text.slice(at, m.index));
    parts.push(<em key={m.index}>{m[1]}</em>);
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
