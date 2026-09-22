import type { UsageLedger } from "./UsageLedger.js";
import type { CloseObservation } from "./types.js";
export type CleanupOutcome = { kind: "closed_observed"; observation: CloseObservation } | { kind: "terminal_not_live" }
  | { kind: "retryable_error" | "blocked_auth_config"; code: string };
export type OrphanCloser = (providerId: string, signal: AbortSignal) => Promise<CleanupOutcome>;

/** Per-localId ownership plus global concurrency. SQL owns scheduling and retry expiry. */
export class CleanupWorker {
  private readonly running = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private draining: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly concurrency: number;
  private readonly batchSize: number;
  constructor(private readonly ledger: UsageLedger, private readonly closer: OrphanCloser,
    private readonly options: { concurrency?: number; batchSize?: number; onChange?: () => void; logger?: Pick<Console, "error"> } = {}) {
    this.concurrency = options.concurrency ?? 2; this.batchSize = options.batchSize ?? 20;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || !Number.isSafeInteger(this.batchSize) || this.batchSize < 1) throw new Error("Invalid cleanup worker bounds");
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.wake(), 1000); this.timer.unref(); this.wake();
  }
  wake(): void { void this.drain().catch(() => this.options.logger?.error("Cleanup worker storage unavailable")); }
  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.draining ??= Promise.resolve().then(() => this.run()).finally(() => { this.draining = null; });
    return this.draining;
  }
  private async run(): Promise<void> {
    while (!this.stopped) {
      this.ledger.watchdog();
      let expiredAny = false;
      for (const row of this.ledger.expiredCleanup(this.batchSize)) {
        if (this.running.has(row.id)) continue;
        this.ledger.exhaustCleanup(row.id); expiredAny = true;
      }
      this.options.onChange?.();
      for (const row of this.ledger.dueCleanup(this.batchSize)) {
        if (this.running.size >= this.concurrency || this.stopped) break;
        if (this.running.has(row.id)) continue;
        const controller = new AbortController();
        const task = Promise.resolve().then(() => this.attempt(row.id, row.openai_session_id!, controller.signal)).finally(() => this.running.delete(row.id));
        this.running.set(row.id, { controller, task });
      }
      if (this.running.size) await Promise.race([...this.running.values()].map(r => r.task));
      else if (!expiredAny) break;
    }
  }
  private async attempt(id: string, providerId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    let result: CleanupOutcome;
    try { result = await this.closer(providerId, signal); }
    catch { result = { kind: "retryable_error", code: "transport_error" }; }
    // A process shutdown abort must not fabricate a provider outcome or retry.
    if (signal.aborted) return;
    if (result.kind === "closed_observed") this.ledger.recordCleanupClosed(id, result.observation);
    else if (result.kind === "terminal_not_live") this.ledger.recordProviderTerminalNotLive(id);
    else this.ledger.recordCleanupFailure(id, result.kind, result.code);
    this.options.onChange?.();
  }
  async stop(remainingMs: number): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    const tasks = Promise.allSettled([...this.running.values()].map(r => r.task));
    if (this.running.size && remainingMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([tasks, new Promise<void>(r => { timer = setTimeout(r, remainingMs); })]);
      if (timer) clearTimeout(timer);
    }
    for (const run of this.running.values()) run.controller.abort();
    await Promise.resolve();
  }
}
