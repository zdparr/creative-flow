# Story Forge — Build Plan

Source of truth: [SPEC.md](SPEC.md). This file tracks the current phase, decisions, and open questions.

## Current phase

**Phase 1 — Foundation.** Code complete and passing locally (lint, typecheck, 23 tests, build).
Remaining for done-when: deploy from the Blueprint on Render and confirm migrations run in pre-deploy.

| Phase                       | Status                                  |
| --------------------------- | --------------------------------------- |
| 1. Foundation               | Code done; awaiting first Render deploy |
| 2. Intake, bible, outline   | Not started                             |
| 3. Play loop                | Not started                             |
| 4. Characters               | Not started                             |
| 5. Novelize, cohesion, lock | Not started                             |
| 6. Re-plan and drift        | Not started                             |
| 7. Assembly and export      | Not started                             |

## Decisions

- **Stack:** the spec's recommended stack, since the existing story engine was not available to compare. Revisit if the open questions below change that.
- **Versions:** TypeScript pinned to 6.0.x because typescript-eslint does not support 7.x yet. Node 24 (`.nvmrc`), pnpm 10 pinned in `packageManager`. Render builds use its preinstalled pnpm (`/usr/bin` is read-only, so `corepack enable` fails there); pnpm switches itself to the pinned version.
- **Auth:** single-user email + password from `AUTH_ALLOWED_EMAIL` and `AUTH_PASSWORD` (Render env vars, never in code), compared in constant time (`packages/core/src/auth/credentials.ts`). Replaced the original magic-link login because v1 has no email provider. Sessions are stateless HMAC-signed cookies lasting 30 days. Login locks for 15 minutes after 5 failures; the lock is global, not per IP, because the client IP behind Render's proxy can be spoofed via forwarded headers. The spec's magic link or OAuth can return later behind the same session cookie.
- **Queue:** one BullMQ queue (`storyforge`) with the job type as the job name, so the worker has one consumer at concurrency 2. Unknown or not-yet-built job types fail visibly.
- **Schema:** status enums are defined once in `packages/core` and reused for the Postgres enums. Added `jobs.queue_job_id` (unique) to hold the deterministic BullMQ job id from the Reliability section. `users` and `projects` carry no `project_id`. `payoff_window` is stored as `int4range` and read as text until Phase 5 needs more.
- **Chapter transitions:** `drafting → playing` and `review → playing/drafting` cover the spec's "revise" paths; `needs_recheck → review/locked` covers re-verification after an unlock. `assembling → writing` lets the author revise flagged chapters.
- **Migrations:** generated with drizzle-kit into `packages/db/drizzle`, applied by `node packages/db/dist/migrate.js` in the web service's `preDeployCommand`. CI applies them to a clean Postgres 18 and fails if the schema changed without a migration.
- **Render plans:** `0.5c-512mb` for web and worker (pre-deploy needs a paid instance), `256mb` Key Value (persistent, `noeviction`), `0.1c-256mb` Postgres 18. `AUTH_SECRET` uses `generateValue`.
- **Tests:** Vitest at the root, aliased to workspace sources so tests do not need a build.

## Open questions

From the spec:

- Reuse the existing story engine's world-state and context code as a shared package, or start fresh? (Assumed fresh.)
- Does the existing engine use a different stack that this app should match? (Assumed no.)
- Which seed world, if any, should the first test novella use? (Needed by Phase 5's seeded test book.)

From the build:

- If Render's preinstalled pnpm fails to honor `packageManager`, switch the build command to `npx --yes pnpm@10.34.5 install --frozen-lockfile && npx --yes pnpm@10.34.5 build`.
