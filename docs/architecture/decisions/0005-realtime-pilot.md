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
The browser enables its sender only after checking the effective session,
including translate-only instructions, ASR prompt, empty tools and token ceiling.
Responses use conversation=none, one committed item_reference and correlation
metadata. No history is translated again, and no automatic retry creates a
second response after an uncertain result.

A separate additive SQLite attempt table stores Realtime lifecycle and raw
token usage. It shares admission with Live, identity, origin and creation rate
limits, but never records tokens as Live seconds. Hangup success is recorded
separately from unknown create/close outcomes. Product expiry triggers cleanup;
all unconfirmed dispatched calls retain admission until confirmed hangup,
including unknown calls without an ID. Their registry reservations do not expire.

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
that arbitrary late RTP is retained. First nonzero PCM rendered is an activity
estimate; acoustic playback start and exact RTP attribution remain unknown.
Zero/absent quanta never establish output activity. No samples are filtered.

Unknown calls without a returned ID retain their uncertain record and fail-closed
admission reservation, requiring reconciliation before reuse. The documented
60-minute provider limit does not identify the start of a lost creation, so it is
not used to release a slot. Known-call cleanup retries six times with ten-second
backoff; failed hangup never becomes a confirmed close. Response and ASR usage
are separate idempotent observations with their own models and correlation IDs.
Browser delivery is best effort, with explicit failure status, not verified billing.
Cost is not calculated.

Creation is preceded by bounded preparation with a random admission nonce.
Cleanup never inserts unknown IDs. Expired un-dispatched rows are pruned after
60 seconds; create requires an existing prepared row and its current nonce, so
deleting a cancellation fence cannot reactivate a delayed request. Historical
usage records and dispatched unknown outcomes are retained. Location call IDs
are persisted before awaiting SDP. Shutdown drains creation before abort, within
the server's absolute budget; late callbacks cannot touch a closed database.

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
