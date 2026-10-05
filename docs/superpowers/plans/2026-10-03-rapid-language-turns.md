# Rapid language turns implementation plan

> For agentic workers: execute inline with superpowers:executing-plans. The user authorized autonomous execution without intermediate approvals. A fresh reviewer checks the final change.

**Goal:** Separate fast human replies and preserve correct translation authors without blocking model-managed interruptions.

**Architecture:** Keep source reception independent of pending translation delivery. Classify buffered fragments before append; route late events to explicit records and retain standalone captions when pairing is ambiguous.

**Tech stack:** TypeScript, existing eld, React, Vitest, Playwright. No new dependencies.

**Spec:** ../specs/2026-10-03-rapid-language-turns-design.md

## Global constraints

- Distinct fixed participant languages, no turn-order assignment.
- Model-managed spoken interruptions; input remains open during normal interpretation.
- Retain all source text and translation captions, but never guess an ambiguous author or source association.
- Preserve lifecycle/accounting boundaries and old-event isolation.
- No paid Live sessions; real speech is tested by the user.

## Review focus

- Partial words or borrowed phrases must not switch an established source author.
- Timestamped late source fragments must not open a spurious opposite-speaker turn.
- A→B→A must not attach ambiguous output to the latest A turn.
- Audio during B speech may still belong to A; outcomes and source-duration accounting must not claim B's delivery.
- Suspension, provider replacement and queued language changes must discard pending router state safely.

### Task 1: Source/translation lifecycle separation

Files: conversation/Turn.ts, session/SessionState.ts, session/sessionReducer.ts, session/SessionController.ts and their tests; screens/ConversationScreen.tsx and tests.

Interfaces: `pendingTurns?: Turn[]` holds earlier source turns; targeted output/completion actions accept an optional `turnId` while legacy active-turn actions retain compatibility.

- [x] Add tests for two concurrent source/translation records and late targeted captions; observe RED.
- [x] Implement pending records and targeted updates; preserve chronological history and suspend cleanup.
- [x] Keep normal model input open and remove per-turn steering/control delays.
- [x] Verify controller, reducer, lifecycle and metering tests; document changed obsolete transport expectations.

### Task 2: Streaming language routing

Files: conversation/TranscriptRouter.ts and tests, session/SessionController.ts, components/ParticipantPane.tsx and screens/ConversationScreen.test.tsx.

Interfaces: a session-scoped router buffers input/output separately, emits exact text fragments with a confirmed side, retains original intervals, and resets at provider/lifecycle boundaries.

- [x] Add rapid A→B, same-speaker continuation, partial/ambiguous language and delayed timestamp tests; observe RED.
- [x] Route before append, hand off source records explicitly, choose unique output targets by fixed direction.
- [x] Preserve ambiguous same-author translations as separate records and show pending records in both panes.
- [x] Verify ownership, interruption, delayed-caption and lifecycle regressions.

### Task 3: Timing and final validation

Files: config/runtime.ts, audio/VoiceActivityMonitor.test.ts, conversation/TurnCompletion.test.ts, targeted controller tests and device acceptance notes.

- [x] Add behavioral timing checks at provisional source grace 250 ms and output settle 200 ms; observe RED.
- [x] Change only those two values and verify all regressions.
- [x] Run complete workspace tests, types, lint, production build and browser regressions where available.
- [x] Obtain a fresh defect-first review and fix actionable findings with regression tests.
- [x] Deliver the verified implementation and a short real-phone conversation checklist.
