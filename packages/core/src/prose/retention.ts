// How much of a text survives a revision, word for word and in order. The deepening pass uses
// it to keep its edits additive, and the prose eval uses it to compare a revision with the
// human editor's.

/** Lowercased words with punctuation and italic markers stripped, so mechanics changes are free. */
export function proseWords(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/’/g, "'")
      .match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) ?? []
  );
}

/** Length of the longest common subsequence of two word lists. */
export function lcsLength(a: readonly string[], b: readonly string[]): number {
  let prev = new Int32Array(b.length + 1);
  let row = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
    }
    [prev, row] = [row, prev];
  }
  return prev[b.length]!;
}

export interface Retention {
  originalWords: number;
  revisedWords: number;
  /** Original words kept in order. */
  kept: number;
  /** Share of the original kept, 0-1. */
  retained: number;
  /** Change in length relative to the original, e.g. 0.11 for 11% longer. */
  growth: number;
}

export function retention(original: string, revised: string): Retention {
  const a = proseWords(original);
  const b = proseWords(revised);
  const kept = lcsLength(a, b);
  return {
    originalWords: a.length,
    revisedWords: b.length,
    kept,
    retained: a.length ? kept / a.length : 1,
    growth: a.length ? (b.length - a.length) / a.length : 0,
  };
}
