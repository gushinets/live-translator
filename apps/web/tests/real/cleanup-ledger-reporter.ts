import { rmSync } from "node:fs";
import type { Reporter } from "@playwright/test/reporter";

export default class CleanupLedgerReporter implements Reporter {
  constructor(private readonly options: { databasePath: string }) {}

  // Reporter finalization runs after Playwright has stopped its webServer processes.
  onEnd(): void {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(this.options.databasePath + suffix, { force: true });
  }
}
