import process from "node:process";
import { writeSync } from "node:fs";
import { backup } from "node:sqlite";
import { backupUsageDatabase, restoreUsageDatabase } from "../../src/persistence/sqliteBackup.ts";

try {
  const operation = process.env.LT_SQLITE_TEST_OPERATION === "restore" ? restoreUsageDatabase : backupUsageDatabase;
  const copy = process.env.LT_SQLITE_TEST_BOUNDARY === "during_copy"
    ? (source, target) => backup(source, target, { rate: 1, progress({ totalPages, remainingPages }) {
      if (totalPages > remainingPages && remainingPages > 0) {
        writeSync(1, JSON.stringify({ boundary: "copy_in_progress", path: target, pid: process.pid,
          pagesCopied: totalPages - remainingPages, remainingPages, totalPages }) + "\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    } })
    : backup;
  const result = await operation(process.env.LT_SQLITE_TEST_SOURCE, process.env.LT_SQLITE_TEST_TARGET, copy);
  process.stdout.write(JSON.stringify({ result }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error && typeof error === "object" && "code" in error ? error.code : "unknown" }) + "\n");
  process.exitCode = 2;
}
