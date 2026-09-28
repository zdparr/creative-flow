import { type LoadedPrompt, loadPrompt } from '../prompts/loader.js';

/** Appends the house style rules to a prose-writing agent's prompt; both versions are logged. */
export function withHouseStyle(prompt: LoadedPrompt): LoadedPrompt {
  const house = loadPrompt('house-style');
  return {
    version: `${prompt.version}+${house.version}`,
    system: `${prompt.system}\n\n${house.system}`,
  };
}

// A dash is allowed only where cut-off speech ends: right before the closing quotation mark,
// or at the very end of a dialogue field that carries no quotation marks.
const DASHES = /[—–]| - /g;
const CLOSING_QUOTE = /^["”'’]/;

/**
 * Finds dashes the house style forbids: any en dash or spaced hyphen, and any em dash that is
 * not immediately followed by a closing quotation mark or the end of the text. Returns a short
 * excerpt for each.
 */
export function dashViolations(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(DASHES)) {
    const at = match.index;
    const after = text.slice(at + match[0].length);
    if (match[0] === '—' && (CLOSING_QUOTE.test(after) || after.trim() === '')) continue;
    found.push(
      text
        .slice(Math.max(0, at - 25), at + match[0].length + 25)
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  return found;
}

/** Problem lines for runStructuredAgent checks, naming where the forbidden dashes are. */
export function dashProblems(field: string, text: string): string[] {
  return dashViolations(text).map(
    (excerpt) =>
      `${field}: dash outside cut-off speech in "…${excerpt}…". Rewrite with a comma, period, semicolon, colon, or parentheses.`,
  );
}
