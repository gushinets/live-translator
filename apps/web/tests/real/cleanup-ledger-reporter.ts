import { existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Reporter } from "@playwright/test/reporter";

export default class CleanupLedgerReporter implements Reporter {
  constructor(private readonly options: { databasePath: string }) {}

  // Reporter finalization runs after Playwright has stopped its webServer processes.
  onEnd(): void {
    if (!existsSync(this.options.databasePath)) return;
    let allTerminal = false;
    try {
      const db = new DatabaseSync(this.options.databasePath, { readOnly: true, timeout: 1000 });
      try {
        allTerminal = !db.prepare("SELECT 1 FROM live_sessions WHERE state IS NULL OR state NOT IN ('closed','failed') LIMIT 1").get();
      } finally { db.close(); }
    } catch { /* An unreadable ledger must remain available for recovery. */ }
    if (!allTerminal) {
      console.error(`Provider closure could not be verified; real-Live ledger preserved for recovery: ${this.options.databasePath}`);
      return;
    }
    for (const suffix of ["", "-wal", "-shm"]) rmSync(this.options.databasePath + suffix, { force: true });
  }
}
