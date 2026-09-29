import { z } from 'zod';
import { type AgentContext, runStructuredAgent } from '../llm/runAgent.js';
import { withHouseStyle } from '../prose/houseStyle.js';
import { proseProblems } from '../prose/rules.js';
import { loadPrompt } from '../prompts/loader.js';
import type { CohesionIssue } from '../schemas/cohesion.js';
import { type CriticInput, cohesionSections, numberedDraft } from './critic.js';

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
  /** The same context the cohesion critic checks against, including the draft. */
  context: CriticInput;
  issue: CohesionIssue;
  /** The report's other open issues, which the fix must not make worse. */
  otherIssues: CohesionIssue[];
}

const describe = (i: CohesionIssue) =>
  `- [${i.severity} ${i.category}, ${i.paragraph > 0 ? `paragraph ${i.paragraph}` : 'whole chapter'}] ${i.description}`;

/**
 * Proposes replacement paragraphs that fix one cohesion issue, for the author to approve. It
 * revises against everything the critic checks, so a fix does not create a new problem.
 */
export async function runFixer(ctx: AgentContext, input: FixerInput): Promise<FixOutput> {
  const { issue, context } = input;
  const { paragraphs } = context;
  const content = [
    ...cohesionSections(context),
    numberedDraft(paragraphs),
    `# The problem to fix\nSeverity: ${issue.severity}\nCategory: ${issue.category}\nWhere: ${issue.paragraph > 0 ? `paragraph ${issue.paragraph}` : 'the whole chapter'}\nWhat is wrong: ${issue.description}\nEvidence: ${issue.evidence}\nSuggested fix: ${issue.suggestedFix}`,
    `# Other open issues (do not make these worse or add new ones)\n${input.otherIssues.map(describe).join('\n') || '(none)'}`,
    '# Your task\nRevise only the paragraphs needed to fix the problem. Before answering, check your revision against every card, knowledge entry, ledger fact, promise, and required beat above.',
  ].join('\n\n');

  const banned = context.bible.styleGuide.bannedPhrases;
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
        .filter((e) => e.paragraph < 1 || e.paragraph > paragraphs.length)
        .map((e) => `edits: paragraph ${e.paragraph} does not exist (1-${paragraphs.length})`),
      ...o.edits.flatMap((e) =>
        proseProblems(e.text, banned).map((p) => `paragraph ${e.paragraph}: ${p}`),
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
