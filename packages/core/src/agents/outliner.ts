import { validateOutline } from '../domain/validation.js';
import { type AgentContext, runStructuredAgent } from '../llm/runAgent.js';
import { loadPrompt } from '../prompts/loader.js';
import type { BibleContent } from '../schemas/bible.js';
import {
  type OutlineChapter,
  type OutlinerOutput,
  outlinerOutputSchema,
} from '../schemas/outline.js';

export interface OutlinerInput {
  bible: BibleContent;
  /** The outline being replaced, when regenerating with notes. */
  previous?: OutlineChapter[];
  notes?: string;
}

export async function runOutliner(
  ctx: AgentContext,
  input: OutlinerInput,
): Promise<OutlinerOutput> {
  const parts = [`# Approved story bible\n${JSON.stringify(input.bible, null, 2)}`];
  if (input.previous) {
    parts.push(`# Previous outline\n${JSON.stringify(input.previous, null, 2)}`);
  }
  parts.push(
    `# Your task\nWrite the chapter outline: exactly ${input.bible.spine.chapterCount} chapters, numbered from 1, with every anchor beat in its target chapter.`,
  );
  if (input.notes) parts.push(`# Author's notes on the previous outline\n${input.notes}`);

  return runStructuredAgent(ctx, {
    agent: 'outliner',
    prompt: loadPrompt('outliner'),
    tier: 'strong',
    messages: [{ role: 'user', content: parts.join('\n\n') }],
    schema: outlinerOutputSchema,
    maxTokens: 64000,
    check: (out) => validateOutline(out.chapters, input.bible.spine),
  });
}
