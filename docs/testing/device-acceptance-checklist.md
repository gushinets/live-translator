# Device acceptance checklist (Task 15)

**Date:** 2026-09-14  
**HEAD at dispatch:** `5674a69` `test: cover translator runtime with deterministic e2e flows`  
**Binding spec:** `docs/superpowers/specs/2026-09-13-live-translator-mvp-design.md` Revision 1.2.2 §25 / §27

## Gate status

**OPEN — real-device / GPT-Live acceptance has not been run.**

This agent environment has **no iPhone or Android hardware** and **no `OPENAI_API_KEY` for a real Live session**. Desktop Chromium + mocked Playwright is not a substitute for §27 (spec: “Desktop emulation is not sufficient for audio acceptance”).

Every device/scenario cell below is **NOT RUN**. Cells are **not** PASS, FAIL, or measured results. Do **not** claim MVP acceptance from this document.

Replace `NOT RUN` only with observations from a human session on real hardware with a live OpenAI key. Do not invent measurements.

## Local device access

Desktop development and automated tests use the local Vite/API endpoints directly and require no VPN or tunnel.

For a physical phone, use an HTTPS endpoint under the developer's control that forwards to the local preview/API or to a deployed test environment. Keep `OPENAI_API_KEY` server-side and never place it in the browser bundle. If the endpoint is reachable outside a trusted local network, protect it with an access gate such as server-side Basic Auth or an identity-aware proxy. `Origin` validation is a CSRF/browser signal, not user authentication.

Audio constants in `apps/web/src/config/runtime.ts` and `apps/web/src/audio/VoiceActivityEstimator.ts` were **not** changed. There is no device evidence to justify tuning.

## Environment (this run)

| Item | Value |
| --- | --- |
| iPhone hardware | none |
| Android hardware | none |
| Live `OPENAI_API_KEY` | unset / not used (name only; no secret recorded) |
| GPT-Live session | not attempted |
| Desktop Chromium e2e | automated mocked suite only (see report); not device acceptance |

## Requested microphone constraints (code, not measured)

Capture requests these constraints (binding spec §0 / AudioController). Actual `MediaStreamTrack.getSettings()` per device were **not** observed.

```ts
{
  audio: {
    echoCancellation: true,
    noiseSuppression: false,
  },
}
```

`autoGainControl` is left to the browser (spec §0 item 5). Log actual settings without recording speech content.

## Device form-factor matrix (spec §27)

| Device | Model | Browser mode | Connect | Mic grant | Remote audio | `session.closed` | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| iPhone | not available | Safari tab | NOT RUN | NOT RUN | NOT RUN | NOT RUN | No iPhone hardware / no live key in this agent environment. |
| iPhone | not available | Home Screen PWA | NOT RUN | NOT RUN | NOT RUN | NOT RUN | No iPhone hardware / no live key in this agent environment. |
| Android | not available | Chrome tab | NOT RUN | NOT RUN | NOT RUN | NOT RUN | No Android hardware / no live key in this agent environment. |
| Android | not available | Installed PWA | NOT RUN | NOT RUN | NOT RUN | NOT RUN | No Android hardware / no live key in this agent environment. |

## Microphone settings (Task 15 Step 2)

Record `echoCancellation`, `noiseSuppression`, `autoGainControl`, `channelCount`, `sampleRate` from the live track. No speech content.

| Device / mode | echoCancellation | noiseSuppression | autoGainControl | channelCount | sampleRate | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| iPhone Safari | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | No iPhone hardware / no live key in this agent environment. |
| iPhone Home Screen PWA | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | No iPhone hardware / no live key in this agent environment. |
| Android Chrome | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | No Android hardware / no live key in this agent environment. |
| Android installed PWA | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | No Android hardware / no live key in this agent environment. |

## Scenario matrix (brief minimum × form factors)

Result key: **NOT RUN** — no hardware / no live key in this agent environment. No PASS/FAIL/ms values.

| Scenario | iPhone Safari | iPhone Home Screen PWA | Android Chrome | Android installed PWA |
| --- | --- | --- | --- | --- |
| Quiet room | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Noisy doorway/street | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| High-volume TTS | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Phone held upright | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Phone placed between people | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| iPhone ringer on | NOT RUN | NOT RUN | n/a (iPhone-only) | n/a (iPhone-only) |
| iPhone silent switch / silent mode | NOT RUN | NOT RUN | n/a (iPhone-only) | n/a (iPhone-only) |
| Multiple media volumes | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Far-talker B | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Orientation change (landscape → suspend) | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Background / foreground | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Network loss | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| One participant speaks twice (automatic language routing) | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Text-only output | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| 5–10 minute conversation | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| 10-turn courier conversation (Step 5) | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

## P0 audio tests (Task 15 Step 3)

Pass criteria from the task brief. **Not executed** on device.

| Criterion | iPhone Safari | iPhone Home Screen PWA | Android Chrome | Android installed PWA |
| --- | --- | --- | --- | --- |
| No systematic source-tail clipping during early GPT output | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| GPT TTS does not create a sustained self-translation loop | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Text-only completion returns to listening | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| No-output watchdog never deadlocks | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Far-talker B intelligible enough with `noiseSuppression: false` | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Bad TTS route still leaves usable large text | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

## Spec §25 acceptance (all form factors unless noted)

Each row is a live-device criterion. Result is **NOT RUN** (no hardware / no live key in this agent environment).

| § | Criterion | Result |
| --- | --- | --- |
| 25.1 | Primary courier with context: 10 turns, no manual session recreation | NOT RUN |
| 25.2 | No-context start: bootstrap on owner screen, not translated as a turn | NOT RUN |
| 25.3 | Code switching without language-settings UI | NOT RUN |
| 25.4 | Long/thinking pauses: no mic cut on early GPT output; tails not lost | NOT RUN |
| 25.5 | Early model output: no immediate mute; no systematic tail clipping | NOT RUN |
| 25.6 | Self-playback / echo: ≥10 high-volume TTS turns, no VAM/self-loop | NOT RUN |
| 25.7 | Text-only / no-audio completion after caption idle + audio-start grace | NOT RUN |
| 25.8 | No-output watchdog: retry/LISTENING or error; same speaker; no hang | NOT RUN |
| 25.9 | Critical values: ask to repeat rather than invent | NOT RUN |
| 25.10 | Same speaker twice: language routing; no stale queued output | NOT RUN |
| 25.11 | Same-language utterance: deterministic interpreter behavior acceptable | NOT RUN |
| 25.12 | Overlapping humans: no client diarization promise; ask to repeat if needed | NOT RUN |
| 25.13 | Speech during established output: not accepted as a translated turn | NOT RUN |
| 25.14 | Audio routing degraded: large text still usable | NOT RUN |
| 25.15 | Orientation: landscape → SUSPENDED; recovery after portrait | NOT RUN |
| 25.16 | Background/interruption: no invisible turns; validate before resume | NOT RUN |
| 25.17 | Network loss: leave listening; show recovery/error | NOT RUN |
| 25.18 | Cleanup: End + reload; no stored transcript; graceful close attempted | NOT RUN |
| 25.19 | Continuous ambient noise: adaptive VAM; MAX_SOURCE_MS retry, same side | NOT RUN |
| 25.20 | Abandoned context/bootstrap: idle timeout closes session | NOT RUN |

## Spec §27 cross-cutting (both platforms)

| Item | iPhone | Android | Notes |
| --- | --- | --- | --- |
| Speaker / earpiece routing | NOT RUN | NOT RUN | No hardware / no live key in this agent environment. |
| Autoplay after connection | NOT RUN | NOT RUN | No hardware / no live key in this agent environment. |
| Microphone loss and recovery | NOT RUN | NOT RUN | No hardware / no live key in this agent environment. |
| Browser/OS voice-processing mode | NOT RUN | NOT RUN | No hardware / no live key in this agent environment. |
| Requested vs resulting AEC/NS/AGC/channels/rate | NOT RUN | NOT RUN | See microphone-settings table. |
| Far-talker with `noiseSuppression: false` | NOT RUN | NOT RUN | No hardware / no live key in this agent environment. |
| High-volume local TTS bleed into mic/VAM | NOT RUN | NOT RUN | No hardware / no live key in this agent environment. |

## 10-turn courier (Task 15 Step 5)

Do not claim MVP acceptance until both iPhone and Android complete the conversation **without manual session recreation**.

| Platform | Form factor | PASS/FAIL | Failure reason |
| --- | --- | --- | --- |
| iPhone | Safari | NOT RUN | No iPhone hardware / no live key in this agent environment. |
| iPhone | Home Screen PWA | NOT RUN | No iPhone hardware / no live key in this agent environment. |
| Android | Chrome | NOT RUN | No Android hardware / no live key in this agent environment. |
| Android | Installed PWA | NOT RUN | No Android hardware / no live key in this agent environment. |

## Audio constant tuning (Task 15 Step 4)

**None.** Allowed knobs (VAM multipliers, quiet hold, `PLAYBACK_IDLE_MS`, `CAPTION_IDLE_MS`, `AUDIO_START_GRACE_MS`, `POST_SOURCE_OUTPUT_GRACE_MS`, `OUTPUT_SETTLE_GRACE_MS`, `NO_OUTPUT_TIMEOUT_MS`) stay at spec 1.2.2 / current source defaults. Tuning without recorded device failures is out of scope for this run.

## Automated suite (this environment, not device acceptance)

Recorded 2026-09-14 in the agent environment. Desktop mocked Playwright is not §27 audio acceptance.

| Command | Exit |
| --- | --- |
| `pnpm lint` | 0 (after lint blockers below; first run was 1) |
| `pnpm typecheck` | 0 |
| `pnpm test` | 0 (25 files, 385 tests) |
| `pnpm build` | 0 |
| `pnpm --filter @live-translator/web exec playwright test` | 0 (9 passed) |

First `pnpm lint` failed on pre-existing `no-unsafe-finally` in `SessionController.closeCompletedTurn` and unused mock parameters / `prefer-const` in tests. Those were fixed so the suite could exit 0. `runtime.ts` and `VoiceActivityEstimator.ts` were not changed.

## Device-gated Definition of Done (spec §29 / plan final verification)

Automated unit/e2e coverage does **not** close these. All remain **NOT RUN** on real hardware.

- Real GPT-Live on iPhone Safari and Home Screen PWA
- Real GPT-Live on Android Chrome and installed PWA
- Context phase produces no audible GPT output
- Bootstrap answer is not translated as a conversation turn
- First interpreter instruction and first steering acknowledged before listening
- Early GPT output never automatically mutes continuing human speech
- High-volume local TTS does not repeatedly hold VAM / self-translate
- Text-only output can close a turn without audible TTS
- No-output branch fails/retries instead of hanging
- `MAX_SOURCE_MS` enters explicit repeat/recovery
- Landscape/background/audio interruption enters `SUSPENDED` and discards unfinished turns (device, not desktop Playwright)
- Abandoned context/bootstrap sessions close on idle timeout (live session)
- Session reaches `session.closed` before normal WebRTC teardown (live)
- 15-minute client cap triggers graceful close (live)
- Two real people can complete a 5–10 minute conversation on both platforms

## Human follow-up

1. Set a live `OPENAI_API_KEY` on a protected prototype host (never commit the value).
2. Run every form-factor row on current iPhone and Pixel/Samsung-class Android.
3. Fill microphone settings from `getSettings()` (no speech content).
4. Run P0 audio tests first; record failures with enough detail to justify constant changes.
5. Complete the 10-turn courier on both platforms without recreating the session.
6. Keep this gate **OPEN** until those rows are evidence, not inference.

**MVP acceptance: not claimed.**

## Rapid language turns — 2026-10-03

Implementation checks (2026-10-04): 1222 workspace tests in 58 files pass; API/web type checks and lint pass; web production build passes. The complete Chromium/WebKit suite passes 72 cases, with 3 existing skips for mismatched device browser descriptors. GPT-Live and audio are mocked; these checks do not exercise real speech or model latency. All 10 actionable findings from the fresh review have regression coverage and fixes.

New local defaults: 450 ms quiet hysteresis plus 250 ms source-tail grace (about 700 ms, sampled every 50 ms); 200 ms output-settle grace. Source end never closes normal model input. Startup, explicit language replacement, pause and recovery retain their control commands. Timing remains provisional until phone testing.

| Real-phone scenario | Expected behavior | Result |
| --- | --- | --- |
| A asks, B replies after 100–300 ms | Distinct source records, fixed-language authors; A's later translation stays authored by A | NOT RUN |
| A pauses and continues while translation is pending | Same unfinished source record; no repeated control-command delay | NOT RUN |
| B interrupts model speech | Model stops and listens; B's source is accepted; interrupted A audio is not counted as B's delivery | NOT RUN |
| A → B → A before translations finish | Preserve each source; ambiguous same-author output stays an independently authored translation | NOT RUN |
| Short reply, partial word, numbers or borrowed word | Wait for language evidence; preserve content, avoid guessing an author | NOT RUN |
| Hide/rotate, then resume | Discard unfinished source/buffer state; preserve earlier history and the selected pair; no old-event replay | NOT RUN |
| Queue a partner-language change while earlier output or partial text remains pending | Keep accepting speech under the current pair; preserve undecidable text before replacement; apply the new pair at a safe boundary | NOT RUN |

For the final Android check, use the current production build in Vite preview at `http://localhost:5173` via USB reverse, following `AGENTS.md`. Do not use the development transport spike. At the time of this rapid-language-turns check, real-phone UI/API verification and these individual speech scenarios remained pending.

Local smoke check after integration and dependency restoration (2026-10-04): primary production build passes; the restarted preview at port 5173 serves `/assets/index-YWAsGe2U.js`. API health is `ok`, startup log shows the listening server with an empty stderr log, and `/api/policy` returns HTTP 200. A clean desktop Chrome session at a 390×844 viewport shows `.setup-screen` with applied dark styling; secure context and microphone API are available, and proxy policy returns 200. Its fresh screenshot is saved under `output/rapid-language-turns-2026-10-04/production-setup-repaired.png`. A read-only SDK `models.list()` request with the API's Node runtime, `.env` and proxy configuration returns HTTP 200 and includes `gpt-live-1`; no paid session was opened.

Archiving the managed worktree affected the shared dependency directories through junctions. Dependencies were restored from the local cache with `pnpm install --force --offline --frozen-lockfile`; the lockfile is unchanged. Fresh type checks, lint, production compilation and all 1222 workspace tests pass. The primary drive's existing default `D:\data\live-translator.sqlite` activates retained-ledger protection in legacy API tests; the test rerun used a separate unused `USAGE_DB_PATH`, without altering the running API's `.env`, ledger or recovery flags. A WebKit metadata-delivery test timed out in the first browser rerun, then passed alone and in the complete suite with four workers: 72 pass, 3 existing skips. Both local services were restarted and verified after restoration; policy confirms ledger and background recovery remain enabled. Fresh logs are retained alongside the earlier evidence.

`adb devices -l` found no connected device for this rapid-language-turns check. Actual phone assets, service-worker cache, microphone capture, audible delivery and speech interruptions were not verified in that check. The restored primary API and preview remain running for the final user test. Automated logs are saved under `output/rapid-language-turns-2026-10-04/`.

Later verification (2026-10-04): the separate [caption-blocks phone check](../superpowers/plans/2026-10-04-caption-blocks-prototype.md) verified the Pixel 7a UI, secure microphone context, API policy, activated worker and precached assets. The user subsequently reported successful speech testing of that caption mode and approved making it the default. This does not mark each individual rapid-turn/interruption scenario in the table above as run. The final [default-mode checks](../superpowers/plans/2026-10-04-default-dialogue-captions.md) were automated; the open phone conversation was not reloaded.
