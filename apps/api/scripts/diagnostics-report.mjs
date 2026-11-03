import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import { parseCliArguments, parseCliInstant } from "../dist/cli/arguments.js";
import { buildDiagnosticReport, formatDiagnosticReport } from "../dist/reports/diagnostics.js";

let ledger, diagnostics;
try {
  const args = parseCliArguments(process.argv.slice(2));
  const allowed = new Set(["db", "ledger-db", "conversation-id", "live-session-id", "owner", "from", "to", "format"]);
  if (Object.keys(args).some(key => !allowed.has(key)) || args.format && !["text", "jsonl"].includes(args.format)) throw new Error("invalid_arguments");
  ledger = new DatabaseSync(args["ledger-db"] ?? process.env.USAGE_DB_PATH ?? "/data/live-translator.sqlite", { readOnly: true, timeout: 1000 });
  try { diagnostics = new DatabaseSync(args.db ?? process.env.DIAGNOSTICS_DB_PATH ?? "/diagnostics/events.sqlite", { readOnly: true, timeout: 1000 }); }
  catch { /* Ledger search remains available when the journal cannot be opened. */ }
  const options = { conversationId: args["conversation-id"], liveSessionId: args["live-session-id"], owner: args.owner,
    ...(args.from ? { from: parseCliInstant(args.from) } : {}), ...(args.to ? { to: parseCliInstant(args.to) } : {}) };
  let report;
  try { report = buildDiagnosticReport(ledger, diagnostics, options); }
  catch (error) {
    if (!diagnostics) throw error;
    report = buildDiagnosticReport(ledger, undefined, options);
  }
  process.stdout.write(formatDiagnosticReport(report, args.format ?? "text"));
} catch {
  process.stderr.write(`${JSON.stringify({ error: "diagnostics_report_failed", hint: "Check database paths, ISO-8601 timestamps with timezone, and --format text|jsonl" })}\n`);
  process.exitCode = 2;
} finally { diagnostics?.close(); ledger?.close(); }
