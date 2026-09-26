import process from "node:process";
import { parseCliArguments } from "../dist/cli/arguments.js";
import { backupUsageDatabase, restoreUsageDatabase, verifyUsageDatabase } from "../dist/persistence/sqliteBackup.js";

try {
  const [operation, ...args] = process.argv.slice(2), options = parseCliArguments(args);
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
