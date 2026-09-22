# Architecture Review Handoff

## Project

Repository:

`https://github.com/gushinets/live-translator`

Project: **Live Translator**

Current product is a two-way live speech translator implemented as a PWA.

Core stack:

- React
- TypeScript
- WebRTC
- OpenAI GPT-Live / `gpt-live-1`
- small Node/Express backend
- Nginx + Docker Compose deployment on VPS

The frontend connects directly to OpenAI Live over WebRTC.

The backend holds the OpenAI API key and is responsible for creating Live sessions. Audio does not transit through the application backend.

---

# 1. Purpose of this architectural review

Before implementation, we want an external architectural review of a planned addition to the current system.

The goals are:

1. collect minimal but reliable usage statistics;
2. understand real provider consumption for every user conversation;
3. calculate **unit economics** of the translator;
4. later use these data to design pricing/tariffs;
5. correctly handle users who background or abandon the PWA without explicitly pressing “End conversation”;
6. avoid paying for an OpenAI Live session while the user is not actually using the translator;
7. retain enough usage information even when a browser, WebRTC connection or application terminates unexpectedly.

We explicitly do **not** want to build a full analytics platform, billing system or account system at this stage.

We want the smallest architecture that gives us trustworthy data and a clean evolutionary path toward commercial billing later.

---

# 2. Current architecture

High-level flow:

```text
Browser / PWA
     |
     | POST /api/live/session + SDP offer
     v
Backend
     |
     | OpenAI SDK / API key
     v
OpenAI Live
     |
     | SDP answer
     v
Backend
     |
     v
Browser
     |
     +============== WebRTC ==============+
     |                                     |
     +--------------------------------> OpenAI

```

Once session creation completes, media and Live events go directly between the browser and OpenAI.

The backend does not proxy audio.

---

# 3. Current Live-session creation

Relevant backend area:

```text
apps/api/src/openai/createLiveSession.ts
apps/api/src/routes/liveSession.ts
apps/api/src/security/SessionLeaseRegistry.ts
apps/api/src/config.ts

```

Current creation endpoint:

```text
POST /api/live/session

```

The backend:

1. validates Origin;
2. validates SDP;
3. checks the OpenAI API key;
4. acquires a local session lease;
5. creates a GPT-Live session;
6. associates the lease with the returned OpenAI `session.id`;
7. returns the WebRTC answer to the browser.

The model is currently:

```text
gpt-live-1

```

with:

```text
store: false

```

---

# 4. Current concurrency protection

Backend currently has:

```text
maxConcurrentSessions = 5
leaseMs = 15 minutes

```

`SessionLeaseRegistry` is entirely in-memory.

The practical consequence is:

> approximately five OpenAI Live sessions can exist concurrently through this backend.

A sixth session-creation request is rejected.

This means that if ten test users attempt to use the application simultaneously, only approximately five can establish Live sessions.

There is also a session-creation rate limit currently based on IP.

For an MVP/internal test with approximately ten simultaneous users, we have agreed that these limits should be made configurable through environment variables.

Current tentative target:

```text
MAX_CONCURRENT_SESSIONS = 15

```

and a less restrictive creation rate limit, approximately:

```text
60 Live-session creations / 10 minutes / IP

```

The exact values are configurable operational parameters rather than architectural constants.

The reason the IP rate limit matters is that multiple testers can appear behind the same NAT, office network or Wi-Fi.

---

# 5. Important distinction: conversation != OpenAI session

This is a fundamental characteristic of the current application.

One logical user conversation can contain **multiple OpenAI Live sessions**.

This is already true today.

During language/bootstrap setup, `SessionController` may replace one `LiveClient` with another and create a fresh WebRTC/OpenAI session.

Therefore this model is incorrect:

```text
1 conversation = 1 OpenAI session

```

Instead, the intended data model is:

```text
user
  |
  +-- conversation
          |
          +-- OpenAI session 1
          +-- OpenAI session 2
          +-- OpenAI session 3
          +-- ...

```

This becomes even more important with the proposed background lifecycle described below.

---

# 6. Why we need usage accounting

The primary business objective is **unit economics**.

For every logical translator conversation we eventually want to know:

```text
How much useful translation did the user receive?

How many GPT-Live seconds did we pay for?

How much provider usage came from bootstrap/setup?

How much provider usage came from actual interpretation?

How much provider usage was caused by lifecycle overhead?

How many OpenAI sessions were needed?

How often were sessions terminated abnormally?

```

Eventually this should allow calculations such as:

```text
provider cost per conversation

provider cost per useful translation minute

bootstrap overhead per conversation

provider seconds / useful user seconds

average number of GPT sessions per conversation

cost distribution by conversation length

```

These data will later inform tariff design.

---

# 7. Existing provider usage signal

The current frontend already understands GPT-Live usage events.

Relevant code:

```text
apps/web/src/live/LiveClient.ts
apps/web/src/live/LiveEvents.ts

```

It already parses:

```text
session.usage.updated

```

and final usage from:

```text
session.closed

```

There is already:

```text
LiveClient.onUsage

```

and `SessionUsageSnapshot`.

However, `SessionController` currently does not bind `onUsage`.

Therefore usage data is received and parsed but effectively discarded.

This is a useful existing hook that can be connected to the new backend usage ledger.

---

# 8. Real GPT-Live experiment already performed

Before finalizing the architecture, we ran an actual experiment using real:

```text
gpt-live-1

```

over WebRTC.

Experiment commit:

```text
5a32ee2a1c3fe81e12b00be404214f0887c27e82

```

Environment included:

- Windows
- Chromium through Playwright
- OpenAI SDK 7.15.0
- WebRTC
- actual OpenAI API key
- actual GPT-Live sessions

No mocks were used for the provider measurements.

The experiment report was saved as:

```text
docs/experiments/2026-09-20-gpt-live-background-usage.md

```

with a corresponding raw event log.

---

# 9. Main experimental result

The most important measured result is:

> **Keeping an OpenAI Live session open while input is muted does not materially stop provider usage.**

In the clean visibility/suspend experiment:

```text
wall interval: 60.274 seconds

usage.seconds before: 15
usage.seconds after:  73

delta: 58 seconds

```

The session remained alive during the interval.

The peer remained connected.

The DataChannel remained open.

The application later unmuted the same Live session successfully.

Therefore provider usage was almost proportional to wall-clock session lifetime even though the input was muted.

---

# 10. Idle sessions behaved similarly

An open but idle session also continued receiving cumulative usage updates.

Observed values were approximately:

```text
15
28
43
58

```

and graceful close later produced final usage around:

```text
73 seconds

```

This indicates that usage is much closer to **open Live-session lifetime** than to “time during which somebody is speaking.”

---

# 11. Important observation about usage event cadence

`session.usage.updated` was not continuously updated.

During the experiment, values arrived roughly every \~15 seconds, with irregular boundaries.

Therefore:

```text
session.usage.updated

```

is useful as a last-known cumulative checkpoint, but it is not always the exact final usage.

The final value from:

```text
session.closed

```

was more authoritative.

This matters especially for short sessions.

---

# 12. Graceful versus abrupt termination experiment

Two termination paths were compared.

## Graceful

```text
session.close
    ↓
session.closed

```

This produced:

- close reason;
- final usage;
- clean session finalization.

## Abrupt transport termination

Equivalent to closing the RTC transport without sending `session.close`.

Observed for 10 seconds afterward.

Result:

```text
session.closed did not arrive
final usage was unavailable

```

This is particularly important because the current application has a `disconnectImmediately()` path used during some Live-client/session replacements.

The experiment demonstrates that such abrupt termination can lose provider final usage and close metadata.

---

# 13. Consequence for lifecycle design

The application currently treats:

```text
visibility:hidden

```

as suspension.

The present flow is roughly:

```text
visibility:hidden
      ↓
disable local capture
disable local playback
      ↓
input_audio.mute
      ↓
state = suspended
      ↓
KEEP WebRTC AND GPT SESSION OPEN

```

When the user becomes visible again, the same Live session is resumed.

The experiment shows that this is economically undesirable.

A 60-second suspension consumes approximately 60 seconds of provider usage.

---

# 14. Architectural decision agreed after the experiment

We want to separate:

### Logical product conversation

from:

### Provider Live session

When the user backgrounds the application, the logical conversation can remain alive.

The provider Live session should not.

New intended semantics:

```text
visibility:hidden
      ↓
pause logical conversation
      ↓
gracefully close current GPT-Live session
      ↓
save final usage
      ↓
release WebRTC/backend lease

```

The logical `conversation_id` remains valid.

If the user returns:

```text
visibility:visible
      ↓
same conversation_id
      ↓
create NEW GPT-Live session
      ↓
restore required interpreter state
      ↓
continue conversation

```

---

# 15. No provider background grace period

Initially we discussed keeping a GPT session alive for perhaps 15–60 seconds after backgrounding.

The experiment changed that decision.

Because almost every second of background time becomes provider usage, the agreed MVP approach is:

```text
provider-session background grace = 0 seconds

```

In other words:

> close the GPT-Live session as soon as the app becomes hidden.

We explicitly distinguish this from logical-conversation retention.

---

# 16. Logical conversation retention

Although the provider session closes immediately on background, the **logical conversation does not need to end**.

Example:

```text
12:00 conversation starts

12:04 user switches to Maps
      GPT session S1 closes

12:06 user returns
      GPT session S2 starts

12:10 user backgrounds application again
      GPT session S2 closes

```

All of this may still be:

```text
conversation_id = C123

```

Tentative logical conversation retention:

```text
approximately 5 minutes

```

If the user returns within that period, resume the same logical conversation.

If not, mark the conversation ended/abandoned.

The exact retention duration is a product parameter and can be configurable.

Unlike provider-session grace time, logical retention has essentially no GPT-Live runtime cost because the provider session is already closed.

---

# 17. Important UX/state restoration requirement

Closing the GPT session on background must not force the user to restart the translator setup.

When the user returns, the application should retain locally/server-side as appropriate:

- selected/detected language A;
- selected/detected language B;
- user context;
- conversation identity;
- enough recent/authoritative context to reconstruct the interpreter;
- product conversation state.

A newly created GPT-Live session should be initialized with sufficient state to resume the same logical translation conversation.

Architecture review should pay special attention to:

> how much conversation context must be reconstructed when creating the replacement Live session, and where that authoritative state should live.

We do not want to persist full transcripts unless necessary.

Privacy and minimal data retention remain goals.

---

# 18. Proposed identity model

We do not want account registration for MVP.

Minimum user identity:

```text
anonymous_user_id

```

generated as a random UUID by the backend and stored in a first-party cookie.

Recommended properties:

```text
HttpOnly
Secure
SameSite appropriate for same-origin PWA
long-lived

```

The frontend does not need to know the ID.

The backend can associate requests with it automatically through the cookie.

Limitations are acceptable for MVP:

- another browser = another anonymous user;
- another device = another anonymous user;
- private mode = another anonymous user;
- clearing cookies resets identity.

This is sufficient for early unit economics.

Current Nginx Basic Auth must **not** be treated as product user identity.

---

# 19. Core identifiers

We expect three identifier levels:

```text
anonymous_user_id

conversation_id

openai_session_id

```

Relationship:

```text
anonymous user
      |
      +-- conversation C1
      |      |
      |      +-- Live S1
      |      +-- Live S2
      |      +-- Live S3
      |
      +-- conversation C2
             |
             +-- Live S4

```

`conversation_id` should represent one logical translator interaction.

Each OpenAI session belongs to exactly one conversation.

---

# 20. Proposed persistent storage

For the current deployment we prefer:

```text
SQLite

```

rather than PostgreSQL.

Reasons:

- single VPS;
- single backend instance;
- low expected traffic;
- approximately tens, not thousands, of concurrent sessions;
- very small metadata volume;
- operational simplicity.

Database should live in a persistent Docker volume.

Example:

```text
/data/live-translator.sqlite

```

SQLite WAL mode should be considered.

The architecture should not make migration to PostgreSQL unnecessarily difficult, but PostgreSQL is currently considered overkill.

---

# 21. Minimal proposed data model

## conversations

Conceptually:

```text
id
anonymous_user_id

created_at
first_interpreter_at
last_active_at
ended_at

status
end_reason

```

Possible statuses:

```text
active
paused
ended
abandoned

```

Possible end reasons could include:

```text
user_end
background_timeout
max_duration
transport_failure
abandoned

```

Exact enums are open to review.

---

# 22. Live-session ledger

A separate table for every provider session.

Conceptually:

```text
id
conversation_id
openai_session_id

kind

started_at
ended_at

usage_seconds
usage_source

close_reason
end_reason
finalized

```

Possible `kind` values:

```text
bootstrap
interpreter
resume

```

The distinction matters because we want to calculate setup overhead independently from useful translation usage.

---

# 23. Usage quality / provenance

We do not want to pretend that all usage measurements have equal reliability.

Proposed:

```text
provider_final
provider_incremental
wall_estimate

```

Priority:

```text
provider_final
       >
provider_incremental
       >
wall_estimate

```

Examples:

### Ideal

```text
usage_seconds = 74
usage_source = provider_final

```

### Browser disappeared after latest usage event

```text
usage_seconds = 58
usage_source = provider_incremental

```

### No provider usage event ever arrived

```text
usage_seconds = 8
usage_source = wall_estimate

```

A later higher-quality measurement should be allowed to replace a lower-quality one.

---

# 24. Handling `session.usage.updated`

`usage.seconds` is cumulative.

Therefore this is WRONG:

```text
15 + 28 + 43 + 58

```

We should persist something conceptually equivalent to:

```text
usage_seconds =
max(current_usage_seconds, received_usage_seconds)

```

For example:

```text
usage.updated 15
→ save 15

usage.updated 28
→ save 28

usage.updated 43
→ save 43

session.closed 46
→ save 46 and mark provider_final

```

The browser can forward provider usage to the backend.

For MVP we do not require server-side Sideband metering.

---

# 25. `session.closed` should be first-class

Based on the real experiment, graceful finalization is important for accounting.

Therefore:

```text
session.close
      ↓
session.closed
      ↓
persist final usage
      ↓
persist close reason
      ↓
teardown transport

```

should be the normal termination path whenever technically possible.

Final provider usage should be saved before considering a session fully finalized.

---

# 26. Current `disconnectImmediately()` needs review

The existing application intentionally has abrupt-disconnect behavior in some bootstrap/session replacement paths.

This was previously useful for strict runtime boundaries.

However, the experiment demonstrated that abrupt transport termination can lose:

- `session.closed`;
- final provider usage;
- provider close reason.

Therefore this code path must be reviewed.

Desired behavior where feasible:

```text
old Live session
     ↓
session.close
     ↓
wait for session.closed
     ↓
save final usage
     ↓
teardown old transport
     ↓
create replacement session

```

with a bounded timeout.

We do not want an indefinitely blocked replacement if OpenAI fails to send `session.closed`.

Possible fallback:

```text
provider_incremental

```

if available, otherwise:

```text
wall_estimate

```

Architecture review should evaluate whether all current `disconnectImmediately()` usages can safely become graceful, or whether some must remain abrupt because of stale-event/lifecycle concerns.

---

# 27. Background lifecycle target

Target semantics:

```text
ACTIVE PRODUCT CONVERSATION
        |
        | visibility:hidden
        v
disable capture/output
        |
        v
gracefully close GPT session
        |
        v
persist final provider usage
        |
        v
release backend lease
        |
        v
PRODUCT CONVERSATION = PAUSED

```

When visible again:

```text
PRODUCT CONVERSATION = PAUSED
        |
        | visibility:visible
        v
check conversation retention
        |
        +-- expired → END
        |
        +-- valid
              |
              v
        create new GPT session
              |
              v
        restore interpreter context
              |
              v
        PRODUCT CONVERSATION = ACTIVE

```

---

# 28. Browser-killed edge case

Browser lifecycle events cannot be treated as guaranteed on mobile.

A browser/PWA can:

- background;
- freeze;
- lose network;
- be killed by the OS;
- crash.

Therefore no architecture should depend on:

```text
beforeunload
unload
pagehide

```

always completing a network request.

`visibilitychange → hidden` is useful and should trigger normal graceful shutdown while JavaScript is still running.

But there must still be an abnormal/abandoned path.

---

# 29. Backend heartbeat decision

We previously considered periodic browser → backend heartbeat.

After the experiment and new immediate-background-close strategy, the current decision is:

> **do not implement heartbeat in the first iteration unless architectural review identifies a strong need.**

Reasons:

- the Live session should already close immediately on normal background;
- usage updates themselves create periodic activity;
- logical conversation state can be expired later;
- we want minimum MVP complexity.

A heartbeat remains a future option for:

- stronger liveness detection;
- automatic abandoned-session reconciliation;
- quota enforcement;
- operational monitoring.

Please challenge this decision if there is a concrete failure mode that makes heartbeat necessary now.

---

# 30. Sideband decision

OpenAI Live supports server-side/sideband control of a Live session.

This could eventually let the backend observe/control session lifecycle authoritatively even if the browser disappears.

We are deliberately **not planning Sideband for this MVP**.

Reason:

it adds:

- one backend connection per active Live session;
- reconnect logic;
- more lifecycle state;
- more cleanup logic;
- more operational complexity.

For MVP unit economics we believe:

```text
browser receives provider usage
        ↓
browser reports cumulative usage to backend
        ↓
backend persists it

```

plus graceful finalization is sufficient.

Sideband may become appropriate later for:

- paid balances;
- server-enforced quotas;
- commercial billing;
- authoritative provider usage;
- forced server-side termination;
- recovery/reconciliation.

Architecture review should confirm or challenge this staged approach.

---

# 31. No transcript/audio analytics

For this project phase we explicitly do not need to persist:

- raw audio;
- audio files;
- complete conversation transcripts;
- personally identifying conversation content.

The accounting layer should be metadata-oriented.

This minimizes:

- privacy exposure;
- storage;
- compliance burden;
- security surface.

If limited recent textual context is technically necessary to reconstruct a resumed GPT session, the reviewer should distinguish this runtime requirement from analytics persistence.

---

# 32. Existing 15-minute session limit

Frontend currently has approximately:

```text
maxSessionMs = 15 minutes

```

A timer begins after `session.started` and invokes `endConversation()` after the limit.

Under the new model, we should distinguish:

### OpenAI Live-session max duration

from:

### logical conversation duration

A long logical conversation might eventually look like:

```text
conversation C1

S1 = 15 minutes
S2 = 15 minutes
S3 = 5 minutes

```

All sessions still belong to the same logical conversation.

The current 15-minute provider-session cap does not necessarily need to become a 15-minute product-conversation cap.

Please review whether that interpretation is safe with the existing state machine.

---

# 33. Session lease behavior

Current backend leases:

- are in-memory;
- expire after approximately 15 minutes;
- are used to protect concurrency.

Important:

> lease TTL does not itself terminate an OpenAI WebRTC session.

It only stops counting the lease after expiry/pruning.

Therefore the lease system must not be confused with provider-session lifecycle management.

A persistent usage ledger and the lease registry have different responsibilities.

---

# 34. Planned configuration changes

Current hardcoded concurrency-related settings should become environment configuration.

Expected parameters include something like:

```text
MAX_CONCURRENT_SESSIONS
LIVE_SESSION_LEASE_MS
LIVE_SESSION_RATE_LIMIT
CONVERSATION_RETENTION_MS

```

Potentially:

```text
MAX_PROVIDER_SESSION_MS

```

Names are not final.

Defaults should remain safe for local development and internal testing.

---

# 35. Proposed implementation sequence

Current intended order:

## Task 1 — configurable concurrency

- move max concurrent Live sessions to environment/config;
- increase internal-test deployment target from 5 to approximately 15;
- make creation rate-limit configurable;
- choose a test-friendly limit such as approximately 60/10min/IP.

---

## Task 2 — anonymous user identity

Add first-party anonymous user UUID.

No signup/login.

Backend-managed cookie preferred.

---

## Task 3 — logical conversation identity

Introduce:

```text
conversation_id

```

representing one product conversation independently from provider sessions.

---

## Task 4 — SQLite persistence

Add persistent SQLite storage.

Minimum entities:

```text
conversations
live_sessions

```

No broad analytics warehouse.

---

## Task 5 — register every provider session

When `/api/live/session` creates an OpenAI session:

- associate it with `conversation_id`;
- persist `openai_session_id`;
- persist start time;
- persist session kind if available.

---

## Task 6 — connect existing `LiveClient.onUsage`

Use existing provider usage events.

Send cumulative provider usage to backend.

Persist last known usage.

Do not sum repeated cumulative events.

---

## Task 7 — authoritative finalization

On:

```text
session.closed

```

persist:

- final usage;
- final usage source;
- close reason;
- ended timestamp;
- finalized flag.

---

## Task 8 — improve provider-session replacement

Review/replace abrupt `disconnectImmediately()` paths where safe.

Prefer graceful close before replacement.

Use bounded timeout and fallback accounting.

---

## Task 9 — change background behavior

Current:

```text
hidden → suspend/mute → keep session

```

Target:

```text
hidden → graceful provider close → logical conversation paused

```

No provider grace period.

---

## Task 10 — resume via new provider session

On return while logical conversation is still retained:

```text
new OpenAI session
same conversation_id
restore interpreter state
continue

```

---

## Task 11 — logical conversation expiry

If paused conversation does not resume within retention period, tentatively around:

```text
5 minutes

```

mark it ended/abandoned.

This retention period should be configurable.

---

# 36. Unit-economics outputs we want

The architecture should make the following queries easy.

For one conversation:

```text
total provider usage seconds
bootstrap provider usage seconds
interpreter provider usage seconds
number of OpenAI sessions
product conversation duration
active product duration
number of resumes
termination reasons
amount of estimated vs provider-final usage

```

Across conversations:

```text
average GPT seconds per conversation

median/p95 GPT seconds per conversation

bootstrap overhead %

GPT seconds per useful conversation minute

abnormal termination %

provider-final accounting coverage %

average number of provider sessions per conversation

background/resume frequency

```

Eventually:

```text
estimated provider cost
      ↓
required gross margin
      ↓
candidate tariff

```

We intentionally want to collect the raw provider usage before hard-coding business pricing assumptions.

---

# 37. Pricing data itself

The primary persistent truth should be:

```text
usage_seconds

```

rather than only:

```text
cost_usd

```

because provider pricing can change.

Future possibilities:

- calculate monetary cost dynamically from an effective pricing table;
- store pricing version/rate used at finalization;
- store both raw usage and computed historical cost.

For the first implementation, provider usage seconds are the key measurement.

Architecture reviewer should recommend the simplest design that preserves historical unit-economics correctness when OpenAI pricing changes.

---

# 38. Important expected failure modes

Please review the architecture specifically against:

### A. User presses End

Should result in:

```text
graceful provider close
final usage
conversation end

```

### B. User backgrounds PWA

Should result in:

```text
graceful provider close
final usage
conversation paused

```

### C. User returns

Should result in:

```text
new provider session
same conversation

```

### D. Browser crashes before close

Possible result:

```text
provider final unavailable
use latest incremental usage / wall estimate
mark abnormal

```

### E. Browser dies before first usage update

Possible result:

```text
wall_estimate only

```

### F. OpenAI does not answer session.close

Use bounded timeout.

Do not block lifecycle indefinitely.

### G. Session closes remotely

Persist remote close and final usage if available.

### H. Network disconnect

Record transport failure and best available usage.

### I. Duplicate usage/report requests

All operations should be idempotent.

### J. Duplicate close/release requests

Should be harmless.

### K. Multiple browser tabs

Consider whether the anonymous identity/conversation design introduces accidental interference.

---

# 39. Questions for the external architecture reviewer

Please review the proposal critically and answer the following.

## Data model

1. Is the split:

```text
anonymous user
→ logical conversation
→ provider sessions

```

the correct abstraction?

2. Is SQLite appropriate for the expected MVP topology?
3. Are two tables enough initially?
4. What fields are missing from the proposed ledger?
5. Is `usage_source = provider_final | provider_incremental | wall_estimate` sufficient?

---

## Lifecycle

6. Is immediate GPT-session close on `visibility:hidden` the correct choice given the measured usage behavior?
7. Are there browser/PWA lifecycle situations where this would produce unacceptable UX or incorrect behavior?
8. Should there be any tiny provider grace period despite its cost?
9. Is five-minute logical conversation retention reasonable?
10. Where should resumable interpreter state live?
11. What minimum state must be replayed into a fresh GPT-Live session after resume?

---

## Accounting

12. Is browser-forwarded `session.usage.updated` acceptable for MVP unit economics?
13. How should the backend make usage reports idempotent?
14. Should every `usage.updated` be forwarded, or should the browser throttle/debounce reports?
15. How should provider-final usage overwrite/upgrade earlier measurements?
16. Is wall-clock fallback good enough when provider data is unavailable?
17. What additional timestamps should be recorded?

---

## Graceful finalization

18. Should existing `disconnectImmediately()` usages be converted to graceful close?
19. Are there specific replacement paths where doing so risks stale callbacks or state corruption?
20. What timeout is appropriate while waiting for `session.closed`?
21. Should creation of the next provider session wait for complete finalization of the previous one?

---

## Backend authority

22. Do we genuinely need heartbeat in the first version?
23. Is there a failure mode that makes heartbeat mandatory?
24. Do we need OpenAI Sideband now?
25. At what commercial maturity would Sideband become necessary?

---

## Concurrency

26. Is:

```text
MAX_CONCURRENT_SESSIONS ≈ 15

```

reasonable for ten-person internal testing?

27. Should concurrency accounting remain an in-memory lease registry while statistics become persistent?
28. Could stale leases materially block users under the new lifecycle?
29. Should lease TTL align with provider-session max duration?

---

## Unit economics

30. Are `usage.seconds` plus session classifications enough to model initial unit economics?
31. What additional metric is essential before designing tariffs?
32. Should provider price/rate be stored per session or applied later through an effective-dated pricing table?
33. How would you preserve historical cost accuracy after pricing changes?

---

## Security/privacy

34. Is an HttpOnly anonymous-user cookie adequate at this stage?
35. Is there any reason the frontend itself needs access to the anonymous user ID?
36. Are we storing more personal/conversation information than necessary?
37. Can the resume design avoid persistent full transcripts?

---

# 40. What we explicitly do NOT want yet

Please do not expand the proposal into a large commercial platform unless absolutely necessary.

Out of scope for this iteration:

- registration/login;
- subscriptions;
- payments;
- prepaid balance;
- tariff enforcement;
- full billing engine;
- data warehouse;
- third-party analytics platform;
- CRM;
- transcript archive;
- audio archive;
- PostgreSQL cluster;
- Redis;
- Kafka/event bus;
- distributed session coordination;
- mandatory Sideband;
- complex observability platform.

We want an MVP-grade implementation with a clean upgrade path.

---

# 41. Desired review output

Please provide an architectural review, not implementation.

Structure the response as:

## 1. Overall assessment

Is the proposed direction structurally sound?

## 2. Blocking issues

Problems that should be resolved before implementation.

## 3. Important non-blocking issues

Things worth adjusting but which do not invalidate the architecture.

## 4. Lifecycle review

Analyze start/background/resume/end/crash behavior.

## 5. Data model review

Recommend exact minimal entities/fields/indexes.

## 6. Usage-accounting review

Review provider-final/incremental/fallback design.

## 7. Concurrency review

Review limits, leases and rate limiting.

## 8. Unit-economics review

Confirm whether the planned data are sufficient for future tariff modeling.

## 9. Security/privacy review

Especially anonymous identity and transcript/audio retention.

## 10. Recommended architecture

Provide the smallest architecture you would implement.

## 11. Recommended implementation order

Identify dependencies and migration sequence.

## 12. Things you would deliberately postpone

Identify complexity that should not enter the MVP.

For every criticism, please distinguish:

```text
BLOCKER
IMPORTANT
OPTIONAL

```

Please avoid proposing complexity without explaining the concrete failure mode it solves.

The primary optimization target is:

> obtain trustworthy unit-economics data with minimum architectural complexity while ensuring abandoned/backgrounded browser sessions do not unnecessarily consume GPT-Live usage.