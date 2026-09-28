import {
  FakeLlm,
  sampleBible,
  sampleBookReview,
  sampleReplan,
  seedTomasCard,
  sampleInterviewBible,
  sampleInterviewRound,
  sampleOpening,
  sampleOpeningExtraction,
  sampleOutline,
  samplePitch,
  sampleTurnExtraction,
  sampleTurnNarration,
} from '@storyforge/core/testing';
import { schema } from '@storyforge/db';
import { createTestDb } from '@storyforge/db/testing';
import {
  type Enqueue,
  type ServiceContext,
  createServiceContext,
  generateOutline,
} from '@storyforge/services';
import { eq } from 'drizzle-orm';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  draftSeedChapter,
  runQueued,
  seededProject,
  waiveAndLock,
} from '@storyforge/services/testing';
import { type AppDeps, buildApp } from './app.js';

const credentials = { email: 'author@example.com', password: 'correct horse battery' };

let close: () => Promise<void>;
let services: ServiceContext;
let llm: FakeLlm;
let queued: Parameters<Enqueue>[0][];

beforeEach(async () => {
  const test = await createTestDb();
  close = test.close;
  llm = new FakeLlm();
  queued = [];
  services = createServiceContext({
    db: test.db,
    llm,
    enqueue: async (job) => void queued.push(job),
  });
});
afterEach(() => close());

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    env: {
      AUTH_SECRET: 's'.repeat(32),
      AUTH_ALLOWED_EMAIL: credentials.email,
      AUTH_PASSWORD: credentials.password,
      NODE_ENV: 'test',
    },
    pingDb: async () => {},
    services,
    ...overrides,
  };
}

async function signedIn() {
  const app = await buildApp(deps());
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: credentials });
  const cookies = { sf_session: login.cookies.find((c) => c.name === 'sf_session')!.value };
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api${url}`,
      cookies,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return { app, call };
}

describe('health', () => {
  it('returns ok when the database answers', async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 when the database is down', async () => {
    const app = await buildApp(
      deps({
        pingDb: async () => {
          throw new Error('down');
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
  });
});

describe('password login', () => {
  it('signs in with the configured credentials and serves /me', async () => {
    const { call } = await signedIn();
    const me = await call('GET', '/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: credentials.email });
  });

  it('rejects a wrong password without setting a session', async () => {
    const app = await buildApp(deps());
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { ...credentials, password: 'nope' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toHaveLength(0);
  });

  it('locks login after five failures, even for the right password', async () => {
    const app = await buildApp(deps());
    const attempt = (password: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: { ...credentials, password } });
    for (let i = 0; i < 5; i++) expect((await attempt('nope')).statusCode).toBe(401);
    expect((await attempt(credentials.password)).statusCode).toBe(429);
  });

  it('rejects project routes without a session', async () => {
    const app = await buildApp(deps());
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401);
  });
});

describe('project API', () => {
  it('runs pitch to approved outline over HTTP', async () => {
    const { call } = await signedIn();

    const created = await call('POST', '/projects', { pitch: samplePitch });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    llm.push(
      sampleInterviewRound(1),
      sampleInterviewRound(2),
      sampleInterviewRound(3),
      sampleInterviewBible,
    );
    let step = (await call('POST', `/projects/${id}/interview/next`)).json();
    for (let i = 0; i < 3; i++) {
      const answers = step.round.questions.map((q: { id: string }) => ({
        questionId: q.id,
        kind: 'you_decide',
      }));
      step = (
        await call('POST', `/projects/${id}/interview/answers`, { roundId: step.round.id, answers })
      ).json();
    }
    expect(step.kind).toBe('bible');

    const bible = (await call('GET', `/projects/${id}/bible`)).json();
    expect(bible.content.title).toBe('The Tide Letters');
    expect(bible.spineProblems).toEqual([]);

    const approved = await call('POST', `/projects/${id}/bible/approve`);
    expect(approved.statusCode).toBe(200);
    expect(queued).toHaveLength(1);

    // Run the queued job the way the worker would.
    llm.push(sampleOutline);
    await generateOutline(services, queued[0]!.id, { projectId: id });

    const outline = (await call('GET', `/projects/${id}/outline`)).json();
    expect(outline.outline.chapters).toHaveLength(4);

    const done = await call('POST', `/projects/${id}/outline/approve`);
    expect(done.json().status).toBe('writing');
  });

  it('maps a failed gate to 422 with the problems listed', async () => {
    const { call } = await signedIn();
    const id = (await call('POST', '/projects', { pitch: samplePitch })).json().id as string;
    llm.push(
      sampleInterviewRound(1),
      sampleInterviewRound(2),
      sampleInterviewRound(3),
      sampleInterviewBible,
    );
    let step = (await call('POST', `/projects/${id}/interview/next`)).json();
    while (step.kind === 'questions') {
      step = (
        await call('POST', `/projects/${id}/interview/answers`, {
          roundId: step.round.id,
          answers: [],
        })
      ).json();
    }
    await call('PATCH', `/projects/${id}/bible`, {
      ...sampleBible,
      spine: { ...sampleBible.spine, centralQuestion: '' },
    });
    const res = await call('POST', `/projects/${id}/bible/approve`);
    expect(res.statusCode).toBe(422);
    expect(res.json().problems).toContain('Central dramatic question is empty');
  });

  it("hides other users' projects", async () => {
    const other = await services.repos.users.findOrCreateByEmail('someone@else.com');
    const theirs = await services.repos.projects.create(other.id, samplePitch, 'Theirs');
    const { call } = await signedIn();
    expect((await call('GET', `/projects/${theirs.id}`)).statusCode).toBe(404);
    expect((await call('GET', '/projects')).json()).toEqual([]);
  });

  it('reports invalid model output as a 502 the UI can show', async () => {
    const { call } = await signedIn();
    const id = (await call('POST', '/projects', { pitch: samplePitch })).json().id as string;
    llm.push('garbage', 'more garbage');
    const res = await call('POST', `/projects/${id}/interview/next`);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('unusable answer');
  });
});

/** Seeds a project in the writing stage owned by the signed-in author. */
async function writingProject(ownerEmail = credentials.email) {
  const repos = services.repos;
  const user = await repos.users.findOrCreateByEmail(ownerEmail);
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
  return { project, chapters: await repos.chapters.listForProject(project.id) };
}

/** Parses an SSE body into [event, data] pairs. */
function sseEvents(body: string) {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      return [event, data ? JSON.parse(data) : null] as const;
    });
}

describe('play API', () => {
  it('streams a chapter opening and a turn as server-sent events', async () => {
    const { call } = await signedIn();
    const { project, chapters } = await writingProject();
    const listed = (await call('GET', `/projects/${project.id}/chapters`)).json();
    expect(listed.map((c: { title: string }) => c.title)[0]).toBe('New Moon');

    llm.push(sampleOpening, sampleOpeningExtraction);
    const opening = await call('POST', `/chapters/${chapters[0]!.id}/start`);
    expect(opening.headers['content-type']).toContain('text/event-stream');
    const events = sseEvents(opening.body);
    expect(events.map(([e]) => e)).toEqual(['delta', 'delta', 'turn', 'chronicle', 'done']);
    expect(events[0]![1]).toEqual({ text: sampleOpening.stream[0] });

    llm.push(sampleTurnNarration, sampleTurnExtraction);
    const turn = await call('POST', `/chapters/${chapters[0]!.id}/turns`, {
      kind: 'in_character',
      text: 'I go down to the water.',
    });
    expect(sseEvents(turn.body).at(-1)![0]).toBe('done');

    const state = (await call('GET', `/chapters/${chapters[0]!.id}`)).json();
    expect(state.canEnd).toBe(true);
    const ended = await call('POST', `/chapters/${chapters[0]!.id}/end`);
    expect(ended.json().chapter.status).toBe('drafting');
  });

  it('answers with a JSON error, not a stream, when a turn is refused up front', async () => {
    const { call } = await signedIn();
    const { chapters } = await writingProject();
    const res = await call('POST', `/chapters/${chapters[1]!.id}/start`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('Chapter 1 must be locked');
  });

  it('finishes the stream with a warning when the chronicle step fails', async () => {
    const { call } = await signedIn();
    const { chapters } = await writingProject();
    llm.push({ stream: ['The lamp '] }); // then the extractor has no response: a warning, not an error
    const res = await call('POST', `/chapters/${chapters[0]!.id}/start`);
    const kinds = sseEvents(res.body).map(([e]) => e);
    expect(kinds).toContain('warning');
    expect(kinds.at(-1)).toBe('done');
  });

  it("hides other users' chapters", async () => {
    const { call } = await signedIn();
    const { chapters } = await writingProject('someone@else.com');
    expect((await call('GET', `/chapters/${chapters[0]!.id}`)).statusCode).toBe(404);
  });
});

describe('chapter download', () => {
  /** Chapter 1 locked with a final draft, and play data that must not leak into the file. */
  async function lockedChapter(ownerEmail = credentials.email) {
    const { project, chapters } = await writingProject(ownerEmail);
    const chapter = chapters[0]!;
    await services.repos.play.addTurn({
      projectId: project.id,
      chapterId: chapter.id,
      role: 'author',
      inputKind: 'author_note',
      content: 'AUTHOR-NOTE-SHOULD-NOT-APPEAR',
    });
    await services.db.insert(schema.chapterDrafts).values({
      projectId: project.id,
      chapterId: chapter.id,
      version: 1,
      prose: 'The tide came in the way it always had.\n\nShe read the date twice.',
      wordCount: 15,
      isCurrent: true,
    });
    await services.db
      .update(schema.chapters)
      .set({ status: 'locked', lockedAt: new Date() })
      .where(eq(schema.chapters.id, chapter.id));
    return { project, chapter, next: chapters[1]! };
  }

  it('downloads a locked chapter as a Word file with prose only', async () => {
    const { call } = await signedIn();
    const { chapter } = await lockedChapter();
    const res = await call('GET', `/chapters/${chapter.id}/download.docx`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('wordprocessingml');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="the-tide-letters-chapter-01.docx"',
    );
    const zip = await JSZip.loadAsync(res.rawPayload);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('New Moon');
    expect(xml).toContain('She read the date twice.');
    expect(xml).not.toContain('AUTHOR-NOTE-SHOULD-NOT-APPEAR');
  });

  it('refuses chapters that are not locked', async () => {
    const { call } = await signedIn();
    const { next } = await lockedChapter();
    const res = await call('GET', `/chapters/${next.id}/download.docx`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Only locked chapters can be downloaded');
  });

  it("hides other users' chapters", async () => {
    const { call } = await signedIn();
    const { chapter } = await lockedChapter('someone@else.com');
    expect((await call('GET', `/chapters/${chapter.id}/download.docx`)).statusCode).toBe(404);
  });
});

describe('review, characters, and book API', () => {
  const kit = () => ({ ctx: services, llm, queued, close });

  it('reviews, waives, and locks chapters, then reads the cohesion structures', async () => {
    const { call } = await signedIn();
    const { project, chapters } = await seededProject(services);
    const [c1, c2] = chapters;

    await draftSeedChapter(kit(), c1!.id, 1);
    const review = (await call('GET', `/chapters/${c1!.id}/draft`)).json();
    expect(review.canLock).toBe(true);
    expect(review.paragraphs).toHaveLength(2);
    const locked = await call('POST', `/chapters/${c1!.id}/lock`);
    expect(locked.json().chapter.status).toBe('locked');
    await runQueued(kit(), 'outline.replan', sampleReplan);

    expect((await call('GET', `/projects/${project.id}/ledger`)).json()).toHaveLength(1);
    const promises = (await call('GET', `/projects/${project.id}/promises`)).json();
    expect(promises[0]).toMatchObject({ status: 'open', window: { from: 2, to: 2 } });
    const knowledge = (await call('GET', `/projects/${project.id}/knowledge`)).json();
    expect(knowledge[0]).toMatchObject({ character: 'Maren Tull', learnedChapter: 1 });

    await draftSeedChapter(kit(), c2!.id, 2);
    const refused = await call('POST', `/chapters/${c2!.id}/lock`);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().problems).toEqual(['2 blocker(s) not fixed or waived']);
    const noReason = await call('POST', `/chapters/${c2!.id}/issues/r1/waive`, { reason: '' });
    expect(noReason.statusCode).toBe(422);
    for (const id of ['r1', 'c1']) {
      await call('POST', `/chapters/${c2!.id}/issues/${id}/waive`, { reason: 'Intentional' });
    }
    // Tomas's checkpoint is not pending until this lock, so only the blockers mattered.
    expect((await call('POST', `/chapters/${c2!.id}/lock`)).statusCode).toBe(200);

    const unlocked = (await call('POST', `/chapters/${c1!.id}/unlock`)).json();
    expect(unlocked.flagged).toEqual([2]);
  });

  it('lists, edits, and approves character cards', async () => {
    const { call } = await signedIn();
    const { project, tomas } = await seededProject(services);
    const list = (await call('GET', `/projects/${project.id}/characters`)).json();
    expect(list.map((c: { name: string }) => c.name)).toEqual(['Maren Tull', 'Tomas Reyne']);

    const bad = await call('PATCH', `/characters/${tomas.id}`, {
      card: { ...seedTomasCard, principles: [] },
    });
    expect(bad.statusCode).toBe(422);
    const renamed = await call('PATCH', `/characters/${tomas.id}`, { aliases: ['the inspector'] });
    expect(renamed.json().aliases).toEqual(['the inspector']);
    const promoted = await call('POST', `/characters/${tomas.id}/draft`, { notes: 'Older.' });
    expect(promoted.json().drafting).toBe(true);
    expect(queued.at(-1)).toMatchObject({ type: 'character.draftCard' });
  });

  it('assembles and exports the book, and downloads the file', async () => {
    const { call } = await signedIn();
    const { project, chapters } = await seededProject(services);
    for (const n of [1, 2, 3] as const) {
      await draftSeedChapter(kit(), chapters[n - 1]!.id, n);
      await waiveAndLock(kit(), chapters[n - 1]!.id);
    }
    const assembled = (await call('POST', `/projects/${project.id}/assemble`)).json();
    expect(assembled.project.status).toBe('assembling');
    await runQueued(kit(), 'book.review', sampleBookReview);

    await call('POST', `/projects/${project.id}/export`, { format: 'markdown' });
    await runQueued(kit(), 'book.export');
    const book = (await call('GET', `/projects/${project.id}/book`)).json();
    expect(book.review.issues).toHaveLength(1);
    const file = await call(
      'GET',
      `/projects/${project.id}/exports/${book.exports[0].id}/download`,
    );
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('text/markdown');
    expect(file.headers['content-disposition']).toBe('attachment; filename="the-tide-letters.md"');
    expect(file.body).toContain('## Chapter 3: Keep the Light');

    const usage = (await call('GET', `/projects/${project.id}/usage`)).json();
    expect(usage.byAgent.map((a: { agent: string }) => a.agent)).toContain('book_reviewer');
  });
});
