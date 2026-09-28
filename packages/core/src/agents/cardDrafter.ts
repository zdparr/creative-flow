import { type AgentContext, runStructuredAgent } from '../llm/runAgent.js';
import { dashProblems, withHouseStyle } from '../prose/houseStyle.js';
import { loadPrompt } from '../prompts/loader.js';
import type { BibleContent } from '../schemas/bible.js';
import {
  type CardContent,
  type CharacterTier,
  cardSchemas,
  missingCardFields,
  normalizeCard,
} from '../schemas/character.js';

export interface CardDrafterInput {
  bible: BibleContent;
  name: string;
  tier: CharacterTier;
  firstChapter: number;
  /** Chronicle summaries of scenes the character appeared in, oldest first. */
  moments: string[];
  /** The card so far; when given, only its empty fields are filled (unless notes say otherwise). */
  existing?: CardContent;
  notes?: string;
}

/** Drafts a card at the given tier. Returns the full stored card shape. */
export async function runCardDrafter(
  ctx: AgentContext,
  input: CardDrafterInput,
): Promise<CardContent> {
  const schema = cardSchemas[input.tier];
  const { title, spine, world, styleGuide } = input.bible;
  const parts = [
    `# The book\n${JSON.stringify({ title, spine, world, styleGuide: { pov: styleGuide.pov, register: styleGuide.register } }, null, 2)}`,
    `# Character\nName: ${input.name}\nTier: ${input.tier}\nFirst appears in chapter ${input.firstChapter}`,
    `# Moments so far\n${input.moments.map((m) => `- ${m}`).join('\n') || '(none recorded yet)'}`,
  ];
  if (input.existing) {
    parts.push(
      `# Existing card (keep filled fields; fill the empty ones)\n${JSON.stringify(input.existing, null, 2)}`,
    );
  }
  if (input.notes) parts.push(`# Author's notes\n${input.notes}`);

  const out = await runStructuredAgent(ctx, {
    agent: 'card_drafter',
    prompt: withHouseStyle(loadPrompt('card-drafter')),
    tier: 'fast',
    messages: [{ role: 'user', content: parts.join('\n\n') }],
    schema,
    maxTokens: 8000,
    check: (card) => {
      const full = normalizeCard(card, input.firstChapter);
      return [
        ...missingCardFields(input.tier, full).map(
          (f) => `${f}: required for a ${input.tier} card`,
        ),
        ...full.voiceSamples.flatMap((s, i) => dashProblems(`voiceSamples.${i}`, s)),
      ];
    },
  });

  const drafted = normalizeCard(out, input.firstChapter);
  if (!input.existing || input.notes) return drafted;
  // Promotion fills only what is missing: filled fields stay exactly as the author approved them.
  const kept = { ...input.existing };
  for (const field of missingCardFields(input.tier, input.existing)) {
    (kept as Record<string, unknown>)[field] = drafted[field];
  }
  if (input.tier === 'major') {
    if (!kept.secret) kept.secret = drafted.secret;
    if (kept.checkpoints.length === 0) kept.checkpoints = drafted.checkpoints;
    if (kept.keyRelationships.length === 0) kept.keyRelationships = drafted.keyRelationships;
  }
  return kept;
}
