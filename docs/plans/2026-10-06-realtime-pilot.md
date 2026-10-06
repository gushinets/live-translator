# Realtime Pilot implementation checklist

Base: origin/main eaadb528; local Live fixes through d1687112 retained.
Branch: codex/realtime-pilot. Existing untracked files are excluded.

- [x] Inspect instructions, baseline and official GA API/installed SDK.
- [x] Server flag, identity, shared admission, durable attempts and hangup.
- [x] WebRTC startup configuration barrier and cancellation fences.
- [x] Explicit input/response correlation and serialized scheduler.
- [x] Unfiltered bounded PCM hold/resume and independent drain.
- [x] Product engine selection, capabilities, diagnostics and lifecycle.
- [x] Unit/mocked browser checks and Live regression.
- [x] Full diff self-review, fixes, build and desktop launch verification.
- [x] Manual checklist and opt-in smoke command.
- [x] PR handoff package prepared.

Publication and last-HEAD CI are checked after these local implementation steps;
their final status is recorded in the PR/checks, not inferred from this checklist.

Initial baseline: 1829 passed / 26 failed in sandbox because API defaults found
an existing readonly database outside workspace. Isolated baseline with a local
unused USAGE_DB_PATH: 1855 passed / 63 files. No code change was required to fix
that environment. Reviewed implementation: 1893 passed / 69 files.

Provider voice smoke and physical phone: not run. Read-only models.list returned
HTTP 200 with Live, Realtime and transcription candidates visible. This is not
a voice connection test. Details: [experiment report](../experiments/2026-10-06-realtime-pilot.md).

PR #36 revision, 2026-10-07: 13 initial inline review threads inspected.
Location-before-SDP cleanup, fail-closed shared reservations, honest PCM activity,
separate ASR usage, semantic startup barrier, bounded preparation/usage, drain
budget, Compose settings and production source SHA fixed with real-class tests.
Revision baseline: 1893/69 passed. Current results and remaining physical/API
limits are recorded in the experiment report; last-HEAD CI is checked on GitHub.
