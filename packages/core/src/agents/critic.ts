import { type CharacterCard, renderCard } from '../context/buildContext.js';
import { type AgentContext, runStructuredAgent } from '../llm/runAgent.js';
import { loadPrompt } from '../prompts/loader.js';
import type { BibleContent } from '../schemas/bible.js';
import { type CriticOutput, criticOutputSchema } from '../schemas/cohesion.js';
import type { OutlineChapter } from '../schemas/outline.js';

export interface CriticInput {
  bible: BibleContent;
  chapterNumber: number;
  plan: OutlineChapter;
  paragraphs: string[];
  /** Cards as they stood in this chapter, for everyone in it. */
  cards: CharacterCard[];
  /** What each character knew before this chapter. */
  knowledge: { character: string; statement: string; learnedChapter: number; howLearned: string }[];
  openPromises: { id: string; description: string; from: number; to: number }[];
  /** The full continuity ledger (facts not superseded). */
  ledger: { chapter: number; kind: string; statement: string }[];
  checkpointsDue: { character: string; chapter: number; description: string }[];
  /** Setups the extractor noticed during play, as hints for promisesPlanted. */
  candidatePromises: string[];
}

export function buildCriticPrompt(input: CriticInput): string {
  const { spine, styleGuide } = input.bible;
  return [
    `# Spine\nCentral question: ${spine.centralQuestion}\nTheme: ${spine.theme}\nEnding: ${spine.ending.resolution} (cost: ${spine.ending.cost})\nChapters: ${spine.chapterCount}`,
    `# Style guide\nPOV: ${styleGuide.pov}${styleGuide.povCharacter ? ` (${styleGuide.povCharacter})` : ''}, tense: ${styleGuide.tense}. Register: ${styleGuide.register}. Banned phrases: ${styleGuide.bannedPhrases.join('; ') || '(none)'}`,
    `# Chapter ${input.chapterNumber} plan: ${input.plan.title}\nPurpose: ${input.plan.purpose}\nRequired beats:\n${input.plan.requiredBeats.map((b) => `- ${b.id}: ${b.description}`).join('\n')}\nPlanned promises: ${JSON.stringify(input.plan.promises)}`,
    `# Character cards (as of this chapter)\n${input.cards.map(renderCard).join('\n') || '(none)'}`,
    `# Knowledge map (what each character knew before this chapter)\n${input.knowledge.map((k) => `- ${k.character} knows: ${k.statement} (since chapter ${k.learnedChapter}, ${k.howLearned})`).join('\n') || '(nothing recorded yet: characters know only their own cards and what they witness)'}`,
    `# Continuity ledger\n${input.ledger.map((f) => `- [ch ${f.chapter}, ${f.kind}] ${f.statement}`).join('\n') || '(empty)'}`,
    `# Open promises\n${input.openPromises.map((p) => `- id ${p.id}: ${p.description} (pay off in chapters ${p.from}-${p.to})`).join('\n') || '(none)'}`,
    `# Arc checkpoints due by this chapter\n${input.checkpointsDue.map((c) => `- ${c.character}, chapter ${c.chapter}: ${c.description}`).join('\n') || '(none)'}`,
    `# Setups noticed during play\n${input.candidatePromises.map((p) => `- ${p}`).join('\n') || '(none)'}`,
    `# The draft (numbered paragraphs)\n${input.paragraphs.map((p, i) => `[${i + 1}] ${p}`).join('\n\n')}`,
  ].join('\n\n');
}

/** Checks a draft against the book's cohesion structures. */
export async function runCohesionCritic(
  ctx: AgentContext,
  input: CriticInput,
): Promise<CriticOutput> {
  const promiseIds = new Set(input.openPromises.map((p) => p.id));
  const names = new Set(input.cards.map((c) => c.name.toLowerCase()));
  return runStructuredAgent(ctx, {
    agent: 'critic',
    prompt: loadPrompt('critic'),
    tier: 'strong',
    messages: [{ role: 'user', content: buildCriticPrompt(input) }],
    schema: criticOutputSchema,
    maxTokens: 32000,
    check: (out) => [
      ...out.issues
        .filter((i) => i.paragraph < 0 || i.paragraph > input.paragraphs.length)
        .map(
          (i) =>
            `issues: paragraph ${i.paragraph} does not exist (1-${input.paragraphs.length}, or 0)`,
        ),
      ...out.paidPromiseIds
        .filter((id) => !promiseIds.has(id))
        .map((id) => `paidPromiseIds: "${id}" is not an open promise id`),
      ...out.checkpointsMet
        .filter((c) => !names.has(c.character.toLowerCase()))
        .map((c) => `checkpointsMet: "${c.character}" is not a character in this chapter`),
      ...out.promisesPlanted
        .filter(
          (p) =>
            p.payoffChapter < input.chapterNumber ||
            p.payoffChapter > input.bible.spine.chapterCount,
        )
        .map(
          (p) =>
            `promisesPlanted: "${p.description}" pays off outside chapters ${input.chapterNumber}-${input.bible.spine.chapterCount}`,
        ),
    ],
  });
}
