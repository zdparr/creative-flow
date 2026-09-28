# Story Forge — Build Plan

Source of truth: [SPEC.md](SPEC.md). This file tracks the current phase, decisions, and open questions.

## Current phase

**Phases 4-7: code complete, awaiting a live run on Render.** Each phase's done-when check passes locally against recorded model responses (lint, typecheck, 135 tests, build):

- Phase 4: `packages/services/src/phase4.test.ts` (a character introduced in play gets a drafted card the author approves).
- Phase 5: `phase5.test.ts` (the seeded test book's three planted violations are caught; lock commits atomically and rolls back whole on failure). `pnpm eval:cohesion` runs the same check against the live critic.
- Phase 6: `phase6.test.ts` (adopting a drift updates the outline; unlocking chapter 2 flags chapter 3).
- Phase 7: `phase7.test.ts` (a 3-chapter novella exports in EPUB, DOCX, PDF, and Markdown).

The spec asks for each phase to pass before the next begins. At the author's request (2026-09-28) Phases 4-7 were built together, so their live checks on Render are batched: play a chapter to lock, adopt a drift, unlock and relock, then assemble and export.

| Phase                       | Status                                         |
| --------------------------- | ---------------------------------------------- |
| 1. Foundation               | Done (deployed 2026-09-28)                     |
| 2. Intake, bible, outline   | Done (verified live 2026-09-28)                |
| 3. Play loop                | Done (played live 2026-09-28)                  |
| 4. Characters               | Code done; awaiting live run on Render         |
| 5. Novelize, cohesion, lock | Code done; awaiting live run and eval:cohesion |
| 6. Re-plan and drift        | Code done; awaiting live run on Render         |
| 7. Assembly and export      | Code done; awaiting live run on Render         |

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

### House style: dashes (requested 2026-09-28)

- **Rule:** em dashes only for cut-off speech, directly before the closing quote (`"I'll—"`). No other em dashes, no en dashes, no spaced hyphens as dashes. Hyphens in compound words are fine. The rule lives in `prompts/house-style.md` and applies to every book.
- **Where:** `withHouseStyle()` appends it to every prose-writing prompt (director, NPC voice, interviewer); the logged prompt version records both, e.g. `director@1+house-style@1`.
- **Enforcement:** `dashViolations()` checks non-streamed prose, and a violation triggers the usual retry: NPC action and dialogue (the director quotes it verbatim) and the bible's style samples. The director's narration streams live, so for it the rule is a prompt instruction only.
- **Phase 5 must:** give the novelizer `withHouseStyle` and a `dashProblems` check on its prose, so final chapter text (and the .docx download) is enforced, not just instructed. The cohesion critic should report any that slip through under `style`.

### Phase 4: characters

- **Cards:** one stored shape (`CardContent`, the major tier's fields), with lower tiers leaving fields empty. `missingCardFields` enforces each tier's required fields at approval. Major cards require principles, goal, fear or flaw, arc start and end, and voice samples; the secret, checkpoints, and relationships are drafted but optional.
- **The bible's cast** becomes approved v1 cards (source `bible`) the first time they are needed, since the author approved those fields with the bible. Major fields they lack can be filled by editing the card or regenerating it with notes.
- **Detection:** walk-ons named in play get an approved card straight from the extractor (the spec asks nothing of the author for them). Minor and major characters start provisional with a seed card, usable in play at once, and a `character.draftCard` job drafts the full card as a pending version.
- **The tray:** drafts to approve and promotions to consider appear in the Play screen's side panel as "Cards to review", available between turns (hidden while a turn runs, never a modal), and on the Characters tab. The data has no scene boundary for the spec's "end of scene", so any pause between turns counts.
- **Promotion** is suggested by rule, not by the director: a character in 3+ chapters, in a scene that hit a required beat, or named in a promise. Raising the tier drafts only the missing fields; filled fields are kept exactly.
- **Versioning:** every card change is a version with the chapter it takes effect in. `cardsAsOf(chapter)` gives the newest approved version by then (or the draft, for provisional characters). An author edit to an approved card takes effect in the chapter now being written.
- **Merge** moves chronicle, ledger, promise, and knowledge references to the kept character and adds the duplicate's name as an alias. **Reject** is for provisional characters only and removes them from the chronicle's cast lists.

### Phase 5: novelize, cohesion, lock

- **Flow:** ending a chapter queues `chapter.novelize`; the new draft queues `chapter.cohesion`; the report moves the chapter to `review`. Regenerating goes back to `drafting` with the author's notes and the current draft. An inline edit is a new draft version whose report must be re-run ("Check again") before lock.
- **Novelizer:** strong tier, prose output (not JSON). It gets the style guide, the chapter plan, every canon chronicle event (with interiority notes, author directions, and the quoted dialogue from that event's turns), the chapter's cards, and the previous chapter's prose. Forbidden dashes or banned phrases retry once; anything left is flagged in the report as a style warning.
- **Critic:** strong tier, JSON. Besides the issue table it proposes what the lock commits: promises paid, new promises planted (with payoff windows), arc checkpoints met, and the 300-500 word chapter summary. Rule checks that need no model run alongside it: house-style dashes and banned phrases per paragraph (warnings), and open promises whose window ends by this chapter without being paid (blockers).
- **Summaries come from the cohesion job**, so the lock transaction writes the summary itself. The spec's `chapter.lockFinalize` job is therefore folded into the lock and removed from the job list.
- **Lock gate:** a current report for the current draft, every blocker fixed or waived with a logged reason, and no unapproved minor or major card among the chapter's characters.
- **Lock transaction:** commits the canon events' candidate facts to the ledger (names resolved to character and location ids), knowledge entries (characters in the scene witnessed a fact; characters named in it were involved), paid and planted promises, and pending card versions for arc checkpoints met (effective next chapter, awaiting approval). It writes the summary, snapshots the whole project state, and sets `locked`, then queues the re-plan (except after the last chapter).
- **Promises** can be extended or dropped by the author from the Book tab. A waiver does not close a promise, so an overdue promise keeps blocking later chapters until it is paid, extended, or dropped.
- **Seeded test book** (`packages/core/src/testing/seedBook.ts`): three chapters with a promise left unpaid past its window, a knowledge violation, and a principle violation. The test replays recorded critic output, so it checks that the critic receives the evidence and that its findings become blockers; `pnpm eval:cohesion` checks that the live critic catches all three.
- **Job progress** is polled every 3 seconds with stage labels ("Drafting prose", "Checking cohesion") rather than the spec's `/events` SSE stream: one author, a handful of job types, and no push requirement beyond that.

### Phase 6: re-plan and drift

- **Drift detection** is part of the extractor's structured output, not the director's, because the director streams prose only. The extractor sees the continuity facts (with short refs) and major characters' principles, and raises `beat`, `contradiction`, `thread`, or `principle` notices, never for author directions.
- **Steer back** adds the notice to the director's "Steer back to the plan" section for the rest of the chapter. **Adopt** writes the change immediately: a beat's description becomes what happened (a new outline version, and the beat counts as hit); a contradicted fact is superseded; a new thread becomes an open promise through the last chapter; a principle change becomes a new approved card version. Adoptions are also fed to the re-planner.
- **Re-planner** (strong tier, after each lock) proposes full replacements for later chapters, with reasons. It may not touch locked chapters or move anchors, and the outline must still fit the spine; violations retry once. Proposals are stored as a diff (`replan_diffs`), and each change is accepted (a new outline version, provided that chapter has not started) or rejected on the Outline tab.
- **Outline revisions** after approval create a new approved outline version and repoint every chapter row at its new plan.
- **Unlock** returns the chapter to review, flags every later locked chapter `needs_recheck`, and re-runs their cohesion checks; nothing is restored. A flagged chapter is confirmed with "Confirm lock" (the same gate). Re-locking a chapter does not duplicate its ledger facts or promises; facts dropped by the revision stay in the (append-only) ledger, where the author sees them.
- **A spine edit** after bible approval (which the spec says triggers a full re-plan) is not supported yet: the bible is read-only once approved.

### Phase 7: assembly and export

- **Assemble** (all chapters locked) moves the project to `assembling` and runs the book reviewer on chapter summaries, the promise registry, and arc status. Its issues point to chapters; revising one means unlocking it, which returns the book to `writing`. The reviewer does one pass; the spec's second pass over flagged chapters' full prose is not implemented.
- **Export** runs as `book.export`: Markdown, Word (manuscript format, a title page, each chapter on a new page), EPUB 3 (built with JSZip, mimetype first and uncompressed), and PDF (PDFKit, Times, US Letter). Files go to S3 when `S3_BUCKET` is set and download through a short-lived signed link; otherwise they are stored in Postgres (`exports.content`), which is plenty for a novella.
- **Book tab:** chapters with status and word counts, the review, exports, the promise registry (extend, drop, reopen), the ledger, and usage by agent and by chapter. Play and job calls now record their chapter, so per-chapter cost is real.
- **Not built:** the optional per-project budget (soft warning at 80%, hard stop at 100%).

## Open questions

From the spec:

- Reuse the existing story engine's world-state and context code as a shared package, or start fresh? (Assumed fresh.)
- Does the existing engine use a different stack that this app should match? (Assumed no.)
- Which seed world, if any, should the first test novella use? (The seeded test book uses the sample lighthouse story from the test fixtures.)

From the build:

- The director runs at `medium` effort. If turns feel slow, try `low` for the fast tier.

- If Render's preinstalled pnpm fails to honor `packageManager`, switch the build command to `npx --yes pnpm@10.34.5 install --frozen-lockfile && npx --yes pnpm@10.34.5 build`.
