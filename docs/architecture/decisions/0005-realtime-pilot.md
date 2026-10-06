# Realtime Pilot v1

Status: proposed, 2026-10-06. Implementation: experimental. GPT-Live remains the default.

## Context

Live events, retained snapshots and minute accounting cannot represent Realtime
input items, responses or token usage. This pilot tests ru/en at one microphone
without changing the primary Live path or adding a second ASR session.

## Decision

Realtime has a separate WebRTC client and item/response scheduler. The product
setup and conversation screens share a small capability contract; Live routing,
retained snapshots and provider events keep their existing semantics. Realtime
is loaded only after selection, ends on hidden/pagehide, and cannot resume.

The server chooses gpt-realtime-2.1, gpt-4o-transcribe, marin and server_vad
(0.5 / 300 ms / 700 ms, create_response=false, interrupt_response=false).
The browser enables its sender only after checking the effective session.
Responses use conversation=none, one committed item_reference and correlation
metadata. No history is translated again, and no automatic retry creates a
second response after an uncertain result.

A separate additive SQLite attempt table stores Realtime lifecycle and raw
token usage. It shares admission with Live, identity, origin and creation rate
limits, but never records tokens as Live seconds. Hangup success is recorded
separately from unknown create/close outcomes. Known calls have bounded expiry
and retrying cleanup; unknown calls without a returned ID cannot be hung up.

Remote PCM uses an unfiltered bounded FIFO. Hold stops dequeue, not capture.
Generation completion, provider output-buffer completion and local drain are
separate barriers. A conservative transport-tail interval retains media arriving
after the data-channel buffer-stop event; it is not a sample-exact RTP boundary.
That interval and real transport behavior require opt-in audio verification.

## Alternatives

Rejected: synthesize Live events, replace the Live controller, use an independent
ASR/TTS cascade, or open a second transcription session. A generic provider
framework would exceed the two concrete implementations needed here.

## Consequences

Realtime cannot resume after hidden/reload or change languages during a call.
ELD is a local source-text estimate; short/mixed captions can remain unresolved.
There is no diarization. Serial generation includes any held PCM drain and a
one-second media tail. This bounds attribution but adds latency and cannot prove
that arbitrary late RTP is retained. Local playback timestamps measure render
quanta, including silence, rather than sound at the listener.

Unknown calls without a returned ID retain their uncertain record and bounded
admission reservation. Known-call cleanup retries six times with ten-second
backoff; failed hangup never becomes a confirmed close. Browser-reported usage
is a provider observation, not server-verified billing. Cost is not calculated.

## Implementation and evidence

See the [implementation checklist](../../plans/2026-10-06-realtime-pilot.md) and
[verification and owner checklist](../../experiments/2026-10-06-realtime-pilot.md).
Automatic event/FIFO tests and built UI checks do not establish real voice quality.

Official sources checked before implementation:

- https://developers.openai.com/api/docs/models/gpt-realtime-2.1
- https://developers.openai.com/api/docs/guides/realtime-conversations
- https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create
- https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/hangup
- https://developers.openai.com/api/reference/resources/realtime/client-events
- https://developers.openai.com/api/docs/guides/realtime-transcription

The Calls session schema documents gpt-4o-transcribe input transcription and
its free-text prompt; no single input language is fixed. Its captions follow
committed turns, not a guaranteed live partial transcript before VAD commit.
The newer transcription-only models have different restrictions and are not
substituted. Account access and speech quality are not established by docs.

## Status

Proposed for owner review. No production migration or ADR acceptance is implied.
