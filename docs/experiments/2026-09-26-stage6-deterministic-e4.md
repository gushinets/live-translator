# Stage 6 deterministic recovery and restore checks

**Date performed:** 2026-09-26–27. **Code under test:** Stage 6 branch from baseline
`950285eb679dc57bfc23582b162205a65cd4e9f7`; final published code SHA is recorded
in the PR. **Environment:** Windows isolated worktree, Node 24.18.0, SQLite
3.53.1, pnpm 10.34.1, Docker 29.8.0 / Compose 5.5.1, Playwright 1.63.0.

## Purpose and method

Verify the deterministic E4 portion: startup recovery and resume expiry, late
final reconciliation, mixed usage reporting, coherent SQLite online backup and
restore, integrity and foreign keys, Docker persistence, and browser
regressions. All ledger records were created by synthetic fixtures in disposable
databases/volumes. API credentials were placeholders; no provider endpoint was
called.

## Results

- `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck`, `pnpm lint`,
  `pnpm build` and `node apps/api/scripts/g1-mock-report.mjs` passed. The full
  unit suite reported 55 files and 1120 tests. Build retained the existing
  advisory for the large web bundle.
- The backup regression test wrote to a live SQLite WAL, created an online
  backup, restored into a separate directory and compared the unit-economics
  report and recovery/usage control rows before and after. It retained
  `usage_identity_version`, a pending resume and cleanup obligation. Both
  snapshots passed `integrity_check` and had zero foreign-key violations.
- In that synthetic report, three selected conversations had one partial
  checkpoint, one unknown usage row and one conflict. The pre-restore and
  post-restore reports were equal. After restore, a late final of 120 seconds
  replaced the partial subtotal for reporting (105 checkpoint seconds were not
  added again); the ended conversation's `end_reason` and `ended_at` stayed
  fixed. A report with a foreign conversation ID was rejected.
- The no-dispatch pending-resume case expired as a definitive `failed` attempt,
  released its local reservation and did not call the provider creator. The
  dispatched case kept its durable cleanup fence and did not invent close data.
- CLI smoke on a separate empty temporary database produced
  `unit-economics-v1` JSON. Online backup and restore each returned 23 pages;
  verify then reported
  verify reported `integrity: ok` and `foreignKeyViolations: 0`. A separate
  controlled destination-path failure left the source readable and an existing
  target unchanged. No disk was filled.
- The production package deployment check included both CLI entrypoints. Docker
  Compose image build and the CI ledger-persistence test passed; persistence
  used a unique disposable volume and networking-disabled containers.
- CI-equivalent Playwright Chromium and WebKit projects each passed 18 tests.
  This confirms automated browser behavior only, not physical iPhone Safari or
  Android Chrome/PWA behavior.

## Limits and gates

This is deterministic local evidence for part of E4, not an operational test on
the production VPS. No real API key, provider usage, bill, device, or production
database was used. E1 remains reported/unverified from its primary source; E2
price and short-session calibration and E3 physical-device checks remain
`NOT_RUN` / `EXTERNAL_GATE`. Gate G3 and production rollout remain open. The
monetary catalog is intentionally empty until current primary-source pricing
and E2 evidence can be attached. `BACKGROUND_SESSION_CLOSE_ENABLED=false`.
