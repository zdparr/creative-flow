import type { BuiltContext } from '../context/buildContext.js';
import type { BeatStatus } from '../domain/beats.js';
import type { LlmTool } from '../llm/client.js';
import { costUsd } from '../llm/pricing.js';
import { type AgentContext, runStructuredAgent } from '../llm/runAgent.js';
import { loadPrompt } from '../prompts/loader.js';
import {
  type ExtractorOutput,
  type NpcVoiceOutput,
  extractorOutputSchema,
  npcVoiceOutputSchema,
  voiceCharacterInputSchema,
} from '../schemas/play.js';

/**
 * What the protagonist does this turn. The source is the author today; the play loop takes
 * this shape from anywhere so an autonomous protagonist agent can supply it later.
 */
export interface ProtagonistInput {
  kind: 'in_character' | 'author_note';
  text: string;
}

export interface DirectorTurnInput {
  context: BuiltContext;
  /** Null when opening the chapter. */
  input: ProtagonistInput | null;
  onText: (delta: string) => void;
  /** Voices a major character; returns the tool result for the director. */
  voiceCharacter: (character: string, situation: string) => Promise<string>;
}

/** Streams the director's narration for one turn. Returns the full narration. */
export async function runDirectorTurn(ctx: AgentContext, turn: DirectorTurnInput): Promise<string> {
  const prompt = loadPrompt('director');
  const task = !turn.input
    ? 'Open the chapter: set the scene and bring the protagonist to the first moment of choice.'
    : turn.input.kind === 'author_note'
      ? `The author gives an out-of-character direction. Follow it for this scene, then continue the story:\n[author: ${turn.input.text}]`
      : `The protagonist (played by the author) does this:\n${turn.input.text}`;

  const voice: LlmTool<{ character: string; situation: string }> = {
    name: 'voice_character',
    description:
      'Get what a major character does and says right now, played by an agent that knows only that character. Weave the returned action and dialogue into your narration, keeping the dialogue word for word.',
    inputSchema: voiceCharacterInputSchema,
    run: ({ character, situation }) => turn.voiceCharacter(character, situation),
  };

  const response = await ctx.llm.stream({
    tier: 'fast',
    system: `${prompt.system}\n\n# The book\n\n${turn.context.stable}`,
    messages: [{ role: 'user', content: `${turn.context.volatile}\n\n# This turn\n${task}` }],
    maxTokens: 16000,
    tools: [voice as LlmTool],
    onText: turn.onText,
  });
  await ctx.onCall({
    agent: 'director',
    promptVersion: prompt.version,
    model: response.model,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    cachedTokens: response.usage.cacheReadTokens,
    costUsd: costUsd(response.model, response.usage),
  });
  return response.text.trim();
}

/** Plays one major character under their card's constraints. */
export async function runNpcVoice(ctx: AgentContext, npcContext: string): Promise<NpcVoiceOutput> {
  return runStructuredAgent(ctx, {
    agent: 'npc_voice',
    prompt: loadPrompt('npc'),
    tier: 'fast',
    messages: [{ role: 'user', content: npcContext }],
    schema: npcVoiceOutputSchema,
    maxTokens: 8000,
  });
}

export interface ExtractorInput {
  beats: BeatStatus[];
  knownCharacters: string[];
  knownLocations: string[];
  previousSummary: string | null;
  input: ProtagonistInput | null;
  narration: string;
}

/** Turns one exchange into a chronicle event plus candidate continuity facts. */
export async function runExtractor(
  ctx: AgentContext,
  input: ExtractorInput,
): Promise<ExtractorOutput> {
  const beatIds = new Set(input.beats.map((b) => b.id));
  const content = [
    `# Required beats this chapter\n${input.beats.map((b) => `- ${b.id}${b.hit ? ' (already hit)' : ''}: ${b.description}`).join('\n')}`,
    `# Known characters\n${input.knownCharacters.join(', ') || '(none)'}`,
    `# Known locations\n${input.knownLocations.join(', ') || '(none)'}`,
    `# Previous event\n${input.previousSummary ?? '(This is the opening of the chapter.)'}`,
    `# This exchange`,
    input.input
      ? input.input.kind === 'author_note'
        ? `Author direction (out of character): ${input.input.text}`
        : `Protagonist: ${input.input.text}`
      : '(Chapter opening, no protagonist input.)',
    `Narration:\n${input.narration}`,
  ].join('\n\n');

  return runStructuredAgent(ctx, {
    agent: 'extractor',
    prompt: loadPrompt('extractor'),
    tier: 'fast',
    messages: [{ role: 'user', content }],
    schema: extractorOutputSchema,
    maxTokens: 8000,
    check: (out) =>
      out.beatsHit
        .filter((id) => !beatIds.has(id))
        .map((id) => `beatsHit: "${id}" is not a required beat id`),
  });
}
