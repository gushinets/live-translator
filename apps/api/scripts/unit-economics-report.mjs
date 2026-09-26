import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { buildUnitEconomicsReport } from "../dist/reports/unitEconomics.js";

function argumentsFor(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key?.startsWith("--") || !value || key in values) throw new Error("invalid_arguments");
    values[key.slice(2)] = value;
  }
  return values;
}

function instant(value) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error("invalid_arguments");
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid_arguments");
  return parsed;
}

let db;
try {
  const options = argumentsFor(process.argv.slice(2));
  if (!("db" in options) || !("from" in options) || !("to" in options) || !("dataset" in options) ||
      Object.keys(options).some(key => !["db", "from", "to", "as-of", "dataset"].includes(key)) ||
      !["product", "experimental", "synthetic"].includes(options.dataset)) throw new Error("invalid_arguments");
  const now = Date.now();
  db = new DatabaseSync(options.db, { readOnly: true, timeout: 1000 });
  const report = buildUnitEconomicsReport(db, { from: instant(options.from), to: instant(options.to),
    asOf: options["as-of"] ? instant(options["as-of"]) : now, generatedAt: now, dataClass: options.dataset });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const code = error instanceof Error && "code" in error ? error.code : "report_failed";
  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
  process.exitCode = 2;
} finally { db?.close(); }
