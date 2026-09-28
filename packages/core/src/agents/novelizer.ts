import { type CharacterCard, renderCard } from '../context/buildContext.js';
import { costUsd } from '../llm/pricing.js';
import type { AgentContext } from '../llm/runAgent.js';
import { withHouseStyle } from '../prose/houseStyle.js';
import { proseProblems } from '../prose/rules.js';
import { loadPrompt } from '../prompts/loader.js';
import type { BibleContent } from '../schemas/bible.js';
import type { OutlineChapter } from '../schemas/outline.js';

/** One canon chronicle event, as the novelizer sees it. */
export interface NovelizerEvent {
  summary: string;
  characters: string[];
  location: string | null;
  interiorityNote: string | null;
  authorNote: string | null;
  /** Lines actually spoken in play during this event. */
  dialogue: string[];
}

export interface NovelizerInput {
  bible: BibleContent;
  chapterNumber: number;
  plan: OutlineChapter;
  events: NovelizerEvent[];
  cards: CharacterCard[];
  /** Full prose of the previous chapter, for voice continuity. */
  previousProse: string | null;
  targetWords: number;
  /** Regenerate with notes: the author's notes and the draft they are about. */
  notes?: string;
  currentDraft?: string;
}

/** Quoted speech in a turn, so the novelizer gets key dialogue without the raw turn log. */
export function keyDialogue(text: string): string[] {
  return [...text.matchAll(/["“]([^"”]{2,})["”]/g)].map((m) => m[1]!.trim());
}

export function buildNovelizerPrompt(input: NovelizerInput): string {
  const { styleGuide } = input.bible;
  const parts = [
    `# Style guide\nPOV: ${styleGuide.pov}${styleGuide.povCharacter ? ` (${styleGuide.povCharacter})` : ''}\nTense: ${styleGuide.tense}\nRegister: ${styleGuide.register}\nBanned phrases: ${styleGuide.bannedPhrases.join('; ') || '(none)'}\n\nSample paragraphs:\n${styleGuide.samples.map((s) => `> ${s}`).join('\n\n')}`,
    `# Chapter ${input.chapterNumber}: ${input.plan.title}\nPurpose: ${input.plan.purpose}\nTarget length: about ${input.targetWords} words.`,
    `# Characters in this chapter\n${input.cards.map(renderCard).join('\n') || '(none)'}`,
    `# Chronicle (every event, in order; write these and only these)\n${input.events
      .map((e, i) =>
        [
          `${i + 1}. ${e.summary}`,
          e.location ? `   Where: ${e.location}` : '',
          e.characters.length ? `   Who: ${e.characters.join(', ')}` : '',
          e.authorNote ? `   Author direction: ${e.authorNote}` : '',
          e.interiorityNote ? `   Interiority (the author's note): ${e.interiorityNote}` : '',
          e.dialogue.length
            ? `   Key dialogue:\n${e.dialogue.map((d) => `     "${d}"`).join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n')}`,
  ];
  if (input.previousProse)
    parts.push(`# Previous chapter (for voice continuity)\n${input.previousProse}`);
  if (input.notes) {
    parts.push(`# Current draft\n${input.currentDraft ?? '(none)'}`);
    parts.push(`# Author's notes for this revision\n${input.notes}`);
  }
  parts.push('# Your task\nWrite the chapter.');
  return parts.join('\n\n');
}

/**
 * Writes the chapter's prose. Forbidden dashes or banned phrases retry once with the problems
 * listed; anything left after that is returned for the cohesion report to flag.
 */
export async function runNovelizer(
  ctx: AgentContext,
  input: NovelizerInput,
): Promise<{ prose: string; problems: string[] }> {
  const prompt = withHouseStyle(loadPrompt('novelizer'));
  let messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: buildNovelizerPrompt(input) },
  ];
  let prose = '';
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await ctx.llm.complete({
      tier: 'strong',
      system: prompt.system,
      messages,
      maxTokens: 32000,
    });
    await ctx.onCall({
      agent: 'novelizer',
      promptVersion: prompt.version,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cachedTokens: response.usage.cacheReadTokens,
      costUsd: costUsd(response.model, response.usage),
    });
    prose = response.text.trim();
    if (response.stopReason === 'max_tokens')
      throw new Error('The chapter draft was cut off at the token limit');
    problems = proseProblems(prose, input.bible.styleGuide.bannedPhrases);
    if (problems.length === 0) break;
    messages = [
      ...messages,
      { role: 'assistant', content: prose },
      {
        role: 'user',
        content: `Revise the chapter to fix these, changing nothing else:\n- ${problems.join('\n- ')}\n\nReturn the complete chapter.`,
      },
    ];
  }
  return { prose, problems };
}
