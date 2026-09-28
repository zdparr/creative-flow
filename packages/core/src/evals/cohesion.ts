// Live evaluation of the cohesion critic on the seeded test book. Unlike the unit tests, this
// calls the real model, so it checks that the critic itself catches the planted violations.
//
//   ANTHROPIC_API_KEY=... pnpm eval:cohesion
//
// It costs a few strong-tier calls (well under a dollar).
import { runCohesionCritic } from '../agents/critic.js';
import { loadWorkerEnv } from '../config.js';
import { AnthropicLlmClient } from '../llm/client.js';
import { draftParagraphs, ruleIssues } from '../prose/rules.js';
import { cardFromCast } from '../schemas/character.js';
import { seedBible, seedChapters, seedOutline, seedTomasCard } from '../testing/seedBook.js';

const env = loadWorkerEnv({ DATABASE_URL: 'unused', REDIS_URL: 'unused', ...process.env });
const llm = new AnthropicLlmClient({
  apiKey: env.ANTHROPIC_API_KEY,
  models: { fast: env.MODEL_FAST, strong: env.MODEL_STRONG },
  structuredOutputs: env.STRUCTURED_OUTPUTS,
});
let cost = 0;
const ctx = { llm, onCall: (log: { costUsd: number }) => void (cost += log.costUsd) };

const maren = {
  id: 'maren',
  name: 'Maren Tull',
  tier: 'major' as const,
  card: cardFromCast(seedBible.world.cast[0]!),
};
const tomas = { id: 'tomas', name: 'Tomas Reyne', tier: 'major' as const, card: seedTomasCard };
const letterFact = 'Maren has a letter addressed to Isla, dated next spring.';

async function check(chapter: 2 | 3, expected: string[]) {
  const paragraphs = draftParagraphs(seedChapters[chapter].prose);
  const openPromises =
    chapter === 2
      ? [{ id: 'p-letters', description: 'Who is writing the letters?', from: 2, to: 2 }]
      : [];
  const out = await runCohesionCritic(ctx, {
    bible: seedBible,
    chapterNumber: chapter,
    plan: seedOutline.chapters[chapter - 1]!,
    paragraphs,
    cards: [maren, tomas],
    knowledge: [
      {
        character: 'Maren Tull',
        statement: letterFact,
        learnedChapter: 1,
        howLearned: 'witnessed in chapter 1',
      },
      ...(chapter === 3
        ? [
            {
              character: 'Tomas Reyne',
              statement: 'Tomas has delivered the order to close Skerry Light.',
              learnedChapter: 2,
              howLearned: 'involved in chapter 2',
            },
          ]
        : []),
    ],
    openPromises,
    ledger: [
      { chapter: 1, kind: 'object', statement: letterFact },
      ...(chapter === 3
        ? [
            {
              chapter: 2,
              kind: 'event',
              statement: 'Tomas has delivered the order to close Skerry Light.',
            },
          ]
        : []),
    ],
    checkpointsDue: [],
    candidatePromises: [],
  });
  const paid = new Set(out.paidPromiseIds);
  const rules = ruleIssues({
    paragraphs,
    bannedPhrases: seedBible.styleGuide.bannedPhrases,
    overdue: openPromises.filter((p) => !paid.has(p.id)),
  });
  const blockers = [...rules, ...out.issues].filter((i) => i.severity === 'blocker');
  console.log(`\nChapter ${chapter}:`);
  for (const i of out.issues) console.log(`  [${i.severity} ${i.category}] ${i.description}`);
  return expected.map((category) => {
    const hit = blockers.some((b) => b.category === category);
    console.log(`  ${hit ? 'PASS' : 'FAIL'}: ${category} violation caught`);
    return hit;
  });
}

const results = [...(await check(2, ['promise', 'knowledge'])), ...(await check(3, ['principle']))];
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} planted violations caught (cost $${cost.toFixed(4)})`);
process.exit(passed === results.length ? 0 : 1);
