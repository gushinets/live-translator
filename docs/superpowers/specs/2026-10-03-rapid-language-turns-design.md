# Rapid language turns

Status: implementation authorized by the user on 2026-10-03. Intermediate design/plan approvals were explicitly waived.

## Agreed behavior

- Fixed, distinct participant languages determine source authors and translation recipients. Never alternate speakers by turn order.
- A quick answer from the other participant must become a separate source turn even while the preceding translation is still arriving.
- A pause followed by continuation from the same participant retains its unfinished source turn.
- GPT-Live handles spoken interruptions. Keep model input available during normal interpretation; do not implement playback cancellation, buffering, or resume.
- Late translation must retain its original author's side. When several same-author turns are plausible, show an independently authored translation instead of inventing a source/translation association.
- Short/partial ambiguous text is held separately until sufficient language evidence appears. Preserve text exactly, including spaces and repetition.
- Preserve source/output timestamps. Use source timing to route late input to its original source interval, never packet arrival order alone.
- Suspend, resume, language changes, teardown, metering and recovery must continue to work; do not replay old provider events or persist conversation text in the usage ledger.

## Minimal architecture

Retain the current active source turn and a collection of earlier source turns whose translations are pending. Route output independently using its target language and an explicit turn ID chosen by the router, rather than the current source pointer. Completed history can receive correctly identified late captions without recording a second technical outcome. Ambiguous same-direction output is a translation-only display record, not a successful source turn.

Language routing uses independent instances of the installed `eld` detector, restricted to the fixed language pair, with a bounded streaming buffer and stable word boundaries. The setup detector remains unrestricted. A single partial word must not permanently flip an established author. Pending language evidence cannot be appended to the previous source until resolved. Same-speaker continuation and opposite-speaker handoff use distinct reducer actions.

Normal turn completion is local bookkeeping. Remove per-turn input mute/unmute and repeated fixed-language steering; startup, explicit language changes, suspension and recovery retain their control commands. Model audio activity must not be blindly assigned to whichever person most recently started talking.

## Timing

Implement and verify routing with existing timings first. Then reduce source tail grace from 1000 ms to 250 ms and output settle grace from 350 ms to 200 ms. Retain the 450 ms source quiet hysteresis, 500 ms playback idle, 600 ms caption idle, 1000 ms audio-start grace, 700 ms early-output grace, 5000 ms no-output watchdog and 30000 ms uninterrupted-source watchdog. These remain provisional until real-phone speech testing.

## Acceptance and limits

Cover A→B with 100–300 ms gaps, same-speaker pauses, source arrival during output, late input/output, A→B→A with multiple pending translations, partial words, mixed/borrowed words, unknown language, interrupted audio and provider replacement. Verify both panes' text and relative author labels. Source-only failure must not suppress valid standalone translation captions.

GPT-Live transcript intervals are approximate and have no source-turn correlation ID. Language routing establishes the participant; exact source/translation pairing is only made when unambiguous. This implementation cannot promise word-level alignment or physically identify speakers who speak the same language.

No paid Live session or speech synthesis is necessary for automated verification. Final real-speech verification belongs to the user.

## Provider evidence

The [GPT-Live transcript guide](https://developers.openai.com/api/docs/guides/live-conversations#transcript-deltas) exposes approximate `start_ms`/`end_ms` session intervals, without source-turn correlation IDs. The [model reference](https://developers.openai.com/api/docs/models/gpt-live-1) describes simultaneous listening and speaking. Keep input available and treat quiet/completion as local bookkeeping. Timed late source fragments update their earlier interval; audio without an unambiguous caption target cannot establish a new participant's delivery.
