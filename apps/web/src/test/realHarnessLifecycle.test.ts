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

      const reporter = new CleanupLedgerReporter({ databasePath });
      reporter.onBegin({ argv: [process.execPath, "playwright", "test"] });
      reporter.onEnd();
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

  it.each([
    { name: "UI host", args: ["test", "--ui-host=127.0.0.1"] },
    { name: "UI port", args: ["test", "--ui-port", "0"] },
    { name: "watch", args: ["test"] },
    { name: "test server", args: ["test-server"] },
    { name: "programmatic runner", args: [] },
  ])("preserves terminal ledgers and reports the recovery path for $name", ({ name, args }) => {
    const directory = mkdtempSync(join(tmpdir(), "live-translator-real-harness-"));
    const databasePath = join(directory, "usage.sqlite");
    const notice = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("PWTEST_WATCH", name === "watch" ? "1" : undefined);
    try {
      const db = new DatabaseSync(databasePath);
      try { db.exec("CREATE TABLE live_sessions(state TEXT); INSERT INTO live_sessions VALUES('closed')"); }
      finally { db.close(); }
      for (const suffix of ["-wal", "-shm"]) writeFileSync(databasePath + suffix, "leftover journal");
      const reporter = new CleanupLedgerReporter({ databasePath });
      reporter.onBegin({ argv: args.length ? [process.execPath, "playwright", ...args] : [] });
      reporter.onEnd();
      for (const suffix of ["", "-wal", "-shm"]) expect(existsSync(databasePath + suffix)).toBe(true);
      expect(notice.mock.calls.flat().join(" ")).toContain(databasePath);
    } finally {
      vi.unstubAllEnvs();
      notice.mockRestore();
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      expect(basename(directory)).toMatch(/^live-translator-real-harness-/);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["passed", "failed", "startup failed", "persistent UI"])("handles the ledger safely through the %s Playwright lifecycle", async outcome => {
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
const marker = { databasePath };
writeFileSync(process.env.PROBE_MARKER, JSON.stringify(marker));
process.once('exit', () => writeFileSync(process.env.PROBE_MARKER, JSON.stringify({ ...marker, exited: true })));
process.on('SIGTERM', () => {
  marker.filesAtShutdown = ['', '-wal', '-shm'].every(suffix => existsSync(databasePath + suffix));
  db.close();
  for (const suffix of ['-wal', '-shm']) writeFileSync(databasePath + suffix, 'leftover journal');
  writeFileSync(process.env.PROBE_MARKER, JSON.stringify(marker));
  process.exit(0);
});
if (process.env.PROBE_STARTUP_FAILURE === 'true') process.exit(7);
const server = createServer((_req, res) => res.end(JSON.stringify({
  sessions: db.prepare('SELECT COUNT(*) AS count FROM live_sessions').get().count,
  filesPresent: ['', '-wal', '-shm'].every(suffix => existsSync(databasePath + suffix)),
})));
server.listen(0, '127.0.0.1', () => {
  marker.port = server.address().port;
  writeFileSync(process.env.PROBE_MARKER, JSON.stringify(marker));
  console.log('READY');
});
`);
      const realConfig = new URL("../../playwright.real.config.ts", import.meta.url).href;
      const playwright = new URL("../../node_modules/@playwright/test/index.mjs", import.meta.url).href;
      const testMarker = join(directory, "test-ran");
      writeFileSync(join(directory, "probe.spec.ts"), `import { test, expect } from ${JSON.stringify(playwright)}; import { writeFileSync } from 'node:fs'; test('probe', () => { writeFileSync(${JSON.stringify(testMarker)}, 'ran'); expect(${outcome !== "failed"}).toBe(true); });`);
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
      const snapshotsPath = join(directory, "batches.json"), persistentRunnerPath = join(directory, "persistent.mjs");
      if (outcome === "persistent UI") writeFileSync(persistentRunnerPath, `
import { createRequire } from 'node:module';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
const requirePlaywright = createRequire(realpathSync(new URL(${JSON.stringify(playwright)})));
const { testServer } = requirePlaywright('playwright/lib/runner');
const { configLoader } = requirePlaywright('playwright/lib/common');
// shortcut: use the installed UI dispatcher for headless lifecycle coverage; revisit on Playwright upgrades.
const dispatcher = new testServer.TestServerDispatcher(
  configLoader.resolveConfigLocation(${JSON.stringify(configPath)}),
  { argv: [process.execPath, ${JSON.stringify(cli)}, 'test', '--ui'] },
);
await dispatcher.initialize({ interceptStdio: false });
const snapshots = [];
let apiURL;
try {
  const setup = await dispatcher.runGlobalSetup({});
  if (setup.status !== 'passed') throw new Error(JSON.stringify(setup));
  const { port } = JSON.parse(readFileSync(${JSON.stringify(markerPath)}, 'utf8'));
  apiURL = 'http://127.0.0.1:' + port;
  for (let batch = 0; batch < 2; batch++) {
    const { status } = await dispatcher.runTests({});
    const response = await fetch(apiURL, { signal: AbortSignal.timeout(2000) });
    snapshots.push({ status, apiStatus: response.status, api: await response.json() });
  }
} finally {
  await dispatcher.runGlobalTeardown();
  await dispatcher.stop();
}
const reachableAfterTeardown = await fetch(apiURL, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
writeFileSync(${JSON.stringify(snapshotsPath)}, JSON.stringify({ snapshots, reachableAfterTeardown }));
`);
      const result = await new Promise<{ code: number; output: string }>(finish => {
        const args = outcome === "persistent UI" ? [persistentRunnerPath] : [cli, "test", "--config", configPath];
        execFile(process.execPath, args, { timeout: 20000 }, (error, stdout, stderr) => {
          finish({ code: error ? typeof error.code === "number" ? error.code : -1 : 0, output: stdout + stderr });
        });
      });
      expect(result.code, result.output).toBe(outcome === "passed" || outcome === "persistent UI" ? 0 : 1);
      expect(existsSync(testMarker), result.output).toBe(outcome !== "startup failed");
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { databasePath: string; exited?: boolean; filesAtShutdown?: boolean };
      databasePath = marker.databasePath;
      // Windows force-kills webServer; graceful shutdown and startup failure can acknowledge exit.
      if (process.platform !== "win32" || outcome === "startup failed") expect(marker.exited).toBe(true);
      if (process.platform !== "win32" && outcome !== "startup failed") expect(marker.filesAtShutdown).toBe(true);
      if (outcome === "persistent UI") {
        const batches = JSON.parse(readFileSync(snapshotsPath, "utf8"));
        expect(batches.snapshots, result.output).toEqual([
          { status: "passed", apiStatus: 200, api: { sessions: 1, filesPresent: true } },
          { status: "passed", apiStatus: 200, api: { sessions: 1, filesPresent: true } },
        ]);
        expect(batches.reachableAfterTeardown).toBe(false);
        expect(result.output).toContain(databasePath);
      }
      for (const suffix of ["", "-wal", "-shm"]) expect(existsSync(databasePath + suffix), `database${suffix}`).toBe(outcome === "persistent UI");
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
