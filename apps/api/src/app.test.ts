import {
  FakeLlm,
  sampleBible,
  sampleInterviewBible,
  sampleInterviewRound,
  sampleOutline,
  samplePitch,
} from '@storyforge/core/testing';
import { createTestDb } from '@storyforge/db/testing';
import {
  type Enqueue,
  type ServiceContext,
  createServiceContext,
  generateOutline,
} from '@storyforge/services';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
