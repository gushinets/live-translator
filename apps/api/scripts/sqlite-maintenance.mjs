import process from "node:process";
import { backupUsageDatabase, restoreUsageDatabase, verifyUsageDatabase } from "../dist/persistence/sqliteBackup.js";

function argumentsFor(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key?.startsWith("--") || !value || key in values) throw new Error("invalid_arguments");
    values[key.slice(2)] = value;
  }
  return values;
}

try {
  const [operation, ...args] = process.argv.slice(2), options = argumentsFor(args);
  let result;
  if (operation === "backup" && Object.keys(options).length === 2 && options.source && options.target) {
    result = await backupUsageDatabase(options.source, options.target);
  } else if (operation === "restore" && Object.keys(options).length === 2 && options.source && options.target) {
    result = await restoreUsageDatabase(options.source, options.target);
  } else if (operation === "verify" && Object.keys(options).length === 1 && options.db) {
    result = verifyUsageDatabase(options.db);
  } else throw new Error("invalid_arguments");
  process.stdout.write(`${JSON.stringify({ operation, ...result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error && "code" in error ? error.code : "invalid_arguments" })}\n`);
  process.exitCode = 2;
}
