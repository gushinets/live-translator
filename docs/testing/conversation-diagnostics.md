# Conversation diagnostics

The journal records observed processing stages. It does not prove semantic translation
quality, physical audibility, or that an unobserved provider event never occurred.
There is no public journal reader or new user interface.

## Enable and inspect

Build/deploy matching API and web artifacts. Set `USAGE_LEDGER_ENABLED=true` and
`CONVERSATION_DIAGNOSTICS_ENABLED=true`. `/api/policy` advertises
`diagnostics: {enabled:true,textEnabled:false,schemaVersion:1}`. A client receiving
an older policy without this field disables diagnostics. A diagnostic database
startup failure disables collection, logs a bounded error and leaves calls available.

The database is `/diagnostics/events.sqlite` in the separate `diagnostics-data`
Compose volume. Local runs use `DIAGNOSTICS_DB_PATH=./.data/diagnostics/events.sqlite`
from `.env.example` (relative to the API working directory, like `USAGE_DB_PATH`).
Do not include this volume in financial-ledger backups. Ledger backup commands
still back up only `/data/live-translator.sqlite`.

From the existing operator shell, find calls overlapping an incident window:

```sh
docker compose -f infra/docker-compose.yml exec -T api \
  node scripts/diagnostics-report.mjs \
  --from 2026-10-31T10:00:00+07:00 --to 2026-10-31T10:20:00+07:00
```

Inspect a candidate (the format defaults to `text`):

```sh
docker compose -f infra/docker-compose.yml exec -T api \
  node scripts/diagnostics-report.mjs --conversation-id UUID --format jsonl
```

Other filters: `--live-session-id UUID`, `--owner sha256:OWNER_HASH`, `--from ISO_TIMESTAMP`,
`--to ISO_TIMESTAMP`. Timestamps must contain `Z` or an explicit offset. Database
overrides: `--db PATH`, `--ledger-db PATH`. With no filter the search covers the
last 24 hours; at most 1000 candidates are shown, with a truncation warning.
Conversation/attempt selection exports the whole conversation so earlier gates,
commands and decisions remain available around the requested window. Both databases
are opened read-only; no lifecycle changes, migrations or paid calls are made.

Candidates include a stable anonymous owner hash, start/end/duration, languages, client builds,
connection count, errors and text availability. There is no mapping from a person's
name to their anonymous cookie. Without a conversation ID the operator may need to
disambiguate multiple candidates using the reported time and language pair. The raw
anonymous ID doubles as the authentication cookie, so the journal/export stores only
its SHA-256 digest; use the `owner` digest from a candidate to find related calls.

## Text mode for a developer's test

Enable `CONVERSATION_DIAGNOSTICS_TEXT_ENABLED=true` on the test API. In the local
app tab's developer console, **before starting a new conversation**:

```js
sessionStorage.setItem("liveTranslatorDiagnosticText", "1");
```

Disable for subsequent tests with `sessionStorage.removeItem("liveTranslatorDiagnosticText")`.
This is a per-tab opt-in, not an administrator authentication mechanism. Both the
server flag and tab setting are required. Leave the server text flag off on ordinary
production deployments. This setting is independent of Vite's transport spike:
test the built product with preview, as described in `AGENTS.md`.

Only interpreter input/output fragments and caption text may carry content. Context
capture, bootstrap content, instruction bodies, arbitrary provider error messages,
SDP, keys, cookie values, device labels/IDs and audio samples are excluded. Technical
records contain only validated, event-specific fields. Text is removed before a
technical-mode event enters the queue. A text field above 4096 characters is marked
truncated; original character counts remain available. Exports may contain test
text and are operator-owned files with their own retention responsibility.

## Reading the timeline

`conversationId` groups a product conversation; `liveSessionId` identifies one
provider attempt. `streamId`/`seq` order one producer. New connections get new
streams, including replacement and resume. Startup events are buffered until their
server identity is known (200 events / 64 KiB maximum). Startup that never creates
a conversation cannot be found through a conversation ID.

Browser wall time, monotonic time, server receipt time and provider fragment
`startMs`/`endMs` are distinct. The first successful batch records an offset estimate
with half-roundtrip uncertainty. The report estimates cross-stream ordering and
uses monotonic deltas within a stream; it labels an uncalibrated browser clock.
Do not treat provider audio timestamps as wall time or transcript packets as turns.

Look for the last confirmed stage:

1. `audio.level`, raw/reported `audio.vad`, `capture_gate`, `playback_input`.
2. `transport.stats`: audio packets sent/received versus decoded sample counts.
   Missing browser statistics are `null`, not zero.
3. `transport.event` receipts/drops, `transcript.fragment`, `transcript.route`.
4. `attribution.decision`: candidates, chosen source, revisions/revocations/deadline.
5. PCM pending, playback permission, playback activity and decoder/context state.
6. `caption.block` revision/side and `caption.render` after React's layout commit.

Caption routing is observed separately from technical source attribution. Matching
a translation to a source never proves that PCM belonged to that source.

`turn.wait` stores changed completion predicates/deadlines, rather than every poll.
Snapshots and WebRTC counters are sampled every five seconds while connected;
microphone levels are summarized once a second using the existing analyser.
Server transitions are emitted only after ledger commit, including recovery and
watchdog paths. Diagnostic writes never participate in financial transactions.

## Delivery, retention and failure checks

The independent IndexedDB database is `live-translator-diagnostics-v1`. Batches
are sent every two seconds, at most 100 events / 32 KiB. An SQL receipt acknowledges
individual `streamId`/`seq` pairs; retries are idempotent and may arrive out of order.
Errors/termination request an earlier flush. Offline retry uses bounded backoff;
reload resumes the same stored identities. Final pagehide delivery is best effort.

Client backlog is limited to 5 MiB / 24 hours. IndexedDB failure falls back to bounded
memory. The server limits journal payload accounting to 1 GiB total / 20 MiB per
conversation and also bounds SQLite page growth. A rejected batch is not ACKed;
limits leave an incompleteness marker and do not block the conversation.

Retention is anchored to the server conversation creation time, never retry time:
text 7 days, technical records 30 days. Startup/hourly/shutdown pruning uses secure
delete and WAL checkpoint/truncation. Purge batches are bounded and continue every
second while an expired backlog remains. Expired text is also hidden by the report even
before the next purge. Deleted SQLite space may remain allocated for reuse.
Snapshots exported/copied outside this store are not automatically purged.

The report flags sequence gaps, loss markers, unavailable journals, exhausted storage,
missing completion, expired/truncated text and remaining uncertain source attribution.
A crash can lose the last buffered events. Absence of output is not automatically
classified as a model failure.

Run the diagnostic unit/integration tests and the mocked browser scenario before
enabling collection broadly. Repeat the mobile microphone/decoder acceptance on
the actual phone; synthetic tests cannot establish speaker audibility or calibrate VAD.
No audio sessions are created by the diagnostic tests.
