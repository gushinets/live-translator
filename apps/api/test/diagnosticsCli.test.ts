import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { openUsageDatabase } from "../src/persistence/database.js";
import { parseCliArguments, parseCliInstant } from "../src/cli/arguments.js";
import { buildDiagnosticReport, formatDiagnosticReport } from "../src/reports/diagnostics.js";
import { DiagnosticJournal } from "../src/diagnostics/DiagnosticJournal.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
// Execute the actual entry body against source imports; unit tests run before dist is built in CI.
const entry = readFileSync(new URL("../scripts/diagnostics-report.mjs", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
function report(argv: string[]) {
  let stdout = "", stderr = "";
  const process = { argv: ["node", "diagnostics-report", ...argv], env: {}, exitCode: 0,
    stdout: { write: (value: string) => { stdout += value; } }, stderr: { write: (value: string) => { stderr += value; } } };
  runInNewContext(entry, { process, DatabaseSync, parseCliArguments, parseCliInstant, buildDiagnosticReport, formatDiagnosticReport });
  return { stdout, stderr, exitCode: process.exitCode };
}
describe("diagnostics-report journal failures", () => {
  it.each(["text", "jsonl"])("exports the remaining timeline with a bad clock in %s format", format => {
    const directory = mkdtempSync(join(tmpdir(), "diagnostics-cli-clock-")); directories.push(directory);
    const path = join(directory, "ledger.sqlite"), db = openUsageDatabase(path), ledger = new UsageLedger(db);
    const conversation = ledger.createConversation(randomUUID(), randomUUID(), "cli-test"); db.close();
    const diagnostics = join(directory, "events.sqlite"), journal = new DiagnosticJournal(diagnostics, { automatic: false });
    const event = { schemaVersion: 1 as const, source: "browser" as const, conversationId: conversation.id, streamId: randomUUID(), seq: 1,
      wallMs: Date.now(), monoMs: 1 };
    journal.append(conversation, [{ ...event, type: "diagnostic.clock", data: { offsetMs: 1e308, uncertaintyMs: 0 } },
      { ...event, seq: 2, type: "app.lifecycle", data: { phase: "end", generation: 1 } }]); journal.close();
    const result = report(["--ledger-db", path, "--db", diagnostics, "--conversation-id", conversation.id, "--format", format]);
    expect(result.exitCode).toBe(0); expect(result.stderr).toBe("");
    expect(result.stdout).toContain("time_estimate_invalid"); expect(result.stdout).toContain("app.lifecycle");
  });
  it.each(["missing", "corrupt"])("lists ledger candidates and exports explicit missing evidence with a %s journal", mode => {
    const directory = mkdtempSync(join(tmpdir(), "diagnostics-cli-")); directories.push(directory);
    const path = join(directory, "ledger.sqlite"), db = openUsageDatabase(path), ledger = new UsageLedger(db);
    const conversation = ledger.createConversation(randomUUID(), randomUUID(), "cli-test"); db.close();
    const diagnostics = join(directory, "events.sqlite"); if (mode === "corrupt") writeFileSync(diagnostics, "invalid sqlite");
    const args = ["--ledger-db", path, "--db", diagnostics, "--format", "jsonl"];
    for (const selected of [[], ["--conversation-id", conversation.id]]) {
      const result = report([...args, ...selected]);
      expect(result.exitCode).toBe(0); expect(result.stderr).toBe("");
      const summary = JSON.parse(result.stdout.split("\n")[0]!);
      expect(summary.candidates).toContainEqual(expect.objectContaining({ conversationId: conversation.id, journalAvailable: false, errors: null }));
      expect(summary.warnings).toContain("journal_unavailable");
      if (selected.length) expect(summary.warnings).toContain(`${conversation.id}: journal_missing`);
    }
    expect(report([...args, "--ledger-db", join(directory, "missing-ledger.sqlite")]).exitCode).toBe(2);
    expect(report([...args, "--from", "invalid-time"]).exitCode).toBe(2);
  });
});
