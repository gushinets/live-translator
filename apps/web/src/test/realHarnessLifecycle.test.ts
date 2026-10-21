// @vitest-environment node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { UsageLedger } from "../../../api/src/accounting/UsageLedger";
import { openUsageDatabase } from "../../../api/src/persistence/database";
import CleanupLedgerReporter from "../../tests/real/cleanup-ledger-reporter";

describe("real-Live ledger lifetime", () => {
  it.each(["pending cleanup", "unreadable database"])("preserves recovery data and reports its path for %s", condition => {
    const directory = mkdtempSync(join(tmpdir(), "live-translator-real-harness-"));
    const databasePath = join(directory, "usage.sqlite"), id = randomUUID();
    const notice = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      if (condition === "pending cleanup") {
        const db = openUsageDatabase(databasePath);
        try {
          const ledger = new UsageLedger(db), owner = randomUUID();
          const c = ledger.createConversation(owner, randomUUID(), "test");
          ledger.registerAttempt(owner, { liveSessionId: id, conversationId: c.id, conversationVersion: c.version,
            initialMode: "setup", startReason: "initial", fingerprint: "test" });
          ledger.dispatchProviderAttempt(owner, id, c.version, randomUUID(), Date.now() + 900000);
          ledger.recordProviderCreated(id, "pending-provider");
          ledger.endConversation(owner, c.id, c.version, "user_end");
          ledger.recordCleanupFailure(id, "blocked_auth_config", "unauthorized");
        } finally { db.close(); }
      } else writeFileSync(databasePath, "unreadable ledger");

      new CleanupLedgerReporter({ databasePath }).onEnd();
      expect(existsSync(databasePath)).toBe(true);
      expect(notice.mock.calls.flat().join(" ")).toContain(databasePath);
      if (condition === "pending cleanup") {
        const retained = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(retained.prepare("SELECT state,openai_session_id,close_confirmed,cleanup_reason FROM live_sessions WHERE id=?").get(id))
            .toMatchObject({ state: "unknown", openai_session_id: "pending-provider", close_confirmed: 0, cleanup_reason: "user_end" });
        } finally { retained.close(); }
      } else expect(readFileSync(databasePath, "utf8")).toBe("unreadable ledger");
    } finally {
      notice.mockRestore();
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      expect(basename(directory)).toMatch(/^live-translator-real-harness-/);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["passed", "failed", "startup failed"])("removes the database and sidecars after the API exits when the run %s", async outcome => {
    const directory = mkdtempSync(join(tmpdir(), "live-translator-real-harness-"));
    const markerPath = join(directory, "api.json"), configPath = join(directory, "playwright.config.ts");
    const serverPath = join(directory, "api.mjs");
    let databasePath: string | undefined;
    try {
      writeFileSync(join(directory, "package.json"), '{"type":"module"}');
      writeFileSync(serverPath, `
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
const databasePath = process.env.USAGE_DB_PATH;
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE live_sessions(state TEXT); INSERT INTO live_sessions VALUES('${outcome === "failed" ? "failed" : "closed"}')");
const marker = { databasePath, pid: process.pid };
writeFileSync(process.env.PROBE_MARKER, JSON.stringify(marker));
process.on('SIGTERM', () => {
  marker.filesAtShutdown = ['', '-wal', '-shm'].every(suffix => existsSync(databasePath + suffix));
  db.close();
  for (const suffix of ['-wal', '-shm']) writeFileSync(databasePath + suffix, 'leftover journal');
  writeFileSync(process.env.PROBE_MARKER, JSON.stringify(marker));
  process.exit(0);
});
if (process.env.PROBE_STARTUP_FAILURE === 'true') process.exit(7);
createServer((_req, res) => res.end('ok')).listen(0, '127.0.0.1', () => console.log('READY'));
`);
      const realConfig = new URL("../../playwright.real.config.ts", import.meta.url).href;
      const playwright = new URL("../../node_modules/@playwright/test/index.mjs", import.meta.url).href;
      const testMarker = join(directory, "test-ran");
      writeFileSync(join(directory, "probe.spec.ts"), `import { test, expect } from ${JSON.stringify(playwright)}; import { writeFileSync } from 'node:fs'; test('probe', () => { writeFileSync(${JSON.stringify(testMarker)}, 'ran'); expect(${outcome === "passed"}).toBe(true); });`);
      const command = `"${process.execPath}" "${serverPath}"`;
      writeFileSync(configPath, `
import realConfig from ${JSON.stringify(realConfig)};
const api = realConfig.webServer.find(server => server.cwd === '../api');
export default { ...realConfig, testDir: ${JSON.stringify(directory)}, testMatch: 'probe.spec.ts',
  outputDir: ${JSON.stringify(join(directory, "results"))}, projects: [{ name: 'lifecycle' }],
  webServer: { command: ${JSON.stringify(command)}, wait: { stdout: /READY/ }, timeout: 5000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 2000 },
    env: { ...api.env, PROBE_MARKER: ${JSON.stringify(markerPath)}, PROBE_STARTUP_FAILURE: '${outcome === "startup failed"}' } },
};`);
      const cli = fileURLToPath(new URL("../../node_modules/@playwright/test/cli.js", import.meta.url));
      const result = await new Promise<{ code: number; output: string }>(finish => {
        execFile(process.execPath, [cli, "test", "--config", configPath], { timeout: 20000 }, (error, stdout, stderr) => {
          finish({ code: error ? typeof error.code === "number" ? error.code : -1 : 0, output: stdout + stderr });
        });
      });
      expect(result.code, result.output).toBe(outcome === "passed" ? 0 : 1);
      expect(existsSync(testMarker), result.output).toBe(outcome !== "startup failed");
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { databasePath: string; pid: number; filesAtShutdown?: boolean };
      databasePath = marker.databasePath;
      expect(() => process.kill(marker.pid, 0)).toThrow();
      if (process.platform !== "win32" && outcome !== "startup failed") expect(marker.filesAtShutdown).toBe(true);
      for (const suffix of ["", "-wal", "-shm"]) expect(existsSync(databasePath + suffix), `leftover database${suffix}`).toBe(false);
    } finally {
      if (!databasePath && existsSync(markerPath)) databasePath = (JSON.parse(readFileSync(markerPath, "utf8")) as { databasePath: string }).databasePath;
      if (databasePath) {
        expect(dirname(resolve(databasePath))).toBe(resolve(tmpdir()));
        expect(basename(databasePath)).toMatch(/^live-translator-real-[\da-f-]+\.sqlite$/);
        for (const suffix of ["", "-wal", "-shm"]) rmSync(databasePath + suffix, { force: true });
      }
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      expect(basename(directory)).toMatch(/^live-translator-real-harness-/);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
});
