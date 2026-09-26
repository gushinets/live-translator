# Unit economics and lifecycle acceptance

**Final verification:** 2026-09-27 (checks ran across 2026-09-26–27). **Baseline:** `950285eb679dc57bfc23582b162205a65cd4e9f7`.
**Branch:** `feat/unit-economics-reconciliation`. Results describe local synthetic
tests and CI-equivalent commands; no production database or provider was used.

| ID | Code and regression coverage | Executed command and result | Limits |
|---|---|---|---|
| A6.1 | Startup still uses `LedgerRuntime` recovery/admission restore and the existing `CleanupWorker`; tests cover restart, paused expiry, reservations, and no fabricated close/final. Worker tests cover retry exhaustion and terminal-not-live. | `pnpm test` — pass (55 files, 1120 tests), including `test/reconcileSessions.test.ts`, `test/cleanupWorker.test.ts`, `test/UsageLedger.test.ts`. | No live provider or VPS restart. |
| A6.2 | `test/reconcileSessions.test.ts`: late final enriches the existing row and leaves `ended_at`/`end_reason` unchanged. | Included in the passing focused and full suites. | Synthetic ledger data. |
| A6.3 | `src/reports/unitEconomics.ts` reuses `conversationSummary`; reports final/partial/unknown/conflict/no-dispatch, known seconds, count coverage, estimates, provenance, durations, cleanup outcomes, distributions and excluded reasons. Read uses one deferred SQLite snapshot; CLI opens read-only. | `pnpm --filter @live-translator/api exec vitest run test/unitEconomics.test.ts` — pass (6 tests). Report CLI smoke emitted valid `unit-economics-v1` JSON from a read-only temporary DB. | Product and experimental data must be passed as separate database paths; there is no cross-owner web endpoint. |
| A6.4 | `src/reports/pricingPolicy.ts` assigns a policy version at durable provider dispatch, uses exact integer/BigInt rounding, and separates historical final from current-price scenario. The fixture has two explicitly synthetic versions. | `test/unitEconomics.test.ts` — pass, including dispatch-time v1 retained for a late final while current scenario selects v2. | No verified production policy is configured; unavailable prices stay unavailable and `invoiceTotal` is null. |
| A6.5 | `src/persistence/sqliteBackup.ts` uses Node `node:sqlite` online backup, refuses same/existing targets, restores only to a new path and verifies `integrity_check` plus `foreign_key_check`. Regression fixture includes a live WAL, usage, conflict, cleanup, pending resume and identity version; report and row controls compare equal before/after restore. | `pnpm --filter @live-translator/api exec vitest run test/databaseBackup.test.ts` — pass (2 tests). CLI smoke: backup returned 23 pages with integrity `ok`; restore and verify returned `integrity: ok`, `foreignKeyViolations: 0`. | These were disposable local DBs. No production restore or switch was attempted. |
| A6.6 | Existing create/commit failure boundaries remain in place; tests cover unavailable storage, commit/fsync failure and no provider call before durable registration. New tests cover corrupt metadata without echoing its contents and a controlled blocked-path write failure. Existing `SessionController.test.ts` covers local capture stop before server close completes. | Covered by `pnpm test`; Docker persistence and local health smoke also pass. | The controlled write failure did not fill a filesystem. Backend cleanup confirmation and local audio stop are separate outcomes. |
| A6.7 | Experiment register keeps primary provider and physical-device evidence separate from deterministic fixtures. Default `BACKGROUND_SESSION_CLOSE_ENABLED` remains false. | See [`2026-09-26-stage6-deterministic-e4.md`](../experiments/2026-09-26-stage6-deterministic-e4.md). | E1 source evidence is not re-created here; E2/E3 and complete E4 remain outstanding. Gate G3 is not declared closed. |
| A6.8 | Existing atomic claim-expiry/recovery paths are exercised without a second worker. Regressions cover a no-dispatch claim becoming `failed` with no reservation, a valid pending resume surviving repeated restart, and a dispatched claim expiring at the original deadline with a durable cleanup fence, paused rollback and rejected late completion. | `pnpm --filter @live-translator/api exec vitest run test/reconcileSessions.test.ts test/UsageLedger.test.ts` — pass (39 tests); included in `pnpm test`. | No provider create is replayed; tests use fake/local dependencies only. |
| A6.9 | Mixed-cohort and exact synthetic ratio test: final 120 s, active 60000 ms, accepted 30000 ms, completed 20000 ms; zero/missing/partial coverage stays distinct. G1 script has assertions for 120/240/360 and accepted-second ratio 4. | `pnpm --filter @live-translator/api exec vitest run test/unitEconomics.test.ts` and `node apps/api/scripts/g1-mock-report.mjs` — pass. | Ratios are fixture arithmetic, not device usage, semantic quality, provider billing or phase allocation. |

## Full local verification

Run from the repository root with Node 24 and pnpm 10.34.1. Compose checks used
placeholder-only values for the required environment fields.

```text
pnpm install --frozen-lockfile              PASS
pnpm test                                   PASS — 55 files, 1120 tests
pnpm typecheck                              PASS
pnpm lint                                   PASS
pnpm build                                  PASS — existing web chunk-size advisory
node apps/api/scripts/g1-mock-report.mjs    PASS — synthetic assertions
docker compose -f infra/docker-compose.yml config --quiet   PASS
docker compose -f infra/docker-compose.yml build           PASS
python infra/tests/test_admission_config.py                PASS — 3 tests
python infra/tests/test_ledger_persistence.py              PASS — disposable named volume
Playwright Chromium E2E                    PASS — 18 tests
Playwright WebKit E2E                      PASS — 18 tests
```

Production API health smoke returned `{"status":"ok"}` with placeholder-only
credentials and `USAGE_LEDGER_ENABLED=false`. Report/backup/restore CLI smoke
used disposable files under the ignored local cache. `test:real-two-way` was not
run.

## Rollback

The feature adds no database migration. If report or maintenance commands are
rolled back, keep the API ledger and `CleanupWorker` active, continue accepting
valid late usage, and retain pending cleanup/recovery records. Restore never
replaces an active DB path and does not dispatch provider creates. The background
close flag remains false; no merge, deployment, production flag change, or
production data operation was performed.
