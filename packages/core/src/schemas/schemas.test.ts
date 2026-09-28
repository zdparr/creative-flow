import { describe, expect, it } from 'vitest';
import {
  sampleBible,
  sampleInterviewBible,
  sampleInterviewRound,
  sampleOutline,
} from '../testing/fixtures.js';
import { bibleContentSchema } from './bible.js';
import { interviewerOutputSchema } from './interview.js';
import { outlinerOutputSchema } from './outline.js';

// Every recorded agent output must validate against its schema.
describe('agent output fixtures', () => {
  it('bible', () => expect(bibleContentSchema.safeParse(sampleBible).success).toBe(true));
  it('interviewer questions', () =>
    expect(interviewerOutputSchema.safeParse(sampleInterviewRound(1)).success).toBe(true));
  it('interviewer bible', () =>
    expect(interviewerOutputSchema.safeParse(sampleInterviewBible).success).toBe(true));
  it('outliner', () => expect(outlinerOutputSchema.safeParse(sampleOutline).success).toBe(true));
});
