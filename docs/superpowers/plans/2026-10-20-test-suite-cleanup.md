# Test suite cleanup implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline, task by task.

**Goal:** Remove presentation-only assertions and proven duplicates while preserving behavioral regressions and isolating every test database.

**Architecture:** Keep production code unchanged. Retain unit tests for contracts, audio, resource cleanup and deterministic races; complement them with HTTP tests backed by temporary SQLite.

**Tech Stack:** Vitest, Supertest, SQLite, Playwright, TypeScript.

**Spec:** The user's revised test review in this conversation and repository AGENTS.md.

## Global constraints

- Never open the working database or run paid Live sessions during verification.
- Keep Origin side-effect guards, zero-time TTL, crypto generation, memory cleanup, audio isolation, multilingual captions and race scenarios.
- Remove copy, CSS source, color and decorative geometry assertions; retain accessibility, history and reading position behavior.
- Do not replace all client boundary tests with a real server.

## Review focus

- Inherited environment must not select the working database or a different API mode.
- Cleanup remains possible after admission quota exhaustion and cannot run for a foreign Origin.
- Worker and emergency cleanup share a single concurrent network budget.
- A lost resume response recovers the committed receipt without a second provider creation.
- Capture stays blocked until the required acknowledgement, and paid test sessions close on assertion failure.

## Tasks

- [x] Isolate API configuration in test setup; verify with an unrelated parent database path.
- [x] Add managed endpoint admission/resume tests with real SQLite; strengthen failed-create capacity checks.
- [x] Retain the limiter unit test and add a real worker/emergency concurrency regression.
- [x] Remove presentation-only checks and exact duplicates; move useful mobile and metrics cases before deleting their redundant scaffolding.
- [x] Replace fixed microtask counts with an event-loop barrier while retaining gated race assertions; await observable caption rendering in browser tests.
- [x] Update the paid Live harness to the current language setup, isolated database and bounded cleanup; only collect/typecheck it.
- [x] Run the full isolated Vitest suite, typecheck, lint and unpaid browser/audio tests; review the resulting diff and test names.
- [x] Run infrastructure persistence verification with a separate image and disposable Docker volume.

## Decisions and verification

- Ruling: replaying a committed resume completion after a later pause returns the current paused conversation with HTTP 200. Verify that it cannot reactivate the conversation, and reject conflicting receipt data with 409.
- Ruling: native `node:timers/promises` `setImmediate` replaces fixed 15/24 microtask loops. It drains ready continuations without advancing fake timers or releasing deliberately held promises. Explicit gates and behavior assertions remain.
- Final review: an independent reviewer found that the paid harness's 10-second cleanup wait was shorter than the provider's 15-second close timeout. Pin the test server timeout to 15 seconds; allow 30 seconds for confirmation and a separate 60-second teardown budget. Attempt cleanup for every tracked ID before reporting any failures.
- Vitest: 1879 passed in 61 files. Both ledger and legacy endpoints ran with synthetic provider boundaries and isolated SQLite; the deliberately supplied parent database sentinel stayed unchanged.
- Browser E2E: 108 passed, 3 existing device-engine skips, with retries disabled. A render race exposed by removing a CSS wait was fixed by waiting for actual caption content and scroll readiness; the affected scenario also passed three consecutive times per engine.
- Audio: 4 Chromium tests passed; 4 WebKit tests skipped because this Windows WebKit build has no Web Audio API.
- API/web TypeScript, paid-harness TypeScript and ESLint passed. Paid tests were collected only; no OpenAI session was created.
- Infrastructure: all 3 Compose configuration tests and the container persistence test passed. The latter used a separately built image and a new random Docker volume, with both containers' networking disabled. The temporary volume and image were removed.
- The shared-budget regression failed as expected under an in-memory source mutation that gave the worker a separate closer. Production files were never mutated.

## Removed standalone checks

| File | Test | Reason |
| --- | --- | --- |
| `apps/web/src/app/App.test.tsx` | `renders the translator title` | Product copy only. |
| same | `declares viewport-fit=cover for safe-area insets` | Exact HTML formatting/layout contract. |
| `apps/web/src/screens/ContextScreen.test.tsx` | `does not render again when subscribing to an unchanged controller` | Freezes React render count. |
| same | `traces the conversation render predicate outcome` | Freezes internal diagnostic log shape. |
| same | `shows the language heading on the first start screen` | Heading copy and HTML level only. |
| same | `does not render an h1 during conversation` | Presentation; conversation navigation is covered elsewhere. |
| `apps/web/src/screens/ConversationScreen.test.tsx` | `does not render again when subscribing to an unchanged controller` | Freezes React render count. |
| same | `fills the phone viewport and keeps B at the physical top` | Reads CSS source and fixes DOM order/styles. |
| `apps/web/src/screens/ContextScreen.mobile.test.tsx` | `renders a concise Russian owner screen without promotional copy` | Exact promotional/heading copy. |
| same | `renders setup as an accessible mobile app shell with a primary action` | Duplicates existing semantic controls; remaining assertions fix wrapper/classes and copy. |
| `apps/web/tests/e2e/mobile-setup.spec.ts` | `uses a Russian PWA description` | Exact metadata copy. |
| `apps/web/src/diagnostics/DeviceDiagnostics.test.ts` | `exposes only the whitelisted diagnostic keys, never transcript/audio content` | Exact snapshot checks already protect the same whitelist. |
| `apps/web/src/live/LiveClient.test.ts` | `creates the data channel before adding tracks or creating the offer` | Duplicates the retained connection-order scenario. |
| `apps/web/src/session/sessionReducer.test.ts` | `does not assign an expected speaker after a completed source turn` | Only asserts absence of an obsolete field. |

## Rewritten and preserved

- Deleted `ContextScreen.mobile.test.tsx` after moving its recording live-region scenario to `ContextScreen.test.tsx` and adding its saving-progress role assertion to the existing in-flight saving scenario.
- Deleted `SessionMetrics.test.ts` after moving both useful cases to `SessionController.test.ts`, reusing its existing controller/audio/live fixture.
- `ContextScreen.test.tsx`: assert supported language availability/uniqueness, recovery permissions and blocked repeat Start/settings instead of sort order, wrapper classes or DOM identity.
- `ConversationScreen.test.tsx`: retain early-output status, visible long captions, keyboard access, focus and recovery; remove styles/classes/rotation checks.
- `sessionReducer.test.ts` and `SessionController.test.ts`: retain source ownership, completed turns, input gating and lifecycle outcomes; remove obsolete `expectedSpeaker` checks and reducer object-identity requirements.
- `liveSession.test.ts`: both failure branches prove a successful next HTTP creation with a real one-slot registry, followed by rejection while full; safe diagnostic assertions remain.
- `conversations.test.ts`: add three real SQLite HTTP scenarios for retained admission until confirmed closure, cleanup/final usage/End after quota exhaustion, and lost resume completion receipts.
- `serverLifecycle.test.ts`: keep the accurately named limiter unit test; add the actual worker/emergency integration with a SQLite persistence fault and held provider close.
- Browser startup/mobile/recovery/conversation/guidance tests: remove copy-only, color, font, style and decorative geometry assertions; retain keyboard focus, accessibility, disabled/busy states, caption ownership/history and reading-position behavior.
- Paid real-Live harness: explicit saved ru/en pair, current one-click start and retained-history End flow, unique temporary SQLite, and bounded cleanup after failures. Browser audio calibration and network/media assertions remain.

## PR review follow-up

- Retain one browser regression for B's opposite-facing captions. It reads the composed visual orientation through all ancestors instead of fixing an inline style or CSS class. Disabling rotation made the test fail in Chromium and WebKit.
- Remove the temporary real-Live database and its WAL/SHM files in a reporter's finalization hook, after Playwright stops the web servers. Ordinary global teardown runs before web-server teardown. Integration probes with a real SQLite-owning subprocess verify successful tests, failed tests and API startup failure.
- Run session cleanup and conversation End independently, collect all failures afterward, and end each conversation once. Two HTTP/SQLite regressions verify that both conversations end and the failed session receives a durable cleanup fence even when its cleanup request times out or returns 503.
- Follow-up verification: 1884 Vitest tests passed in 63 files; 108 Chromium/WebKit E2E tests passed with retries disabled and the existing 3 device-engine skips. API/web/real-harness TypeScript, ESLint and diff checks passed. Paid Live tests were collected only; the working database was never opened.
