import type { BeatStatus } from '../domain/beats.js';
import type { BibleContent } from '../schemas/bible.js';
import type { CardContent } from '../schemas/character.js';
import type { OutlineChapter } from '../schemas/outline.js';

// Selective context: each call gets only what it needs, within a token budget. Services load
// the data; these pure functions choose and trim it, so the rules are unit-testable.

/** Rough token estimate (about 4 characters per token), good enough for budgeting. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export interface CharacterCard {
  id: string;
  name: string;
  tier: 'walk_on' | 'minor' | 'major';
  card: Partial<CardContent>;
}

export interface ContextTurn {
  role: 'author' | 'director' | 'npc';
  inputKind: 'in_character' | 'author_note' | null;
  content: string;
}

export interface ContextFact {
  kind: string;
  statement: string;
  entities: string[];
  /** Older facts drop first within the same severity. */
  chapter: number;
}

export interface ContextPromise {
  description: string;
  plantedChapter: number;
  payoffChapter: number;
  /** Empty means the promise is not tied to particular characters or places. */
  entities: string[];
}

/** A secret, instruction, promise, or warning in force between characters. */
export interface ContextCommitment {
  kind: string;
  from: string;
  to: string[];
  content: string;
  scope: string;
  /** The line as spoken; empty if it was not said aloud. */
  words: string;
  /** Chapter it was given in. */
  chapter: number;
  /** Chapters that have put it under pressure. */
  tested: number[];
  /** Ids of the giver and recipients, for scoping. */
  entities: string[];
}

export function renderCommitment(c: ContextCommitment): string {
  return [
    `${c.from} to ${c.to.join(', ') || '(unknown)'} (${c.kind}, chapter ${c.chapter}): ${c.content}`,
    c.scope ? ` Scope: ${c.scope}.` : '',
    c.words ? ` As said: "${c.words}"` : '',
    c.tested.length ? ` Tested in chapter ${c.tested.join(', ')}.` : ' Not yet tested.',
  ].join('');
}

export interface KnowledgeItem {
  characterId: string;
  statement: string;
  learnedChapter: number;
  howLearned: string;
}

// Continuity-critical kinds survive trimming longest.
const SEVERITY: Record<string, number> = {
  injury: 3,
  relationship: 3,
  event: 2,
  object: 2,
  location: 1,
  timeline: 1,
};

export const DIRECTOR_TURN_WINDOW = 20;
export const MIN_TURNS_KEPT = 4;
export const LOCKED_SUMMARY_WINDOW = 3;

export interface DirectorContextInput {
  bible: BibleContent;
  chapterNumber: number;
  plan: OutlineChapter;
  beats: BeatStatus[];
  /** Every known character; only those in scene (and not walk-ons out of scene) are included. */
  characters: CharacterCard[];
  sceneCharacterIds: string[];
  sceneLocationId: string | null;
  turns: ContextTurn[];
  lockedSummaries: { number: number; summary: string }[];
  facts: ContextFact[];
  promises: ContextPromise[];
  /** Commitments in force; only those involving someone in the scene are included. */
  commitments?: ContextCommitment[];
  /** Drift the author chose to steer back from; the director works the plan back in. */
  steer?: string[];
}

export interface BuiltContext {
  /** Stable across the book: goes in the cached system prompt. */
  stable: string;
  /** Changes every turn: goes in the user message. */
  volatile: string;
  tokens: number;
  overBudget: boolean;
  /** What trimming removed, for logging and tests. */
  dropped: { turns: number; summaries: number; facts: number };
}

function renderTurn(t: ContextTurn): string {
  if (t.role === 'author') {
    return t.inputKind === 'author_note'
      ? `[author: ${t.content}]`
      : `AUTHOR (protagonist): ${t.content}`;
  }
  return t.role === 'npc' ? `NPC: ${t.content}` : `DIRECTOR: ${t.content}`;
}

export function renderCard(c: CharacterCard): string {
  const lines = Object.entries(c.card)
    .filter(
      ([k, v]) =>
        k !== 'firstAppearance' &&
        v !== '' &&
        v !== undefined &&
        v !== null &&
        !(Array.isArray(v) && v.length === 0),
    )
    .map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return `- ${c.name} (${c.tier})\n${lines.join('\n')}`;
}

/** Keeps facts and promises tied to anyone or anything in the scene (untagged promises always pass). */
export function filterByEntities<T extends { entities: string[] }>(
  items: T[],
  sceneEntities: ReadonlySet<string>,
  keepUntagged: boolean,
): T[] {
  return items.filter((i) =>
    i.entities.length === 0 ? keepUntagged : i.entities.some((e) => sceneEntities.has(e)),
  );
}

export function buildDirectorContext(
  input: DirectorContextInput,
  budgetTokens: number,
): BuiltContext {
  const { bible } = input;
  const stable = [
    `# ${bible.title}`,
    `## Spine\n${JSON.stringify(bible.spine, null, 2)}`,
    `## World\nLogline: ${bible.world.logline}\nGenre: ${bible.world.genre}\nTone: ${bible.world.tone}\nSetting: ${bible.world.setting}\nRules:\n${bible.world.rules.map((r) => `- ${r}`).join('\n')}`,
    `## Style\nPOV: ${bible.styleGuide.pov} (${bible.styleGuide.povCharacter || 'omniscient'}), tense: ${bible.styleGuide.tense}. Register: ${bible.styleGuide.register}. Never use: ${bible.styleGuide.bannedPhrases.join('; ') || '(none)'}`,
  ].join('\n\n');

  const scene = new Set(input.sceneCharacterIds);
  const sceneEntities = new Set([
    ...input.sceneCharacterIds,
    ...(input.sceneLocationId ? [input.sceneLocationId] : []),
  ]);
  const cards = input.characters.filter((c) => scene.has(c.id));

  // Required sections are never trimmed: the chapter plan, beat tracker, and in-scene cards.
  const required = [
    `## Chapter ${input.chapterNumber}: ${input.plan.title}\nPurpose: ${input.plan.purpose}`,
    `## Beat tracker\n${input.beats.map((b) => `- [${b.hit ? 'x' : ' '}] ${b.id}: ${b.description}`).join('\n')}`,
    `## Arcs this chapter must move\n${input.plan.arcsMoved.map((a) => `- ${a.character}: ${a.change}`).join('\n') || '(none)'}`,
    `## Characters in scene\n${cards.map(renderCard).join('\n') || '(none yet)'}`,
    ...(input.steer?.length
      ? [
          `## Steer back to the plan\nThe author chose to steer back from these divergences. Work the plan back in through events and other characters, without undoing what happened:\n${input.steer.map((d) => `- ${d}`).join('\n')}`,
        ]
      : []),
  ].join('\n\n');

  let turns = input.turns.slice(-DIRECTOR_TURN_WINDOW);
  let summaries = input.lockedSummaries.slice(-LOCKED_SUMMARY_WINDOW);
  const promises = input.promises.filter(
    (p) => p.plantedChapter <= input.chapterNumber && p.payoffChapter >= input.chapterNumber,
  );
  const relevantPromises = filterByEntities(promises, sceneEntities, true);
  const commitments = filterByEntities(input.commitments ?? [], sceneEntities, false);
  // Most important and newest last, so trimming drops from the front.
  let facts = filterByEntities(input.facts, sceneEntities, false).sort(
    (a, b) => (SEVERITY[a.kind] ?? 0) - (SEVERITY[b.kind] ?? 0) || a.chapter - b.chapter,
  );
  const initial = { turns: turns.length, summaries: summaries.length, facts: facts.length };

  const render = () =>
    [
      required,
      summaries.length
        ? `## Previous chapters\n${summaries.map((s) => `Chapter ${s.number}: ${s.summary}`).join('\n\n')}`
        : '',
      facts.length ? `## Continuity facts\n${facts.map((f) => `- ${f.statement}`).join('\n')}` : '',
      relevantPromises.length
        ? `## Open promises\n${relevantPromises.map((p) => `- ${p.description} (pay off by chapter ${p.payoffChapter})`).join('\n')}`
        : '',
      commitments.length
        ? `## Secrets and instructions in force (between characters in the scene)\n${commitments.map((c) => `- ${renderCommitment(c)}`).join('\n')}`
        : '',
      `## Story so far this chapter\n${turns.map(renderTurn).join('\n\n') || '(The chapter has not started.)'}`,
    ]
      .filter(Boolean)
      .join('\n\n');

  const fits = () => estimateTokens(stable) + estimateTokens(render()) <= budgetTokens;
  // Trim order from the spec: oldest turns, then oldest summaries, then lower-severity facts.
  while (!fits() && turns.length > MIN_TURNS_KEPT) turns = turns.slice(1);
  while (!fits() && summaries.length > 0) summaries = summaries.slice(1);
  while (!fits() && facts.length > 0) facts = facts.slice(1);

  const volatile = render();
  const tokens = estimateTokens(stable) + estimateTokens(volatile);
  return {
    stable,
    volatile,
    tokens,
    overBudget: tokens > budgetTokens,
    dropped: {
      turns: initial.turns - turns.length,
      summaries: initial.summaries - summaries.length,
      facts: initial.facts - facts.length,
    },
  };
}

export interface NpcContextInput {
  character: CharacterCard;
  /** The whole project's knowledge map; filtered here so no other character's knowledge leaks in. */
  knowledge: KnowledgeItem[];
  otherCharactersInScene: { name: string; relationship: string }[];
  recentTurns: ContextTurn[];
  situation: string;
  /** Every commitment in force; filtered here to the ones this character gave or received. */
  commitments?: ContextCommitment[];
}

export function buildNpcContext(input: NpcContextInput): string {
  const own = input.knowledge.filter((k) => k.characterId === input.character.id);
  const bound = (input.commitments ?? []).filter((c) => c.entities.includes(input.character.id));
  // Only turns that mention this character, so the NPC reacts to what it witnessed.
  const name = input.character.name.split(' ')[0]!.toLowerCase();
  const turns = input.recentTurns.filter((t) => t.content.toLowerCase().includes(name)).slice(-8);
  return [
    `# You are ${input.character.name}`,
    renderCard(input.character),
    `## What you know\n${own.map((k) => `- ${k.statement} (since chapter ${k.learnedChapter}, ${k.howLearned})`).join('\n') || '(Only what is on your card and what you have witnessed below.)'}`,
    ...(bound.length
      ? [
          `## Secrets and instructions you are party to\n${bound.map((c) => `- ${renderCommitment(c)}`).join('\n')}`,
        ]
      : []),
    `## Others here\n${input.otherCharactersInScene.map((o) => `- ${o.name}: ${o.relationship}`).join('\n') || '(no one else)'}`,
    `## Recent moments involving you\n${turns.map(renderTurn).join('\n\n') || '(none)'}`,
    `## Right now\n${input.situation}`,
  ].join('\n\n');
}
