# Live Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the existing Live Translator runtime so active GPT-Live sessions are capped and released correctly, local device testing is safe/configurable, and the tested upstream API behavior is documented as Revision 1.2.2.

**Architecture:** Keep the existing Express API, React/Vite PWA, and direct browser-to-OpenAI WebRTC media path. An in-memory lease registry binds each successful OpenAI session id to one TTL-backed lease; the browser explicitly releases that id after local Live cleanup, while TTL handles abandoned clients. Local development remains tunnel-independent; physical-device testing uses a configurable HTTPS endpoint without hardcoded machine-specific hosts.

**Tech Stack:** TypeScript, Express, Zod, OpenAI TypeScript SDK, React, Vite, Vitest, Playwright, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-13-live-translator-mvp-design.md` (Revision 1.2.2)

## Global Constraints

- `MAX_CONCURRENT_SESSIONS = 5` counts active Live sessions, not only HTTP creation requests.
- Successful creation holds a lease until explicit release or TTL expiry; failed creation releases immediately.
- `session.delegation` is omitted at create time; required event-level `delegation_id: null` remains unchanged.
- No database, Redis, user accounts, React authentication, media proxy, model change, or unrelated turn/PWA redesign.
- No API key, SDP, transcript, prompt, context, raw upstream response, or default upstream error message in logs or committed files.
- Local desktop development and automated tests require no VPN or tunnel; any externally reachable physical-device endpoint must be HTTPS and protected appropriately.

---

### Task 1: Bind leases to active Live session ids

**Files:**
- Modify: `apps/api/src/security/SessionLeaseRegistry.ts`
- Test: `apps/api/src/security/SessionLeaseRegistry.test.ts`
- Modify: `apps/api/src/routes/liveSession.ts`
- Test: `apps/api/test/liveSession.test.ts`

**Interfaces:**
- `SessionLeaseRegistry.acquire(now?: number): SessionLease | null`
- `SessionLeaseRegistry.bindSession(leaseId: string, sessionId: string): void`
- `SessionLeaseRegistry.releaseSession(sessionId: string): boolean`
- `DELETE /api/live/session/:sessionId` returns `204` for known, duplicate, and unknown ids.

- [x] **Step 1: Write failing registry tests** for five bound sessions blocking a sixth, releasing one id freeing capacity, TTL pruning, and unknown/duplicate release returning false without throwing.
- [x] **Step 2: Run the registry tests** and confirm they fail because `bindSession` and `releaseSession` do not exist.
- [x] **Step 3: Implement the smallest in-memory mapping**: store lease expiry and optional session id, bind the id after successful creation, remove by session id idempotently, and prune expired entries on acquire/release.
- [x] **Step 4: Write failing route tests** for successful binding, release endpoint origin checks, 204 idempotency, failed creation cleanup, and five sequential successful creations rejecting the sixth.
- [x] **Step 5: Run route tests** and confirm failures identify missing binding/release behavior.
- [x] **Step 6: Implement route behavior**: bind the returned `session.id` before returning `201`, release only on creation failure, and add the same-origin-checked DELETE route without exposing registry state.
- [x] **Step 7: Run API tests and typecheck** with `pnpm --filter @live-translator/api test` and `pnpm --filter @live-translator/api typecheck`.

### Task 2: Release the backend lease from the browser lifecycle

**Files:**
- Modify: `apps/web/src/api/BackendClient.ts`
- Test: `apps/web/src/api/BackendClient.test.ts`
- Modify: `apps/web/src/live/LiveClient.ts`
- Test: `apps/web/src/live/LiveClient.test.ts`

**Interfaces:**
- Add `BackendClient.releaseLiveSession(sessionId: string): Promise<void>` using `DELETE /api/live/session/${encodeURIComponent(sessionId)}`.
- Extend the injected backend contract used by `LiveClient` with the release method.

- [x] **Step 1: Write failing BackendClient tests** asserting the DELETE request, successful 204 handling, and non-blocking rejection behavior at the caller boundary.
- [x] **Step 2: Run the focused web API tests** and confirm the release method is missing.
- [x] **Step 3: Implement the thin DELETE client method** with no response-body requirement.
- [x] **Step 4: Write failing LiveClient tests** proving a connected client releases once after graceful close and after server-initiated terminal close; prove release failure does not reject local close or prevent transport teardown.
- [x] **Step 5: Run focused LiveClient tests** and confirm the lifecycle assertions fail.
- [x] **Step 6: Implement best-effort release** after `session.close` finalization/timeout and after terminal server/network cleanup, guarded by the known session id and an idempotent local flag; log only a fixed non-content diagnostic on release failure.
- [x] **Step 7: Run the focused web tests** and verify all lifecycle paths pass.

### Task 3: Secure and configure local device testing

**Files:**
- Modify: `apps/web/vite.config.ts`
- Modify: `.env.example`
- Create or modify: concise physical-device testing documentation near the existing deployment docs

- [x] **Step 1: Write/configure tests or a deterministic config check** showing localhost remains allowed and an environment-provided additional host is accepted without `allowedHosts: true`.
- [x] **Step 2: Replace the committed personal hostname** with an environment-driven value such as `VITE_ADDITIONAL_ALLOWED_HOST`, filtering out an empty value.
- [x] **Step 3: Add only a blank placeholder** for that variable to `.env.example`; never add a machine-specific hostname.
- [x] **Step 4: Document tunnel-independent localhost development** and require HTTPS plus an appropriate access gate for externally reachable physical-device testing; state explicitly that Origin validation is not authentication and that the OpenAI-backed API must not be exposed raw.
- [x] **Step 5: Run the web typecheck/build and inspect the generated bundle** to ensure no access secret is embedded.

### Task 4: Reduce OpenAI error logging to structured metadata

**Files:**
- Modify: `apps/api/src/routes/liveSession.ts`
- Test: `apps/api/test/liveSession.test.ts`

- [x] **Step 1: Update the failing logger assertion** so a sensitive upstream message is absent and only `status`, `code`, `type`, and `requestId` are expected.
- [x] **Step 2: Run the API route test** and confirm the current `message` field fails the assertion.
- [x] **Step 3: Remove `error.message` from default OpenAI logging** while retaining the four structured metadata fields.
- [x] **Step 4: Run the API tests and typecheck** and confirm no secret/content fields are logged.

### Task 5: Update Revision 1.2.2 documentation and existing plan assumptions

**Files:**
- Modify: `docs/superpowers/specs/2026-09-13-live-translator-mvp-design.md`
- Modify: `docs/superpowers/plans/2026-09-13-live-translator-mvp-implementation.md`

- [x] **Step 1: Update the spec revision header and summary** to Revision 1.2.2 with the tested create-time delegation correction, preserved event-level `delegation_id: null`, active-session lease lifecycle, local/HTTPS device-testing distinction, Origin-not-authentication warning, and environment-only Vite host configuration.
- [x] **Step 2: Make only targeted amendments to the historical implementation plan**: remove its create-time `delegation: null` example, state that Revision 1.2.2 supersedes the affected assumption, and change lease wording from failed-creation cleanup to active-session lifetime plus explicit release/TTL fallback.
- [x] **Step 3: Search the repository** for obsolete create-time `delegation: null` and machine-specific host references, distinguishing them from required event-level `delegation_id: null`.

### Task 6: Verify, commit, push, and update PR #2

**Files:**
- Modify: existing files from Tasks 1–5 only

- [x] **Step 1: Run required verification**: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- [x] **Step 2: Run Playwright** with `pnpm --filter @live-translator/web exec playwright test`; report any environment-only limitation explicitly.
- [x] **Step 3: Run the manual smoke checks** for env loading, Live `201`, lease cap/release/TTL, metadata-only logging, configurable host behavior, and absence of secrets from Git/bundle.
- [x] **Step 4: Review `git diff --check`, staged names, and secret scans**; ensure `.env` is ignored and no personal hostname or credential is committed.
- [x] **Step 5: Commit focused changes** on `codex/fix-live-translator-runtime` without creating or merging another PR.
- [x] **Step 6: Push the existing branch** and update PR #2 body with runtime fixes, Revision 1.2.2, verification results, runtime evidence, and security notes.
