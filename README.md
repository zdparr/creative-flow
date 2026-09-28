# Story Forge

Co-write a novel by playing it as an interactive story, one chapter at a time. See [SPEC.md](SPEC.md) for the design and [PLAN.md](PLAN.md) for build progress.

## Layout

| Path            | What                                                    |
| --------------- | ------------------------------------------------------- |
| `apps/web`      | React + Vite front end, served by the API in production |
| `apps/api`      | Fastify REST + SSE server                               |
| `apps/worker`   | BullMQ job consumers                                    |
| `packages/core` | Domain logic, schemas, agents                           |
| `packages/db`   | Drizzle schema, migrations, repositories                |
| `prompts/`      | Versioned agent prompt templates                        |
| `render.yaml`   | Render Blueprint                                        |

## Local development

Needs Node 24, pnpm 10 (`corepack enable`), Postgres, and Redis.

```sh
cp .env.example .env        # then fill in DATABASE_URL, AUTH_SECRET, AUTH_ALLOWED_EMAIL
pnpm install
pnpm build                  # packages must build before the apps run
pnpm db:migrate
pnpm dev                    # API on :3000, web on :5173 (proxies /api), worker
```

To sign in, request a link on the login page; the link prints in the API log.

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test
```

After changing `packages/db/src/schema.ts`, run `pnpm db:generate` and commit the new migration. CI fails if you forget.

## Deploy

On Render: **New → Blueprint**, pick this repo, and fill in the `sync: false` values (`AUTH_ALLOWED_EMAIL`, and later `ANTHROPIC_API_KEY` and the S3 settings). Migrations run in the web service's pre-deploy step.
