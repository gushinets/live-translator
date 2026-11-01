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

When collection resumes within a document, `diagnostic.collection` marks the disabled
interval and the report warns `collection_disabled`. `discardedCount` counts calls
observed by the journal and discarded startup events; observers gated off during the
interval can leave it at zero, which does not mean the timeline is complete. The
boundary contains timestamps and a count only, even when text mode is enabled.

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

Disable with `sessionStorage.removeItem("liveTranslatorDiagnosticText")`. The setting
is checked for each content event, so enabling it after the page becomes idle works
and revoking it stops subsequent text capture. Before replay, queued text is removed
if either the current server policy or tab setting disallows it; event identities and
technical fields are retained.
Scrubbed rows retain only `textRemoved: true`; reports show `textStatus: removed`
and a `text_removed` warning, distinct from text never captured or expired on the server.
Consent provenance is local queue metadata tied to the existing tab identity, including
reloads. Only that tab can replay its text after checking current consent. Other tabs
can send technical-only rows but leave its text-bearing rows queued. If the producing
tab never returns, those rows expire after 24 hours with a loss marker; legacy text
without a recoverable producer also waits for expiry or server-policy scrubbing.
A duplicated/opener tab requires a fresh opt-in when its copied identity is rotated.
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
`liveSessionId` is a client-generated attempt ID. If a create request never reached
the server, authenticated diagnostics retain that provisional ID without creating a
ledger attempt. Reports show `attemptStatus: unconfirmed` and `attempt_unconfirmed`;
search by that ID still finds the conversation. Registration is checked against the
ledger when reporting, so late registration resolves the link. An ID already registered
to another conversation is rejected. A provisional ID does not prove provider contact.

Browser wall time, monotonic time, server receipt time and provider fragment
`startMs`/`endMs` are distinct. The first successful batch records an offset estimate
with half-roundtrip uncertainty. The report estimates cross-stream ordering and
uses monotonic deltas within a stream; it labels an uncalibrated browser clock.
Do not treat provider audio timestamps as wall time or transcript packets as turns.

Pending `transcript.route` events contain newly pending fragment IDs; the resolved
route lists all of its fragments. `transcript.split` links each head/tail to its
parent and the split offset in UTF-16 code units. Split diagnostics use bounded
opaque IDs, independent of the hierarchical IDs used for attribution. Splitting preserves
the parent packet's audio timestamps; it does not infer timing inside the packet.

Search candidates include `lossEvents` and `noOutputTimeouts` (`null` when the
journal is unavailable). Both contribute to the diagnostic error count; losses
also produce an incompleteness warning. A no-output deadline is an observed
application timeout, not proof of a provider fault. `server.attempt` with
`phase: dispatched` confirms that the provider-dispatch gate was committed. It does
not confirm provider-client construction or network transmission.

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
Snapshot `lastPcmQueueStartAt` records a PCM queue activation and `lastPlaybackEdgeAt`
records an accepted playback start/end edge, including audio without a known turn;
neither field measures continuous PCM receipt or playback progress.
Use successive WebRTC decoded-sample/jitter-buffer counters to assess continued delivery.
Server transitions are emitted only after ledger commit, including recovery and
watchdog paths. Diagnostic writes never participate in financial transactions.
Server observations are frozen at commit and queued separately (1000 events / 1 MiB).
The writer yields between events and uses zero SQLite lock wait; ledger calls do not
perform diagnostic SQLite writes inline. Overflow and failed writes produce scoped
loss markers and a rate-limited dropped-event count. If too many distinct streams
overflow simultaneously, sequence gaps and missing-journal warnings remain the
evidence for losses whose marker could not be retained. Graceful shutdown drains
this queue after provider results settle, within the existing shutdown deadline.
Command `cancelled` means a local send/transport waiter was abandoned; `rejected`
requires a correlated provider error. Close send failures and acknowledgement timeouts
are separate events. Any microphone startup failure ends with `capture_failed` and
releases acquired capture/analysis tracks, including a late permission result.

## Delivery, retention and failure checks

The independent IndexedDB database is `live-translator-diagnostics-v1`. Batches
are sent every two seconds, at most 100 events / 32 KiB. An SQL receipt acknowledges
individual `streamId`/`seq` pairs; retries are idempotent and may arrive out of order.
Errors/termination request an earlier flush. Offline retry uses bounded backoff;
page startup reads the policy and resumes stored identities without starting a new
conversation. Retry failures produce a rate-limited, content-free console warning.
Policy is refreshed at most once a minute during delivery. A text-related rejection
refreshes it immediately and retries retained technical fields without the forbidden
content. A Web Lock permits only one tab to flush the shared store at a time. On older
browsers without Web Locks, overlapping uploads remain idempotent at the server.
Disposing the controller removes diagnostic timers and wake listeners, including
when conversation cleanup fails. Final pagehide delivery is best effort.

Client backlog is limited to 5 MiB / 24 hours. IndexedDB failure falls back to bounded
memory. Loss markers identify the affected conversation, attempt and producer stream.
Schema v2 upgrades the same database in place with a transactional byte counter and
expiry index; appending does not read the full backlog. Text revocation uses one
transaction over indexed text rows. These changes do not touch accounting storage.
The server limits journal payload accounting to 1 GiB total / 20 MiB per conversation
and also bounds SQLite page growth. Browser events have an aggregate 20 MiB allowance
per anonymous owner over retained conversations and 20 MiB per network source per
UTC day, independent of cookie rotation. Only a SHA-256 digest of the normalized
network prefix is stored, never the raw IP. Browser events cannot consume the final
10% of total or per-conversation capacity reserved for server observations. A rejected
batch is not ACKed; limits leave an incompleteness marker and do not block the conversation.

Retention is anchored to the server conversation creation time, never retry time:
text 7 days, technical records 30 days. Startup/hourly/shutdown pruning uses secure
delete and WAL checkpoint/truncation. Purge batches are bounded and continue every
second while an expired backlog remains. Expired text is also hidden by the report even
before the next purge. Deleted SQLite space may remain allocated for reuse.
Existing server databases and browser queues continue retention cleanup while
collection is disabled; disabling collection does not extend retention.
Disabled browser collection purges immediately, then performs maintenance at most
once a minute; ordinary two-second wakeups do not acquire a lock or read IndexedDB.
Snapshots exported/copied outside this store are not automatically purged.

The report flags sequence gaps, loss markers, unavailable journals, exhausted storage,
missing completion, expired/truncated text and remaining uncertain source attribution.
If the diagnostics file is missing, unreadable or corrupt, the CLI still searches the
ledger and lists candidates with `journal_unavailable` / `journal_missing` warnings;
error counts are unknown. Ledger and argument errors remain fatal.
A crash can lose the last buffered events. Absence of output is not automatically
classified as a model failure.

Run the diagnostic unit/integration tests and the mocked browser scenario before
enabling collection broadly. Repeat the mobile microphone/decoder acceptance on
the actual phone; synthetic tests cannot establish speaker audibility or calibrate VAD.
No audio sessions are created by the diagnostic tests.
