# Non-interrupting audio implementation plan

> Execution: superpowers:executing-plans, inline implementation; one independent branch review before delivery.

**Goal:** Keep streaming playback as the default and add a live “Не перебивать” switch preserving received audio while a person speaks.
**Architecture:** AudioWorklet receives the remote WebRTC audio, passes it through by default, or queues PCM while local source activity is detected. Its output feeds the existing HTML audio element through a MediaStreamDestination, preserving browser playback priming and lifecycle handling. Captions remain untouched.
**Tech stack:** existing TypeScript, React, Web Audio, Vitest, Playwright; no new dependencies.
**Spec:** approved conversation in this chat (2026-10-05), summarized below.

## Approved behavior / constraints
- Two modes, default streaming for each new conversation.
- “Не перебивать” switch immediately right of End, compact single-row controls on narrow screens, accessible keyboard/touch state.
- Captions stream immediately in both modes.
- Pausing retains unplayed PCM. Switching off drains FIFO immediately; never discard/repeat audio on mode switches.
- Existing source estimator has 450 ms quiet hysteresis; add 300 ms quiet hold before playback (roughly 750–850 ms total).
- Clear PCM on lifecycle gate closure, stream replacement, end and dispose; no audio persistence.
- Worktree based on main 298b0ad, independent of PR #32. No merge, push or new PR until requested.
- No automatic paid model sessions. Hardware testing remains with user.
- Keep usage/recovery settings and other agent's checkout intact.

## Review focus
1. Toggle during a partially consumed block: no duplication or lost suffix.
2. Long silence: avoid permanent growing delay; preserve quiet phonemes with preroll/tail.
3. Output gate closure / stale messages / reconnect: no delayed audio leaks.
4. Completion and VAD must observe played audio, not generated-but-queued audio.
5. Worklet failure or finite buffer overflow: fail closed visibly, never silently discard while claiming success.

## Tasks
- [x] 1. Pure PCM queue and processor. Files: audio/PlaybackQueue.ts, audio/BufferedPlaybackProcessor.ts, corresponding tests. Verify FIFO, silence trimming, 300 ms hold, toggle, clear and overflow (120 seconds max). Red/green Vitest.
- [x] 2. AudioController integration. Prepare worklet on output priming; attach remote through processed MediaStream; retain existing HTML element gates; use processed analyser for VAD feedback/activity; queue pending blocks turn completion. Verify lifecycle isolation and failure tests.
- [x] 3. Session switch and UI. Files: session/SessionController.ts, screens/ConversationScreen.tsx/.css, i18n/messages.ts and tests. Keep default false, notify subscribers, disable during suspension/ending; reset on new conversation. Validate keyboard and narrow-screen layout.
- [x] 4. Build, unit/type/lint tests and real browser PCM path test with generated audio (no OpenAI calls). Independent branch review, fix findings, commit on isolated branch; preserve for user test.

## Evidence / rulings
- OpenAI guidance explicitly recommends buffering audio in the player while continuing audio/transcript reception: https://developers.openai.com/api/docs/guides/voice-server-controls?api=live#check-speech-before-playback
- Provider may stop generating when interrupted; local buffer can preserve only received PCM.
- Baseline check log: .data/audio-baseline.log.

- Final review: independent reviewer found one lifecycle regression (queued output hid incoming audio while muted). Fixed with separate raw/played analysers and both wiring and RMS behavioral tests; reviewer rechecked with no findings.
- All 58 unit/integration files passed (1199 tests); final rerun recorded in .data/all-tests-final.log.
- Chromium real AudioContext/AudioWorklet tests: FIFO hold/release/pause/toggle, lifecycle discard, keyboard switch and 320px/390px layout. See .data/audio-browser-final.log.
- Existing browser startup, mobile layout, captions and suspension: 21 passed, 3 existing skips, Chromium + WebKit. See .data/feature-e2e.log.
- Windows WebKit in this installation has no AudioContext. Actual audio tests explicitly skip there. Safari/iOS audio and real-phone echo cancellation remain unverified.
- Typecheck, ESLint and production build passed. Vite emits a separate hashed worklet asset and includes it in PWA precache.
- Pixel 7a was subsequently connected by the user. Isolated production preview runs on host port 5185 (PID 6268); USB reverse maps phone localhost:5173 to host 5185. Existing API on 3001 and preview on 5173 were left running unchanged.
- Actual phone: visible localhost:5173 tab loaded index-DP76Yk0H.js and index-alv3DjTL.css from this build; secure context, microphone API and AudioWorkletNode available, /api/policy returned 200. Screenshot confirms the conversation screen with the new switch (off); user had already moved beyond setup during verification, so the final setup-screen check was not performed on that active tab. Evidence: .data/phone-readiness.json and .data/phone-setup-verified.png.
- API /health returned status ok, startup log had no error, and read-only models.list with the running API runtime/SDK/.env returned HTTP 200 with gpt-live-1 visible. The agent did not start a paid model session. Real speech testing remains with the user.
- Only the local app origin Service Worker/Cache Storage was cleared and its tab reloaded before the user began the conversation. Language preferences and recovery storage were preserved. No main-checkout files, running API/preview servers or PR #32 branch were modified.

## User test / later integration
Keep this worktree and branch. Do not create a PR yet.
After a phone is attached, serve this worktree's production build on a separate preview port (e.g. 5185).
Keep phone origin http://localhost:5173; USB reverse may map phone tcp:5173 to host tcp:5185.
The existing compatible API on 3001 can serve this preview through its /api proxy; inspect its health and environment before use.
Follow AGENTS.md readiness/cache checks. Test a long utterance with breaths, continued speech during playback,
both language directions, repeated mode toggles, and background/return.
After PR #32 is merged, update this branch from main, resolve SessionController/test conflicts, rerun unit and browser tests,
then repeat the phone test before opening the new PR.


## Phone follow-up: WebRTC decoder activation
- User reported complete silence in both modes. On the actual phone, the output element was playing/unmuted, AudioContext was running, and RTP packets arrived, but totalSamplesReceived and jitterBufferEmittedCount stayed zero.
- A temporary muted audio element attached to the original receiver track immediately started decoding (91,200 samples after 1.5 seconds); the user confirmed sound returned. The active conversation was not reloaded or ended.
- Permanent fix keeps a separate always-muted, zero-volume element playing the original WebRTC stream while the existing audible element plays processed PCM. The decoder is released on stream replacement/disposal and remains active during Gate C closure for leftover-audio analysis.
- Added a real RTCPeerConnection loopback regression: before the fix its processed output RMS remained zero; after the fix decoding, default streaming, buffering and release pass. Previous oscillator-only tests did not exercise Chromium's remote receiver decoder activation.
- Verification: 1200 tests in 58 files passed, all 4 Chromium audio/browser tests passed, TypeScript, ESLint and production build passed. Logs: .data/decoder-all-tests.log, .data/webrtc-decoder-red.log, .data/webrtc-decoder-green.log, .data/decoder-types.log, .data/decoder-lint.log, .data/decoder-build.log.
- Production preview now serves index-CQ0tDTMC.js. The current phone conversation still uses the temporary live diagnostic fix; reload after ending the conversation to load the permanent fix. The user was still listening with non-interrupting mode enabled at the final check, so no reload was forced.


## Integration after PR #32 merge
- User requested synchronization after PR #32 merged. Fetched origin/main at 4fe888d3b03f0d515dd7f21ed47f165e4c0fd163 and merged into codex/non-interrupting-audio without rebasing its feature commits.
- Resolved two conflicts: UI snapshot now tracks both independent captions/recovery and playback mode; completion keeps PR32 multi-turn routing and waits while received PCM remains queued.
- Added an integration test preserving both routed turns and immediate independent captions until buffered audio drains. Updated the UI fixture and real-audio harness for PR32's captionBlocks contract.
- Verification: 1398 tests across 61 files passed; 57 existing browser scenarios passed with 3 platform skips, plus 4 Chromium real audio/WebRTC tests. Typecheck, lint and production build passed. Logs: .data/pr32-merge-unit-final.log, .data/pr32-merge-browser.log, .data/pr32-merge-audio.log.
- Actual Pixel 7a: visible setup-screen with dark CSS, secure context, microphone API and AudioWorklet available, /api/policy HTTP 200. Loaded index-DwYza0XD.js and index-DZp80mOV.css, matching the merged build. Screenshot/readiness: .data/pr32-merge-phone.png and .data/pr32-merge-phone.json.
- Existing API health is ok and read-only OpenAI models.list returned 200 with gpt-live-1 visible. Preview remains isolated on host 5185, phone USB reverse 5173 -> 5185. No paid session started; real speech testing remains with the user.
- Kept local branch/worktree; no push or new PR yet.


## PR #33 review corrections
- Wired `test:audio` into the Chromium CI job, including failure artifacts.
- Added `AudioController.playOutput()` and used it in both remote-stream startup and the browser harness. The original decoder must resolve before processed playback is ready; a retired decoder cannot start a replacement stream.
- Added `detachRemoteStream()` to retire the decoder, worklet/destination, cloned remote track and analysers. Session terminal/retirement paths invoke it; temporary orientation suspension preserves media for draining. The primed AudioContext can be reused without playing the previous conversation's stream.
- Stream replacement/terminal detachment sends an explicit worklet dispose message and closes the main-thread port. The processor clears its queue, closes its port, and returns false, including without inputs/outputs. Ordinary silence, clear and temporary muting keep it alive.
- Regression RED: eight failures confirmed the review issues. The targeted GREEN run passed 280 tests, including processor lifetime, decoder refusal, pending startup retirement and End/Cancel cleanup.
- Full unit/integration run: 1410 tests across 62 files passed. Typecheck, lint and production build passed. The four real Chromium audio/WebRTC scenarios pass using the same startup method as production. Logs: .data/pr33-review-red.log, .data/pr33-review-green.log, .data/pr33-review-all-unit.log, .data/pr33-review-audio.log, .data/pr33-review-e2e.log.
