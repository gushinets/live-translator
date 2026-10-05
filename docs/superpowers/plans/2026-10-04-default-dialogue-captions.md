# Default Dialogue Captions Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans with test-first changes and one final review.

**Goal:** Make the phone-validated caption blocks the only conversation renderer and hide unresolved fragments without deleting their internal evidence.
**Architecture:** Always collect `DialogueTranscript` in `SessionController`; `ConversationScreen` and `ParticipantPane` render only its resolved blocks. Remove query gating, paired-turn rendering, unknown-text disclosure and unused styles/copy. Operational turns remain for status, audio/lifecycle and accounting.
**Tech Stack:** Existing TypeScript/React/ELD, Vitest and Playwright.
**Spec:** User-approved follow-up to `../specs/2026-10-04-caption-blocks-prototype.md`: default path `/`; user selected hiding the unknown-text block while retaining its buffer. Rendering, not transport/segmentation redesign.

## Global Constraints
- Keep both own originals and translated partner speech, relative author labels, full history, scrolling and per-block language tags.
- Unresolved text has no visible row or placeholder. If later context resolves its language, the entire accumulated phrase appears on its pane.
- Preserve actual recovery controls/errors and audio behavior. Do not remove operational `Turn` state or change model instructions/timing.
- Existing `?captions=blocks` links continue to work, but the query parameter has no effect.
- Preserve declared language-evidence limitations of the tested prototype; do not imply that this change adds diarization for same-script speech without sentence boundaries.
- Do not reload the user's open phone conversation as part of implementation.

## Task 1: Replace the legacy renderer and migrate behavioral checks
Files: controller, screen, participant pane, caption renderer/styles/copy; affected unit/integration/browser/real-test selectors.
Interfaces: `ConversationScreenController.captionBlocks` becomes required; `ParticipantPane.captions` is required and replaces `activeTurn`/`recentTurns` props. Caption collection no longer uses URL state.
- [x] RED: default-path full dialogue and hidden-then-resolved unknown text; controller collects at `/`.
- [x] GREEN: remove gating/legacy renderer/unknown disclosure, retain assembler internals.
- [x] Migrate tests from semantic-turn rows to display blocks, preserving chronology, language-change, lifecycle, scrolling, and long-history assertions. Replace old tests that required duplicate unknown text or empty waiting rows.
- [x] Run all unit tests, API/web types/lint, production build and browser suite.
- [x] Fresh review, fix material findings, commit on the existing feature branch; document results.

## Review Focus
- URL-free collection and old bookmarked URLs must behave identically.
- Hidden fragments must remain available to the assembler and resolve without loss.
- Ordinary text updates must trigger screen subscriptions and preserve user scroll position.
- Language replacement and interruption must retain prior history and real recovery prompts.
- Legacy test fixtures modelled paired turns; migrate intent without retaining dead compatibility code.

## Execution ledger
- Baseline `eb58e4b`, existing `codex/mobile-qa-regression-fixes` checkout; no tracked changes. User explicitly approved default mode and selected hiding unresolved display while retaining the internal buffer.
- Real user test accepted; actual phone screenshots and DOM snapshot saved in `output/caption-blocks-prototype-2026-10-04/user-test-*`. No implementation change to word spacing in this task.

- RED default-path tests failed before removing the gate (6 failures); focused GREEN passed (7 tests). Replaced obsolete paired-turn fixtures with explicit display blocks and migrated browser selectors; no waiting/unknown rows are expected.
- Browser history migration exposed a real ordering defect: leading whitespace carried from the previous packet backdated the next same-script language run. Added a failing regression and based arrival time on the first non-whitespace content. Text and language classification are unchanged. This small chronology repair is the only assembler change.
- Final verification: 59 unit/integration files, 1235 tests passed; Chromium/WebKit 76 passed, 3 existing skips. API/web typecheck and lint passed. Playwright rebuilt the production bundle and service worker before running. Reviewed courier and 200% text-size screenshots.
- Fresh read-only review found no introduced defects, including the whitespace chronology fix. Migrated the paid desktop test's obsolete secondary-caption assertions to primary captions and relative authors, and corrected localized status expectations. Its discovery check (`--list`) passes; no paid speech session was run.
- Logs: `.data/default-captions-all-unit.log`, `.data/default-captions-browser.log`, `.data/default-captions-types.log`, `.data/default-captions-lint.log`. The user's Android conversation was not reloaded or interrupted.
- Integration: keep the completed change on `codex/mobile-qa-regression-fixes`; no merge to main or push in this task.
