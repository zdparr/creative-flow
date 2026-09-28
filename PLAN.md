# Story Forge — Build Plan

Source of truth: [SPEC.md](SPEC.md). This file tracks the current phase, decisions, and open questions.

## Current phase

**Phase 1 — Foundation.** Code complete and passing locally (lint, typecheck, 23 tests, build).
Remaining for done-when: deploy from the Blueprint on Render and confirm migrations run in pre-deploy.

| Phase                       | Status                                 |
| --------------------------- | -------------------------------------- |
| 1. Foundation               | Done (deployed 2026-09-28)             |
| 2. Intake, bible, outline   | Code done; awaiting live run on Render |
| 3. Play loop                | Not started                            |
| 4. Characters               | Not started                            |
| 5. Novelize, cohesion, lock | Not started                            |
| 6. Re-plan and drift        | Not started                            |
| 7. Assembly and export      | Not started                            |

## Decisions

- **Stack:** the spec's recommended stack, since the existing story engine was not available to compare. Revisit if the open questions below change that.
- **Versions:** TypeScript pinned to 6.0.x because typescript-eslint does not support 7.x yet. Node 24 (`.nvmrc`), pnpm 10 pinned in `packageManager`. Render builds use its preinstalled pnpm (`/usr/bin` is read-only, so `corepack enable` fails there); pnpm switches itself to the pinned version.
- **Auth:** single-user email + password from `AUTH_ALLOWED_EMAIL` and `AUTH_PASSWORD` (Render env vars, never in code), compared in constant time (`packages/core/src/auth/credentials.ts`). Replaced the original magic-link login because v1 has no email provider. Sessions are stateless HMAC-signed cookies lasting 30 days. Login locks for 15 minutes after 5 failures; the lock is global, not per IP, because the client IP behind Render's proxy can be spoofed via forwarded headers. The spec's magic link or OAuth can return later behind the same session cookie.
- **Queue:** one BullMQ queue (`storyforge`) with the job type as the job name, so the worker has one consumer at concurrency 2. Unknown or not-yet-built job types fail visibly.
- **Schema:** status enums are defined once in `packages/core` and reused for the Postgres enums. The `jobs` row id is the BullMQ job id: BullMQ rejects `:` in custom ids, so the spec's `type:<id>:<seq>` format can't be used, and a row created before enqueueing gives the same guarantee (a retried enqueue never runs twice). Repeat requests reuse an active job instead of creating another. `users` and `projects` carry no `project_id`. `payoff_window` is stored as `int4range` and read as text until Phase 5 needs more.
- **Chapter transitions:** `drafting → playing` and `review → playing/drafting` cover the spec's "revise" paths; `needs_recheck → review/locked` covers re-verification after an unlock. `assembling → writing` lets the author revise flagged chapters.
- **Migrations:** generated with drizzle-kit into `packages/db/drizzle`, applied by `node packages/db/dist/migrate.js` in the web service's `preDeployCommand`. CI applies them to a clean Postgres 18 and fails if the schema changed without a migration.
- **Render plans:** `0.5c-512mb` for web and worker (pre-deploy needs a paid instance), `256mb` Key Value (persistent, `noeviction`), `0.1c-256mb` Postgres 18. `AUTH_SECRET` uses `generateValue`.
- **Tests:** Vitest at the root, aliased to workspace sources so tests do not need a build. Database tests run on PGlite (in-process Postgres) with the real migrations, so they need no local Postgres. Model calls are replaced by `FakeLlm` replaying fixtures from `packages/core/src/testing/fixtures.ts`.

### Phase 2

- **`packages/services`:** use cases that need both agents (core) and repositories (db) live in a third package, because db already depends on core. API routes and worker handlers call these and stay thin.
- **Model calls:** `LlmClient` in core is the only place that touches the Anthropic SDK. Calls stream and use `finalMessage()`, adaptive thinking, effort `medium` for the fast tier and `high` for the strong tier, and a cache breakpoint on the system prompt. Refusals raise `LlmRefusalError`.
- **Structured output:** agents ask for JSON, then validate with Zod plus domain checks (spine completeness, anchors in place). Invalid output retries once with the problems listed, then fails. Constrained decoding (`output_config.format`) is behind `STRUCTURED_OUTPUTS`, off by default, because Opus 5.5 is not yet on the documented list of supported models. Turn it on once confirmed.
- **Interview:** runs inline in the API request (it's the fast tier, and the author is waiting on it). Rounds 1-3 must ask questions, rounds 4-5 may draft, and after round 5 the bible is required. Unanswered questions count as skipped. Two concurrent requests for the next round resolve to the same round.
- **Bible:** stored as spine, world, and style-guide JSONB. The cast lives inside `world.cast`; character cards (Phase 4) will be built from it. The title is stored on the project. Every save or regeneration is a new version; approval stamps the latest. Section regeneration reuses the interviewer agent with a revise task.
- **Spine gate:** 3-5 anchor beats, including an inciting incident and a climax, each assigned to a chapter within `chapterCount`. The spec lists the four standard anchors "plus optional others" but also says 3-5 in all, so only the two bookends are required.
- **Outline:** the outliner runs as the `outline.generate` job, started automatically when the bible is approved and again on regenerate with notes. Each chapter stores its planned promises (`outline_chapters.promises`, new in migration 0001). Author edits and reorders save as a new version with chapters renumbered by position. Approval checks the outline against the spine (chapter count, anchors in their target chapters, promises paying off later) and creates the `chapters` rows.
- **Job progress:** the Outline screen polls every 3 seconds while a job is queued or running. The spec's SSE `/events` stream is deferred to Phase 3, which builds SSE for play turns anyway.
- **Reorder:** drag and drop plus up/down buttons, because native drag doesn't work on phones.

## Open questions

From the spec:

- Reuse the existing story engine's world-state and context code as a shared package, or start fresh? (Assumed fresh.)
- Does the existing engine use a different stack that this app should match? (Assumed no.)
- Which seed world, if any, should the first test novella use? (Needed by Phase 5's seeded test book.)

From the build:

- If Render's preinstalled pnpm fails to honor `packageManager`, switch the build command to `npx --yes pnpm@10.34.5 install --frozen-lockfile && npx --yes pnpm@10.34.5 build`.
