import { z } from 'zod';

// The story bible. These schemas are the contract for the bibles table's JSONB columns
// and for every agent that reads or writes a bible.

export const ANCHOR_TYPES = [
  'inciting_incident',
  'midpoint_reversal',
  'dark_moment',
  'climax',
  'other',
] as const;
export type AnchorType = (typeof ANCHOR_TYPES)[number];

export const anchorBeatSchema = z.object({
  type: z.enum(ANCHOR_TYPES),
  label: z.string().describe('Short name, e.g. "The letter arrives"'),
  description: z.string(),
  targetChapter: z.number().int().describe('1-based chapter this beat must land in'),
});
export type AnchorBeat = z.infer<typeof anchorBeatSchema>;

export const spineSchema = z.object({
  centralQuestion: z.string().describe('The central dramatic question the book answers'),
  theme: z.string().describe('One-sentence theme statement'),
  ending: z.object({
    resolution: z.string().describe('How the story resolves'),
    cost: z.string().describe('What the resolution costs the protagonist'),
  }),
  anchorBeats: z.array(anchorBeatSchema),
  chapterCount: z.number().int(),
  targetWordCount: z.number().int(),
});
export type Spine = z.infer<typeof spineSchema>;

export const CAST_ROLES = ['protagonist', 'antagonist', 'supporting'] as const;

export const castMemberSchema = z.object({
  name: z.string(),
  role: z.enum(CAST_ROLES),
  tier: z.enum(['major', 'minor']),
  summary: z.string(),
  want: z.string(),
  flaw: z.string().describe('Fear or flaw; empty string for minor characters if unknown'),
  arcStart: z.string().describe('Who they are at the start; empty for minor characters'),
  arcEnd: z.string().describe('Who they are at the end; empty for minor characters'),
});
export type CastMember = z.infer<typeof castMemberSchema>;

export const worldSchema = z.object({
  logline: z.string(),
  genre: z.string(),
  tone: z.string(),
  setting: z.string().describe('Time, place, and texture of the world'),
  locations: z.array(z.object({ name: z.string(), description: z.string() })),
  rules: z.array(z.string()).describe('How this world works: magic, technology, society'),
  cast: z.array(castMemberSchema),
});
export type World = z.infer<typeof worldSchema>;

export const POVS = ['first', 'second', 'third_limited', 'third_omniscient'] as const;
export const TENSES = ['past', 'present'] as const;

export const styleGuideSchema = z.object({
  pov: z.enum(POVS),
  povCharacter: z.string().describe('Whose eyes we see through; empty for omniscient'),
  tense: z.enum(TENSES),
  register: z.string().describe('Prose register, e.g. "lyrical, restrained, dry humor"'),
  bannedPhrases: z.array(z.string()),
  samples: z.array(z.string()).describe('2-3 sample paragraphs in the book voice'),
});
export type StyleGuide = z.infer<typeof styleGuideSchema>;

export const bibleContentSchema = z.object({
  title: z.string(),
  spine: spineSchema,
  world: worldSchema,
  styleGuide: styleGuideSchema,
});
export type BibleContent = z.infer<typeof bibleContentSchema>;

export const BIBLE_SECTIONS = ['spine', 'world', 'styleGuide'] as const;
export type BibleSection = (typeof BIBLE_SECTIONS)[number];

export const bibleSectionSchemas = {
  spine: spineSchema,
  world: worldSchema,
  styleGuide: styleGuideSchema,
} as const;
