import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "live-translator-test-"));
const databasePath = join(directory, "usage.sqlite");

// Assign defaults before imports; per-test unstubAllEnvs must restore these, not the caller's environment.
Object.assign(process.env, {
  NODE_ENV: "test",
  WEB_ORIGIN: "http://localhost:5173",
  OPENAI_API_KEY: "test-placeholder-not-a-real-key",
  USAGE_LEDGER_ENABLED: "false",
  BACKGROUND_SESSION_CLOSE_ENABLED: "false",
  USAGE_DB_PATH: databasePath,
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(databasePath + suffix, { force: true });
  rmdirSync(directory);
});
