import { z } from 'zod';
import { CHARACTER_TIERS, PROMISE_TYPES } from '../domain/status.js';

export const LEDGER_FACT_KINDS = [
  'event',
  'injury',
  'relationship',
  'object',
  'location',
  'timeline',
] as const;
export type LedgerFactKind = (typeof LEDGER_FACT_KINDS)[number];

export const extractorOutputSchema = z.object({
  summary: z.string().describe('One or two sentences: what happened in this exchange'),
  characters: z.array(z.string()).describe('Names of characters present or acting'),
  location: z.string().nullable().describe('Where it happened, or null if unchanged/unknown'),
  beatsHit: z.array(z.string()).describe('Ids of required beats that happened in this exchange'),
  newCharacters: z
    .array(
      z.object({
        name: z.string(),
        proposedTier: z.enum(CHARACTER_TIERS),
        role: z.string().describe('Their role in the story, e.g. "harbor clerk"'),
        trait: z.string().describe('One defining trait'),
      }),
    )
    .describe('Named characters not in the known list'),
  facts: z
    .array(
      z.object({
        kind: z.enum(LEDGER_FACT_KINDS),
        statement: z.string().describe('A concrete, checkable fact established here'),
        entities: z.array(z.string()).describe('Names of characters and places involved'),
      }),
    )
    .describe('Continuity facts later chapters must respect'),
  promises: z
    .array(
      z.object({
        type: z.enum(PROMISE_TYPES),
        description: z.string(),
        entities: z.array(z.string()),
      }),
    )
    .describe('New setups the reader will expect to pay off'),
});
export type ExtractorOutput = z.infer<typeof extractorOutputSchema>;

/**
 * What the extractor found in one exchange, stored on the chronicle event. Facts and promises
 * stay pending until the chapter lock commits them.
 */
export interface ChronicleExtraction {
  authorNote?: string;
  facts: ExtractorOutput['facts'];
  promises: ExtractorOutput['promises'];
  newCharacters: ExtractorOutput['newCharacters'];
}

export const npcVoiceOutputSchema = z.object({
  action: z.string().describe('What the character physically does, in a sentence or two'),
  dialogue: z.string().describe('What they say, in their own voice; empty if they stay silent'),
});
export type NpcVoiceOutput = z.infer<typeof npcVoiceOutputSchema>;

export const voiceCharacterInputSchema = z.object({
  character: z.string().describe('Exact name of the major character to voice'),
  situation: z
    .string()
    .describe('What just happened and what the character is responding to, in 1-3 sentences'),
});
