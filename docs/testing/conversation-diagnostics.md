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
Retired transports do not observe later policy transitions; genuinely late data
still keeps its original stream and attempt identity.
If late data was discarded while collection was disabled, re-enabling collection
flushes that pending gap even when no further event arrives on the retired stream.
Historical loss records are written directly to the bounded outbox without a
current-document policy observer; later policy changes do not create gaps for them.

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
sessionStorage.setItem("liveTranslatorDiagnosticText", crypto.randomUUID());
```

Disable with `sessionStorage.removeItem("liveTranslatorDiagnosticText")`. The setting
must be a **fresh UUID for every enable**, including re-enabling after a revoke;
do not restore an earlier value. The former value `"1"` no longer enables text:
run the command above again after upgrading. The UUID is local consent metadata,
never part of uploaded events. Each content event and queued row retains the UUID
under which it was captured, including events buffered before conversation creation.
Changing it invalidates earlier text even if off/on happens entirely between two
flushes, without a content event or with a reload in between. A producing tab also
scrubs its legacy queued text without a consent UUID. New text under the current UUID is retained.
The setting is checked for each content event, so enabling it after the page becomes
idle works and revoking it stops subsequent text capture. Before replay, queued text is removed
if either the current server policy or tab setting disallows it; event identities and
technical fields are retained.
If a durable scrub fails, its scope and any consent UUID to preserve remain pending
and are retried even after text is enabled again. Selective cleanup preserves queued
text captured under that UUID while it remains the current consent, including in
delivery copies and after reload; it does not turn a partial cleanup into a full revoke.
Full revocations and older scope-only intents still remove all text in their scope.
Content-free revocation intents are also saved in the
tab's session storage for reload recovery when that storage is available; otherwise
the current document keeps its pending intent in memory. Text capture stays off while an
intent is pending. Revoked in-memory rows are scrubbed immediately, and queued read
copies keep the same selective/full scrub for delivery until the durable scrub succeeds. New consent
permits new test text after cleanup; it does not restore pre-revocation text.
Scrubbed rows retain only `textRemoved: true`; reports show `textStatus: removed`
and a `text_removed` warning, distinct from text never captured or expired on the server.
If the original upload committed but its receipt or local queue removal was lost,
a scrubbed replay with the same event identity also removes the server's retained
text and releases its quota before ACK. Technical fields must match the committed
event; conflicts reject the entire batch. Repeated removal or an older text-bearing
retry cannot restore the text, change original timestamps or release quota twice.
Consent is checked again when a text-bearing request is acknowledged. If its UUID
or the observed policy changed during the request, accepted text rows stay queued
with the same identities for a `textRemoved` replay. This also survives a failed
local scrub and reload; technical acknowledgements proceed normally when cleanup
succeeds, and text captured under a new valid UUID is preserved. Uploads already
acknowledged and removed from the local queue follow the seven-day text retention.
Removal rows are sent in prioritized batches separate from ordinary additions.
A 507 preserves text/removal rows for retry; after a removal batch hits quota,
individual retries rotate past blocked rows so one unsaved event cannot hold up
deletion of other committed text. After an ordinary text addition hits quota,
technical-only batches bypass pending text additions; the text remains queued
for retry without suppressing smaller technical observations. Successful technical
delivery ends this priority, allowing the oldest retained text another attempt even
while new telemetry keeps arriving. Another 507 reinstates the bypass.
Pending removals keep the same 5 MiB / 24-hour
local queue limits and retry backoff.
With Web Locks ownership, consent provenance is local queue metadata tied to the tab
identity, including reloads. Only that tab can replay its text after checking current consent. Other tabs
can send technical-only rows but leave its text-bearing rows queued. If the producing
tab never returns, those rows expire after 24 hours with a loss marker; legacy text
without a recoverable producer also waits for expiry or server-policy scrubbing.
A duplicated/opener tab requires a fresh opt-in when its copied identity is rotated.
Without Web Locks (or when document ownership cannot be established), each document
gets a fresh diagnostic producer. Replay scrubs other producers' queued text into
technical-only removal records, even if this document opts in again. This retains
the original identities and timeline without reusing unverified consent; the
current document can still capture opted-in text until it closes or reloads.
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
Once conversation preparation succeeds, the stream binds before cancellation checks
and accounting metadata reservation. A failed reservation still leaves its startup
evidence available for independent diagnostic delivery without provider dispatch.
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
If collection is disabled before an upload receipt arrives, that discarded clock
sample does not latch calibration; the next successful upload after re-enabling
collection records a fresh sample.
An estimate outside the JavaScript Date range stays `null` in JSONL and
`time=unknown` in text, with `time_estimate_invalid`; raw timestamps and event
sequence numbers remain available and the rest of the report is still exported.
Do not treat provider audio timestamps as wall time or transcript packets as turns.

Pending `transcript.route` events contain newly pending fragment IDs; the resolved
route lists all of its fragments. `transcript.split` links each head/tail to its
parent and the split offset in UTF-16 code units. Split diagnostics use bounded
opaque IDs, independent of the hierarchical IDs used for attribution. Splitting preserves
the parent packet's audio timestamps; it does not infer timing inside the packet.

Search candidates include `lossEvents` and `noOutputTimeouts` (`null` when the
journal is unavailable). Both contribute to the diagnostic error count; losses
also produce an incompleteness warning. A no-output deadline is an observed
application timeout. Candidates also include `collectionGaps` (`collection_gaps`
in text), with `collection_disabled` warnings even in owner/time-window searches.
A collection gap alone is not counted as an application error. A timeout is
not proof of a provider fault. `server.attempt` with
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

The screen captures the revision, visible block count and its journal during render,
then records confirmation after commit. A transport switch before commit cannot move
that confirmation to the replacement stream. Abandoned renders record no confirmation.

Caption routing is observed separately from technical source attribution. Matching
a translation to a source never proves that PCM belonged to that source.

`turn.wait` stores changed completion predicates/deadlines, rather than every poll.
Snapshots and WebRTC counters are sampled every five seconds while connected;
microphone levels are summarized once a second using the existing analyser.
Snapshot `lastPcmQueueStartAt` records a PCM queue activation and `lastPlaybackEdgeAt`
records an accepted playback start/end edge, including audio without a known turn;
neither field measures continuous PCM receipt or playback progress.
Use successive WebRTC decoded-sample/jitter-buffer counters to assess continued delivery.
The four last-input/output/PCM/playback edge timestamps reset to `null` when a new
Live client is bound, including transport replacement and same-document resume.
They describe only that provider attempt, even when captions/history are retained.
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
Expiry maintenance also persists content-free loss records while collection is
disabled and delivers them after re-enabling, including after reload. These
historical records do not observe the current document's collection-policy interval
or create a `diagnostic.collection` boundary for an already finished attempt.
If inserting a loss marker evicts another observation, that victim also gets its
own scoped marker. Unexpired loss markers are protected from capacity eviction in
both IndexedDB and memory, so this process ends rather than cycling through markers.
The 5 MiB bound still applies: if only protected markers remain and the new record
cannot fit, it is rejected. A dropped/expired marker is not recursively replaced;
`loss_marker_dropped` produces a content-free local error at most once a minute.
At that point the timeline is incomplete and loss counts can understate the total.
Schema v2 upgrades the same database in place with a transactional byte counter and
expiry index; appends below capacity do not read the full backlog. Text revocation uses one
transaction over indexed text rows. These changes do not touch accounting storage.
The server limits journal payload accounting to 1 GiB total / 20 MiB per conversation
and also bounds SQLite page growth. Browser events have an aggregate 20 MiB allowance
per anonymous owner over retained conversations and 20 MiB per network source per
UTC day, independent of cookie rotation. Only a SHA-256 digest of the normalized
network prefix is stored. Validated received batches, including exact retries and
storage-rejected additions, are charged in an independent transaction before
storage deduplication; the source budget resets at UTC midnight. The raw IP is
never stored. Browser events cannot consume the final
10% of total or per-conversation capacity reserved for server observations. A rejected
batch is not ACKed; limits leave an incompleteness marker and do not block the conversation.

Retention is anchored to the server conversation creation time, never retry time:
text 7 days, technical records 30 days. Retained text charges are released from conversation, owner and global
storage quotas in the same transaction as deletion; daily ingress limits still
count received traffic. Startup migrates older journals and reconciles retained
payload counters, including text already purged by earlier versions. Text arriving
after expiry consumes ingress budget but is neither stored nor charged as retained
payload. Startup/hourly/shutdown maintenance uses secure delete and WAL
checkpoint/truncation. Purge batches are bounded and continue every
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
