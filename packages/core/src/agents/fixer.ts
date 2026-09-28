import { z } from 'zod';
import { type AgentContext, runStructuredAgent } from '../llm/runAgent.js';
import { withHouseStyle } from '../prose/houseStyle.js';
import { proseProblems } from '../prose/rules.js';
import { loadPrompt } from '../prompts/loader.js';
import type { BibleContent } from '../schemas/bible.js';
import type { CohesionIssue } from '../schemas/cohesion.js';

export const fixOutputSchema = z.object({
  edits: z
    .array(
      z.object({
        paragraph: z.number().int().describe('1-based number of the paragraph to replace'),
        text: z.string().describe('The full replacement paragraph'),
      }),
    )
    .describe('Only the paragraphs that change'),
  explanation: z.string().describe('One or two sentences for the author: what changed and why'),
});
export type FixOutput = z.infer<typeof fixOutputSchema>;

export interface FixerInput {
  bible: BibleContent;
  paragraphs: string[];
  issue: CohesionIssue;
}

/** Proposes replacement paragraphs that fix one cohesion issue, for the author to approve. */
export async function runFixer(ctx: AgentContext, input: FixerInput): Promise<FixOutput> {
  const { styleGuide } = input.bible;
  const { issue } = input;
  const content = [
    `# Style guide\nPOV: ${styleGuide.pov}${styleGuide.povCharacter ? ` (${styleGuide.povCharacter})` : ''}, tense: ${styleGuide.tense}. Register: ${styleGuide.register}. Banned phrases: ${styleGuide.bannedPhrases.join('; ') || '(none)'}`,
    `# The problem\nSeverity: ${issue.severity}\nCategory: ${issue.category}\nWhere: ${issue.paragraph > 0 ? `paragraph ${issue.paragraph}` : 'the whole chapter'}\nWhat is wrong: ${issue.description}\nEvidence: ${issue.evidence}\nSuggested fix: ${issue.suggestedFix}`,
    `# The draft (numbered paragraphs)\n${input.paragraphs.map((p, i) => `[${i + 1}] ${p}`).join('\n\n')}`,
    '# Your task\nRevise only the paragraphs needed to fix the problem.',
  ].join('\n\n');

  const out = await runStructuredAgent(ctx, {
    agent: 'fixer',
    prompt: withHouseStyle(loadPrompt('fixer')),
    tier: 'strong',
    messages: [{ role: 'user', content }],
    schema: fixOutputSchema,
    maxTokens: 16000,
    check: (o) => [
      ...(o.edits.length === 0 ? ['edits: change at least one paragraph'] : []),
      ...o.edits
        .filter((e) => e.paragraph < 1 || e.paragraph > input.paragraphs.length)
        .map(
          (e) => `edits: paragraph ${e.paragraph} does not exist (1-${input.paragraphs.length})`,
        ),
      ...o.edits.flatMap((e) =>
        proseProblems(e.text, styleGuide.bannedPhrases).map(
          (p) => `paragraph ${e.paragraph}: ${p}`,
        ),
      ),
    ],
  });
  // One paragraph per edit, keeping numbering stable; the last edit to a paragraph wins.
  const byParagraph = new Map(
    out.edits.map((e) => [e.paragraph, e.text.replace(/\s*\n\s*/g, ' ').trim()]),
  );
  return {
    explanation: out.explanation,
    edits: [...byParagraph]
      .sort(([a], [b]) => a - b)
      .map(([paragraph, text]) => ({ paragraph, text })),
  };
}
