# Story Forge — Build Plan

Source of truth: [SPEC.md](SPEC.md). This file tracks the current phase, decisions, and open questions.

## Current phase

**Phase 3 — Play loop.** Code complete and passing locally (lint, typecheck, 80 tests, build). The done-when flow (play a full chapter, end it, chronicle recorded) passes in `packages/services/src/phase3.test.ts` and over HTTP/SSE in `apps/api/src/app.test.ts`, with recorded model responses.
Remaining for done-when: play one chapter on Render against the live models.

| Phase                       | Status                                 |
| --------------------------- | -------------------------------------- |
| 1. Foundation               | Done (deployed 2026-09-28)             |
| 2. Intake, bible, outline   | Done (verified live 2026-09-28)        |
| 3. Play loop                | Code done; awaiting live run on Render |
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
- **Job progress:** the Outline screen polls every 3 seconds while a job is queued or running. The spec's SSE `/events` stream for job status is deferred to Phase 5, when there are several job types to watch; play turns already stream over SSE.
- **Reorder:** drag and drop plus up/down buttons, because native drag doesn't work on phones.

### Phase 3

- **Director:** one streamed fast-tier call per turn, with the book (spine, world, style) in the cached system prompt and the chapter plan, beat tracker, in-scene cards, open promises, and recent turns in the message. It never decides the protagonist's choices. Author notes reach it as `[author: ...]`.
- **NPC voice:** the director calls a `voice_character` tool for major characters other than the protagonist. Each call runs the NPC agent with only that character's card, knowledge, and the turns that mention them, and is saved as an `npc` turn. Minor characters and walk-ons are voiced by the director.
- **Extractor:** runs inline after each turn and writes a chronicle event: summary, characters, location, beats hit, interiority note, and the author's note if any. Candidate facts, promises, and new characters are stored on the event (`chronicle_events.extracted`, migration 0002) and stay pending until the Phase 5 lock. If the extractor fails, the turn stands and the author sees a warning.
- **Characters in Phase 3:** the bible's cast becomes approved character records the first time a chapter is played; newly named characters become provisional records with the tier the extractor proposes. Cards, approval, and merging are Phase 4.
- **Beat tracker:** a beat is hit when a canon chronicle event records it, or when the author ticks it by hand (`chapters.manual_beats`), so a missed detection never blocks the chapter. "End chapter" requires every beat. Removing a scene from canon removes its beats.
- **Context budget:** `buildDirectorContext` in core keeps the last 20 turns, the last 3 locked-chapter summaries, and ledger facts tied to the scene's characters and location. Over budget, it drops oldest turns (down to 4), then oldest summaries, then lowest-severity facts; the spine, plan, and in-scene cards are never dropped. The budget is 60,000 tokens.
- **Streaming:** turns are POST requests answered with a server-sent event stream (`delta`, `npc`, `turn`, `chronicle`, `warning`, `error`, `done`). The stream opens on the first event, so refusals before any output are ordinary JSON errors.
- **One turn at a time:** an in-process lock per chapter rejects a concurrent turn. This relies on the web service running as one instance; move the lock to Redis if it scales out.
- **Order and ending:** chapters are played in order (chapter N needs N-1 locked). Ending moves the chapter to `drafting`; until Phase 5 adds novelizing, "Return to play" moves it back. A failed director response leaves the author's turn in place with a retry button.
- **Swappable protagonist:** the play loop takes a `ProtagonistInput` from its caller. Today that is the author; later it can be an agent seeded with the protagonist's card.

### Chapter download (requested 2026-09-28)

- **What:** a locked chapter downloads as a Word file (`GET /api/chapters/:id/download.docx`, a "Download .docx" button on the Chapters tab). It holds the chapter's current approved draft only: no turns, author notes, interiority notes, or chronicle.
- **When:** only `locked` chapters are final, so the button appears once Phase 5's novelize, review, and lock flow has run on a chapter.
- **Format:** standard manuscript format: Times New Roman 12pt, double-spaced, one-inch margins, half-inch first-line indents (none after the heading or a scene break), chapter heading a third of the way down the page, and `***`/`* * *`/`#` scene breaks rendered as a centered `#`. Built with the `docx` package in `packages/core/src/export/chapterDocx.ts`.
- **Delivery:** generated on request and streamed back, not stored. The spec's S3-backed `exports` table is for whole-book exports in Phase 7.

## Open questions

From the spec:

- Reuse the existing story engine's world-state and context code as a shared package, or start fresh? (Assumed fresh.)
- Does the existing engine use a different stack that this app should match? (Assumed no.)
- Which seed world, if any, should the first test novella use? (Needed by Phase 5's seeded test book.)

From the build:

- The director runs at `medium` effort. If turns feel slow, try `low` for the fast tier.

- If Render's preinstalled pnpm fails to honor `packageManager`, switch the build command to `npx --yes pnpm@10.34.5 install --frozen-lockfile && npx --yes pnpm@10.34.5 build`.
