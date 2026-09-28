// Shared setup for service and API tests, exported as @storyforge/services/testing.
import {
  FakeLlm,
  sampleBible,
  sampleOutline,
  samplePitch,
  sampleReplan,
  seedBible,
  seedChapters,
  seedOutline,
  seedTomasCard,
} from '@storyforge/core/testing';
import { createRepos } from '@storyforge/db';
import { createTestDb } from '@storyforge/db/testing';
import { exportBook, reviewBook } from './book.js';
import { approveCharacter, draftCard, editCharacter, ensureCast } from './characters.js';
import { type Enqueue, type ServiceContext, createServiceContext } from './context.js';
import { checkCohesion, getReview, lockChapter, novelizeChapter, waiveIssue } from './drafting.js';
import { type PlaySink, endChapter, startChapter } from './play.js';
import { replanOutline } from './replan.js';

export interface TestKit {
  ctx: ServiceContext;
  llm: FakeLlm;
  /** Jobs handed to the queue, in order. */
  queued: Parameters<Enqueue>[0][];
  close: () => Promise<void>;
}

export async function createTestKit(): Promise<TestKit> {
  const test = await createTestDb();
  const llm = new FakeLlm();
  const queued: Parameters<Enqueue>[0][] = [];
  const ctx = createServiceContext({
    db: test.db,
    llm,
    enqueue: async (job) => void queued.push(job),
  });
  return { ctx, llm, queued, close: test.close };
}

/** A project with an approved bible and outline, ready to play. */
export async function writingProject(ctx: ServiceContext) {
  const repos = createRepos(ctx.db);
  const user = await repos.users.findOrCreateByEmail('author@example.com');
  const project = await repos.projects.create(user.id, samplePitch, sampleBible.title);
  const bible = await repos.bibles.createVersion(project.id, {
    spine: sampleBible.spine,
    world: sampleBible.world,
    styleGuide: sampleBible.styleGuide,
  });
  await repos.bibles.markApproved(bible.id);
  const outline = await repos.outlines.createVersion(project.id, sampleOutline.chapters);
  await repos.outlines.markApproved(outline.outline.id);
  await repos.outlines.createChapters(project.id, outline);
  await repos.projects.transition(project.id, 'intake', 'bible_review');
  await repos.projects.transition(project.id, 'bible_review', 'outline_review');
  await repos.projects.transition(project.id, 'outline_review', 'writing');
  const chapters = await repos.chapters.listForProject(project.id);
  return { project, user, chapters, chapter1: chapters[0]!, chapter2: chapters[1]! };
}

/** A PlaySink that records what a turn streamed. */
export function recorder() {
  const events: { type: string; data: unknown }[] = [];
  let text = '';
  const npcs: string[] = [];
  const sink: PlaySink = {
    text: (d) => void (text += d),
    npc: (n) => void npcs.push(n),
    event: (type, data) => void events.push({ type, data }),
  };
  return { sink, events, npcs, text: () => text };
}

/** A project on the seeded test book, approved and ready to play, with Tomas's full card. */
export async function seededProject(ctx: ServiceContext) {
  const repos = createRepos(ctx.db);
  const user = await repos.users.findOrCreateByEmail('author@example.com');
  const project = await repos.projects.create(user.id, samplePitch, seedBible.title);
  const bible = await repos.bibles.createVersion(project.id, {
    spine: seedBible.spine,
    world: seedBible.world,
    styleGuide: seedBible.styleGuide,
  });
  await repos.bibles.markApproved(bible.id);
  const outline = await repos.outlines.createVersion(project.id, seedOutline.chapters);
  await repos.outlines.markApproved(outline.outline.id);
  await repos.outlines.createChapters(project.id, outline);
  await repos.projects.transition(project.id, 'intake', 'bible_review');
  await repos.projects.transition(project.id, 'bible_review', 'outline_review');
  await repos.projects.transition(project.id, 'outline_review', 'writing');
  const characters = await ensureCast(ctx, project.id, seedBible);
  const tomas = characters.find((c) => c.name === 'Tomas Reyne')!;
  await editCharacter(ctx, tomas, { card: seedTomasCard });
  const chapters = await repos.chapters.listForProject(project.id);
  return { project, user, chapters, tomas };
}

type JobRunner = (ctx: ServiceContext, jobId: string, data: never) => Promise<string>;
const RUNNERS: Partial<Record<string, JobRunner>> = {
  'character.draftCard': draftCard,
  'chapter.novelize': novelizeChapter,
  'chapter.cohesion': checkCohesion,
  'outline.replan': replanOutline,
  'book.review': reviewBook,
  'book.export': exportBook,
};

/** Runs the oldest queued job of a type (as the worker would), with scripted model responses. */
export async function runQueued(kit: TestKit, type: string, ...responses: unknown[]) {
  const index = kit.queued.findIndex((j) => j.type === type);
  if (index === -1) throw new Error(`No queued ${type} job`);
  const [job] = kit.queued.splice(index, 1);
  kit.llm.push(...responses);
  await kit.ctx.repos.jobs.markRunning(job!.id, 1);
  const result = await RUNNERS[type]!(kit.ctx, job!.id, job!.data as never);
  await kit.ctx.repos.jobs.markSucceeded(job!.id, result);
  return result;
}

/** Plays a seeded chapter to its end, then runs the novelize and cohesion jobs. */
export async function draftSeedChapter(kit: TestKit, chapterId: string, n: 1 | 2 | 3) {
  const seed = seedChapters[n];
  kit.llm.push(seed.opening, seed.extraction);
  await startChapter(kit.ctx, chapterId, recorder().sink);
  await endChapter(kit.ctx, chapterId);
  await runQueued(kit, 'chapter.novelize', seed.prose);
  await runQueued(kit, 'chapter.cohesion', seed.critic);
  return getReview(kit.ctx, chapterId);
}

/** Waives every open blocker on the chapter's report, approves any pending cards, and locks it. */
export async function waiveAndLock(kit: TestKit, chapterId: string) {
  const review = await getReview(kit.ctx, chapterId);
  for (const issue of review.report?.issues ?? []) {
    if (issue.severity === 'blocker') {
      await waiveIssue(kit.ctx, chapterId, issue.id, 'Accepted for the test book');
    }
  }
  for (const c of review.gates.pendingCards) {
    await approveCharacter(kit.ctx, (await kit.ctx.repos.characters.get(c.id))!);
  }
  await lockChapter(kit.ctx, chapterId);
  if (kit.queued.some((j) => j.type === 'outline.replan')) {
    await runQueued(kit, 'outline.replan', sampleReplan);
  }
}
