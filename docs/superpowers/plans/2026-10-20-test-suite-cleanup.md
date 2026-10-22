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
- `ContextScreen.test.tsx`: assert supported language availability/uniqueness, the required priority prefix and localized tail order, recovery permissions and blocked repeat Start/settings without wrapper classes or DOM identity.
- `ConversationScreen.test.tsx`: retain early-output status, visible long captions, keyboard access, focus and recovery; remove styles/classes/rotation checks.
- `sessionReducer.test.ts` and `SessionController.test.ts`: retain source ownership, completed turns, input gating and lifecycle outcomes; remove obsolete `expectedSpeaker` checks and reducer object-identity requirements.
- `liveSession.test.ts`: both failure branches prove a successful next HTTP creation with a real one-slot registry, followed by rejection while full; safe diagnostic assertions remain.
- `conversations.test.ts`: add three real SQLite HTTP scenarios for retained admission until confirmed closure, cleanup/final usage/End after quota exhaustion, and lost resume completion receipts.
- `serverLifecycle.test.ts`: keep the accurately named limiter unit test; add the actual worker/emergency integration with a SQLite persistence fault and held provider close.
- Browser startup/mobile/recovery/conversation/guidance tests: remove copy-only, color, font, style and decorative geometry assertions; retain keyboard focus, accessibility, disabled/busy states, caption ownership/history and reading-position behavior.
- Paid real-Live harness: explicit saved ru/en pair, current one-click start and retained-history End flow, unique temporary SQLite, and bounded cleanup after failures. Browser audio calibration and network/media assertions remain.

## PR review follow-up

- Retain one browser regression for B's opposite-facing captions. It reads the composed visual orientation through all ancestors instead of fixing an inline style or CSS class. Disabling rotation made the test fail in Chromium and WebKit.
- Remove the temporary real-Live database and its WAL/SHM files in a reporter's finalization hook, after Playwright stops the web servers and every provider attempt is terminal. Ordinary global teardown runs before web-server teardown. Integration probes with a real SQLite-owning subprocess verify successful tests, failed tests and API startup failure.
- Run session cleanup and conversation End independently, collect all failures afterward, and end each conversation once. Two HTTP/SQLite regressions verify that both conversations end and the failed session receives a durable cleanup fence even when its cleanup request times out or returns 503.
- Follow-up verification: 1884 Vitest tests passed in 63 files; 108 Chromium/WebKit E2E tests passed with retries disabled and the existing 3 device-engine skips. API/web/real-harness TypeScript, ESLint and diff checks passed. Paid Live tests were collected only; the working database was never opened.

## PR review: recovery ledger and inherited environment

- [x] Reproduce the HTTP fixture's 401 failure under inherited production settings, then load the existing isolated API setup before API/config imports in that fixture.
- [x] Add SQLite regressions for pending provider cleanup and an unreadable database; verify they fail before changing the reporter.
- [x] Inspect only the run's generated database in read-only mode after server exit. Remove it only when every attempt is terminal; preserve it and report its path when closure cannot be verified.
- [x] Verify the fixes under inherited production settings, run the full isolated Vitest suite and relevant static checks, and record the results.

Verification: both HTTP cases failed with 401 under inherited production settings before the setup import and passed afterward. Both new preservation cases failed before the reporter fix; all 5 ledger-lifecycle cases now pass, including deletion after passed/failed/startup-failed runs with terminal attempts. The full suite passed 1886 tests in 63 files with an unrelated parent database sentinel unchanged. API/web/real-harness TypeScript, scoped ESLint and diff checks passed; paid tests were collected only. No paid Live session or working database was opened.

## Final browser review

- Normalize the composed caption axes before checking an approximately 180-degree orientation, so scale changes do not affect the result. A temporary 120-degree mutation passed the former sign checks and timed out later at the obscured End button; the corrected assertion rejects it immediately in Chromium and WebKit. The mutation was removed.
- Make the browser fixture's `document.hidden` follow `document.visibilityState`, fixing the pre-existing TS2367 exposed by standalone E2E typechecking and keeping the mocked browser properties consistent.
- Verification after both changes: 108 browser tests passed, 3 existing device-engine skips, retries disabled. Standalone E2E TypeScript and scoped ESLint passed.

## Process exit portability

- Replace the PID-disappearance assertion with an exit acknowledgement written by the exact fixture process. Linux zombies and unrelated PID reuse no longer affect the result; shutdown/file-removal checks remain. Windows force-termination is verified through resource cleanup, while explicit startup failure also requires the exit acknowledgement.
- The acknowledgement assertion failed before the fixture emitted it; all 5 lifecycle cases pass afterward. Web TypeScript and scoped ESLint passed.

## Initial mobile choices and recording announcements

- Restore the initial mobile availability contract: the first four language choices and Start are fully in view before scrolling, and a partially visible next row signals more choices. Native intersection observation measures the visible radio labels without CSS selectors or fixed row dimensions. The existing touch-target and scroll/select checks remain.
- Check the recording live region for both A and B. It must announce listening/recording and identify the current participant; partial text patterns avoid fixing the full sentence or surrounding copy.
- Mutation verification: showing only one initial choice or removing the partial-row cue passed the former scroll-only assertions and failed the strengthened checks in both Chromium and WebKit. Empty or wrong-side announcements passed the former presence-only check and failed the strengthened checks. All temporary mutations were removed.
- Verification: 1887 Vitest tests passed in 63 files with the unrelated parent database sentinel unchanged; 108 Chromium/WebKit E2E tests passed with retries disabled and the existing 3 engine skips. Web TypeScript, standalone E2E TypeScript and scoped ESLint passed.

## Remaining behavior contracts and persistent Playwright runs

- Keep the fixed `es, en, fr, de, it, pt` priority prefix alongside supported-set/uniqueness checks. Check the rendered remainder's alphabetical order in Russian and English without fixing translated language names.
- Require the disabled sample-saving flow's live region to announce saving, using a partial meaning check. The separate A/B recording cases remain.
- Check the actual language labels against the existing 44 by 44 minimum touch target. Measure caption font size before and after 200% enlargement at the same viewport; the assertion protects relative enlargement without pinning the design's normal font size.
- Playwright 1.63 calls both `onEnd` and `onExit` after each persistent/UI batch, before stopping web servers. The reporter now permits terminal-ledger deletion only for known one-shot CLI runs, using public `FullConfig.argv`; UI, watch, test-server and unknown runners preserve the files and print the recovery path. Pending/unreadable inspection remains exercised in eligible one-shot mode. Persistent runs intentionally retain their temporary ledgers after exit.
- The actual installed UI dispatcher runs two batches against one synthetic SQLite server. Both batches must pass while the API remains usable and its database/WAL/SHM files remain present; explicit global teardown then stops the server. Before the fix, Windows rejected the premature unlink with `EPERM` and both batches failed. All 11 ledger-lifecycle/mode cases now pass, including ordinary CLI success/failure/startup-failure cleanup. This headless fixture uses Playwright internals and must be revisited when upgrading Playwright.
- Mutation verification: reordering priority or tail choices, removing the saving announcement, shrinking labels to 32px, and keeping captions at 22px during 200% enlargement passed the former assertions and fail the strengthened checks. Both browser engines reject the accessibility mutations; all temporary mutations were removed.
- Verification: 1894 Vitest tests passed in 63 files with the unrelated parent database sentinel unchanged; 108 Chromium/WebKit E2E tests passed with retries disabled and the existing 3 engine skips. API/web/real-harness and changed E2E TypeScript, scoped ESLint and diff checks passed. No paid session or working database was opened.

## Timeout recovery and remaining conversation contracts

- Keep B physically above A in the portrait courier scenario by comparing actual pane bounds. The existing opposite-facing caption check remains; neither assertion fixes DOM order or a transform class.
- In the long-caption scenario, measure vertical overlap between the author's text and the caption's first character, in both panes while the turn is active and after it closes. The check allows typography changes without losing the required shared line.
- Compare each guidance region's image before and after keyboard focus, with its content and scroll position unchanged. This verifies a painted focus indication without fixing its color, width, CSS mechanism or a stored screenshot baseline.
- Mutation verification: reversed pane placement, a block-level author prefix and a removed focus outline each fail their new assertions in Chromium and WebKit. All three unmodified scenarios pass in both engines; temporary mutations were removed.
- The CLI shape alone does not prove server shutdown: Playwright's overall deadline can also abort teardown. Delete a terminal ledger only for passed/failed one-shot runs without runner errors; preserve it on timeout, interruption and runner/setup/teardown errors as well as persistent/unknown modes. Startup-failed runs now deliberately retain their ledger, superseding the earlier cleanup expectation above.
- A real `--global-timeout=4000` probe observes HTTP 200 and an existing SQLite row during `onEnd`, before the CLI terminates its server. It requires the database and both sidecars to remain present and the server to be unreachable after CLI exit. Before the fix, Windows emitted `EPERM` on premature unlink. All 16 lifecycle/mode cases pass; timeout shutdown can be forced, so the test does not demand a graceful-exit marker in that case.
- Verification: 1899 Vitest tests passed in 63 files with the parent database sentinel unchanged; 108 Chromium/WebKit E2E tests passed with retries disabled and 3 existing skips. Web and standalone E2E/real-harness TypeScript, scoped ESLint and diff checks passed. No paid Live session or working database was opened.

## External keyboard-focus paint

- Compare a fixed screenshot region extending eight CSS pixels around each guidance card, clamped to the viewport. Both captures use the same region, content and scroll position; an external outline now counts as visible focus without a stored baseline or a fixed outline style.
- Reproduced the false failure with square cards and an external outline offset in Chromium and WebKit before the fix; both complete scenarios pass afterward. Removing only A's outline and then only B's outline still fails the intended focus assertion in both engines. All temporary styles were removed.
- Verification: full browser suite passed 108 tests with retries disabled and 3 existing skips; standalone E2E TypeScript, scoped ESLint and diff checks passed. This browser-only change does not require a separate local unit/API rerun; CI runs those checks on the new commit. No working database or paid session was used.

## Concurrent pause during real-harness End

- On a 409 from conversation End, read the current conversation version again and retry, with at most three GET/End pairs per conversation. Other failures and an exhausted conflict budget still join the aggregate cleanup error; session closure and other conversations remain independent. The endpoint's existing idempotency makes an already-ended conversation succeed.
- Extend the existing HTTP/SQLite timeout and 503 cleanup cases with an actual pause between reading the second conversation and posting End. Both conversations must still end, including the one whose attempt already closed, while the failed first session keeps its `user_end` cleanup fence. Before the fix the race left a conversation `paused`; both cases pass after retrying with the fresh version.
- Verification: 1899 tests passed in 63 files with the parent database sentinel unchanged. Web and standalone real-harness TypeScript, scoped ESLint and diff checks passed. Paid Live sessions and the working database were not used; browser checks run in CI because this change touches only real-harness teardown.
