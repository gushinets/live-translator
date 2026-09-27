import process from "node:process";
import { parseCliArguments, parseCliInstant } from "../dist/cli/arguments.js";
import { DatabaseSync } from "node:sqlite";
import { buildUnitEconomicsReport } from "../dist/reports/unitEconomics.js";

let db;
try {
  const options = parseCliArguments(process.argv.slice(2));
  if (!("db" in options) || !("from" in options) || !("to" in options) || !("dataset" in options) ||
      Object.keys(options).some(key => !["db", "from", "to", "as-of", "dataset"].includes(key)) ||
      !["product", "experimental", "synthetic"].includes(options.dataset)) throw new Error("invalid_arguments");
  const now = Date.now();
  db = new DatabaseSync(options.db, { readOnly: true, timeout: 1000 });
  const report = buildUnitEconomicsReport(db, { from: parseCliInstant(options.from), to: parseCliInstant(options.to),
    asOf: options["as-of"] ? parseCliInstant(options["as-of"]) : now, generatedAt: now, dataClass: options.dataset });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const code = error instanceof Error && "code" in error ? error.code
    : error instanceof Error && error.message === "invalid_arguments" ? "invalid_arguments" : "report_failed";
  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
  process.exitCode = 2;
} finally { db?.close(); }
