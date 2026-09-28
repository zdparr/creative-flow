import { z } from 'zod';
import type { CastMember } from './bible.js';

// Character cards are tiered: each tier adds fields to the one below it. The stored card
// (character_versions.card) is the major shape with the fields a lower tier does not use left empty.

export type CharacterTier = 'walk_on' | 'minor' | 'major';

export const walkOnCardSchema = z.object({
  role: z.string().describe('What they are in the world, e.g. "harbor clerk"'),
  location: z.string().describe('Where they are usually found'),
  trait: z.string().describe('One defining trait'),
  firstAppearance: z.number().int().describe('Chapter of first appearance'),
});

export const minorCardSchema = walkOnCardSchema.extend({
  storyRole: z.string().describe('What they do for the story'),
  want: z.string(),
  relationshipToProtagonist: z.string(),
  voiceNote: z.string().describe('How they talk, in a sentence'),
});

export const arcCheckpointSchema = z.object({
  chapter: z.number().int(),
  description: z.string().describe('Where the arc should stand by this chapter'),
  met: z.boolean().describe('False when drafting; set when a locked chapter meets it'),
});

export const majorCardSchema = minorCardSchema.extend({
  principles: z.array(z.string()).describe('What they will never do'),
  goal: z.string(),
  fearOrFlaw: z.string(),
  secret: z.string(),
  arcStart: z.string(),
  arcEnd: z.string(),
  checkpoints: z.array(arcCheckpointSchema),
  keyRelationships: z.array(z.object({ name: z.string(), relationship: z.string() })),
  voiceSamples: z.array(z.string()).describe('Two or three lines they might say'),
});

export type CardContent = z.infer<typeof majorCardSchema>;
export type ArcCheckpoint = z.infer<typeof arcCheckpointSchema>;

export const cardSchemas = {
  walk_on: walkOnCardSchema,
  minor: minorCardSchema,
  major: majorCardSchema,
} as const;

/** A card with every field present, so lower tiers can be stored in the same shape. */
export function emptyCard(firstAppearance = 1): CardContent {
  return {
    role: '',
    location: '',
    trait: '',
    firstAppearance,
    storyRole: '',
    want: '',
    relationshipToProtagonist: '',
    voiceNote: '',
    principles: [],
    goal: '',
    fearOrFlaw: '',
    secret: '',
    arcStart: '',
    arcEnd: '',
    checkpoints: [],
    keyRelationships: [],
    voiceSamples: [],
  };
}

/** Fills missing fields so a stored card from any tier (or an older shape) reads as a full card. */
export function normalizeCard(card: unknown, firstAppearance = 1): CardContent {
  const base = emptyCard(firstAppearance);
  if (!card || typeof card !== 'object') return base;
  const merged = { ...base, ...(card as Partial<CardContent>) };
  const parsed = majorCardSchema.safeParse(merged);
  return parsed.success ? parsed.data : base;
}

/** A bible cast member as a card; the author approved these fields with the bible. */
export function cardFromCast(member: CastMember): CardContent {
  return {
    ...emptyCard(1),
    role: member.role,
    trait: member.summary,
    storyRole: member.summary,
    want: member.want,
    goal: member.tier === 'major' ? member.want : '',
    fearOrFlaw: member.flaw,
    arcStart: member.arcStart,
    arcEnd: member.arcEnd,
  };
}

const REQUIRED: Record<CharacterTier, (keyof CardContent)[]> = {
  walk_on: ['role', 'trait'],
  minor: ['role', 'trait', 'storyRole', 'want', 'relationshipToProtagonist', 'voiceNote'],
  major: [
    'role',
    'trait',
    'storyRole',
    'want',
    'relationshipToProtagonist',
    'voiceNote',
    'principles',
    'goal',
    'fearOrFlaw',
    'arcStart',
    'arcEnd',
    'voiceSamples',
  ],
};

const filled = (v: unknown) =>
  Array.isArray(v)
    ? v.some((x) => (typeof x === 'string' ? x.trim() : x))
    : String(v).trim() !== '';

/** Required fields for the tier that are still empty. */
export function missingCardFields(tier: CharacterTier, card: CardContent): (keyof CardContent)[] {
  return REQUIRED[tier].filter((field) => !filled(card[field]));
}

export const TIER_RANK: Record<CharacterTier, number> = { walk_on: 0, minor: 1, major: 2 };
