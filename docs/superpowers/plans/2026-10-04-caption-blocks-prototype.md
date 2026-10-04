# Caption Blocks Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Track RED/GREEN and validation below.

**Goal:** Deliver a bounded, phone-testable independent text view preserving both sides of the dialogue.
**Architecture:** Two accumulated transcript streams feed language-labelled display blocks. `?captions=blocks` selects these blocks instead of legacy paired turns; audio/lifecycle continue unchanged.
**Tech Stack:** TypeScript, React, existing ELD, Vitest, Playwright.
**Spec:** `docs/superpowers/specs/2026-10-04-caption-blocks-prototype.md`

## Global Constraints
- No audio, model instructions, accounting, recovery, or provider API changes.
- Do not infer source/output pairing. No transcript text in the usage ledger.
- Preserve full original/translated dialogue and unassigned text.
- Build product preview on 5173; preserve phone storage except service worker/Cache Storage.

## Review Focus
- Packet boundaries inside names; punctuation and digits between script runs.
- Delayed fragments with approximate timestamps and cross-stream late output.
- Same-script ambiguous speech, mixed-script borrowed words and unsupported script aliases.
- Language replacement or suspension must not splice generations.
- Empty/waiting/repeat rows must not reappear via legacy state.

## Task 1: Assemble and render independent captions
Files: new `conversation/DialogueTranscript.ts` and tests; new `components/DialogueCaptions.tsx`; `SessionController.ts`, `ConversationScreen.tsx`, `ParticipantPane.tsx`; focused controller/UI/browser tests.
Interface: `DialogueTranscript.push(kind, fragment, languages)`, `.blocks`, `.seal()`, `.clear()`; block `{id, kind, text, side?, language?, receivedAtMs}`. Controller exposes immutable block snapshots. Optional pane captions selects the new renderer; query parameter selects prototype.
- [x] Write courier/packet-invariance and UI tests; run and observe RED.
- [x] Implement assembly, lifecycle attachment and renderer; run targeted tests GREEN.
- [x] Run whole unit suite, typecheck/lint, browser regression plus prototype replay.
- [x] Fresh review, fix material defects, build and verify actual USB phone setup.
- [x] Record limitations and evidence; leave prototype reviewable on existing feature branch.

## Execution ledger
- Existing feature branch `codex/mobile-qa-regression-fixes`, baseline `b14da47`; tracked tree clean. Work in the existing checkout under the user's autonomous authorization. Avoid recreating/archive operations that previously damaged shared dependency junctions.
- Ruling: bounded opt-in prototype, not a wholesale replacement of lifecycle turns. This isolates the text experiment; legacy routing/accounting complexity remains until real-device validation.
- Pre-flight: assembler -> controller snapshot -> pane renderer share the block interface above. Legacy turn data remains solely for unchanged operational paths and the comparison view.
- RED/GREEN: 13 assembler tests first failed with an empty implementation, then passed. Controller and rendered full-dialogue tests failed against the legacy-only implementation, then passed.
- Fresh review found four P2 defects: overlapping scripts, lifecycle repeat guidance, timestamp ordering undone by arrival sorting, and an N×R fragment scan. All fixed: shared Han and lifecycle UI tests RED→GREEN; reversed A-B-A timestamps and legacy opt-out tests RED→GREEN; linear overlap scan measured below. Added real orientation recovery regression.
- Final verification: 59 unit files / 1243 tests pass; API/web typecheck and lint pass; production build pass; Chromium/WebKit 76 pass / 3 existing skips. First targeted browser run's Windows child-process teardown hung; stopped only the verified 4173 test server, runner exited 0 (4 pass). Final full run outside sandbox exited 0 normally (26.2s).
- Performance: 400 alternating sentences / 3800 five-character packets: last-100 push median 1.296ms, p95 1.519ms on this computer, excluding React. Full active-stream reparsing remains a bounded-prototype limitation; the legacy mode no longer assembles this history.
- Evidence: `output/caption-blocks-prototype-2026-10-04/` contains full logs, benchmark JSON and inspected Chromium/WebKit screenshots of the synthetic courier replay. No claim that the replay is the original phone event trace.
- Local readiness: API health 200; preview policy 200 with usage ledger/recovery enabled and creation allowed. Read-only OpenAI SDK models.list outside sandbox, existing runtime/.env: HTTP 200 and gpt-live-1 visible. No paid session created.
- Phone verification completed after user unlocked Pixel 7a: local tab 15424 at `http://localhost:5173/?captions=blocks`, correct styled setup, enabled Start, secure microphone context, API policy 200. Cache Storage and registrations cleared only for this origin; cookies/localStorage/IndexedDB preserved. Initial re-registration left the precache empty; forced a fresh worker install via a temporary script query, then restored `/sw.js`. Verified its activated state and SHA256 against dist, plus loaded and precached `index-lsXeUa6j.js` / `index-CXcB9WCT.css`. Inspected actual phone screenshot. Evidence: `output/caption-blocks-prototype-2026-10-04/phone-ready.json` and `phone-ready.png`. OpenAI read-only check repeated: HTTP 200, gpt-live-1 visible; live speech remains for the user.
