# Story Forge

Co-write a novel by playing it as an interactive story, one chapter at a time. See [SPEC.md](SPEC.md) for the design and [PLAN.md](PLAN.md) for build progress.

## Layout

| Path                | What                                                    |
| ------------------- | ------------------------------------------------------- |
| `apps/web`          | React + Vite front end, served by the API in production |
| `apps/api`          | Fastify REST + SSE server                               |
| `apps/worker`       | BullMQ job consumers                                    |
| `packages/core`     | Domain logic, schemas, agents                           |
| `packages/db`       | Drizzle schema, migrations, repositories                |
| `packages/services` | Use cases combining agents and repositories             |
| `prompts/`          | Versioned agent prompt templates                        |
| `render.yaml`       | Render Blueprint                                        |

## Local development

Needs Node 24, pnpm 10 (`corepack enable`), Postgres, and Redis.

```sh
cp .env.example .env        # then fill in DATABASE_URL, AUTH_*, ANTHROPIC_API_KEY
pnpm install
pnpm build                  # packages must build before the apps run
pnpm db:migrate
pnpm dev                    # API on :3000, web on :5173 (proxies /api), worker
```

Sign in with `AUTH_ALLOWED_EMAIL` and `AUTH_PASSWORD`.

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test
```

Tests never call the live API: agents run against `FakeLlm` with recorded responses, and database tests use PGlite, so no local Postgres is needed.

To check the cohesion critic itself against the seeded test book (three planted violations) with the live model, run `ANTHROPIC_API_KEY=... pnpm eval:cohesion`. It makes a few strong-tier calls.

To check the deepening pass on the test chapter (`packages/core/fixtures/weakest-light/`), run `ANTHROPIC_API_KEY=... pnpm eval:prose`. It compares the pass with a human editor's revision of the same draft and makes three strong-tier calls.

After changing `packages/db/src/schema.ts`, run `pnpm db:generate` and commit the new migration. CI fails if you forget.

## Deploy

On Render: **New → Blueprint**, pick this repo, and fill in the `sync: false` values (`AUTH_ALLOWED_EMAIL`, `AUTH_PASSWORD`, `ANTHROPIC_API_KEY`). Migrations run in the web service's pre-deploy step.

Book exports are stored in Postgres unless `S3_BUCKET` is set, in which case they go to S3 (also set `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` in the `storyforge-shared` environment group, which both services use).
