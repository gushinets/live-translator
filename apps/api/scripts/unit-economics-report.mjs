import process from "node:process";
import { parseCliArguments } from "../dist/cli/arguments.js";
import { DatabaseSync } from "node:sqlite";
import { buildUnitEconomicsReport } from "../dist/reports/unitEconomics.js";

function instant(value) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error("invalid_arguments");
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid_arguments");
  return parsed;
}

let db;
try {
  const options = parseCliArguments(process.argv.slice(2));
  if (!("db" in options) || !("from" in options) || !("to" in options) || !("dataset" in options) ||
      Object.keys(options).some(key => !["db", "from", "to", "as-of", "dataset"].includes(key)) ||
      !["product", "experimental", "synthetic"].includes(options.dataset)) throw new Error("invalid_arguments");
  const now = Date.now();
  db = new DatabaseSync(options.db, { readOnly: true, timeout: 1000 });
  const report = buildUnitEconomicsReport(db, { from: instant(options.from), to: instant(options.to),
    asOf: options["as-of"] ? instant(options["as-of"]) : now, generatedAt: now, dataClass: options.dataset });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const code = error instanceof Error && "code" in error ? error.code
    : error instanceof Error && error.message === "invalid_arguments" ? "invalid_arguments" : "report_failed";
  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
  process.exitCode = 2;
} finally { db?.close(); }
