import { existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { FullConfig, Reporter } from "@playwright/test/reporter";

export default class CleanupLedgerReporter implements Reporter {
  private canRemoveLedger = false;

  constructor(private readonly options: { databasePath: string }) {}

  onBegin({ argv }: Pick<FullConfig, "argv">): void {
    this.canRemoveLedger = argv[2] === "test" && !process.env.PWTEST_WATCH &&
      !argv.some(arg => /^--ui(?:$|[-=])/.test(arg));
  }

  onEnd(): void {
    if (!existsSync(this.options.databasePath)) return;
    // shortcut: preserve persistent ledgers until Playwright exposes a post-webServer cleanup hook.
    if (!this.canRemoveLedger) {
      console.error(`Playwright server shutdown could not be verified; real-Live ledger preserved for recovery: ${this.options.databasePath}`);
      return;
    }
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
