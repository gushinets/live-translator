import process from "node:process";
import { backupUsageDatabase, restoreUsageDatabase } from "../../src/persistence/sqliteBackup.ts";

try {
  const operation = process.env.LT_SQLITE_TEST_OPERATION === "restore" ? restoreUsageDatabase : backupUsageDatabase;
  const result = await operation(process.env.LT_SQLITE_TEST_SOURCE, process.env.LT_SQLITE_TEST_TARGET);
  process.stdout.write(JSON.stringify({ result }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error && typeof error === "object" && "code" in error ? error.code : "unknown" }) + "\n");
  process.exitCode = 2;
}
