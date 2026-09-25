import { ActiveTimeMetrics, type ActivityState } from "./ActiveTimeMetrics";
import { SourceSpeechMetrics, type SpeechSample } from "./SourceSpeechMetrics";
import { COUNTER_NAMES, type MetricCounters, type UsageObservation, type UsageReport, type AppMetricsReport } from "./UsageTypes";
import type { UsageOutbox } from "./UsageOutbox";
export interface ProductObservation extends ActivityState {
  atMs: number; speechEligible: boolean; counters: MetricCounters;
  turnId?: string; completedTurnId?: string; sample?: SpeechSample; resetSpeech?: boolean;
}
const usableSeconds = (s: unknown): s is number => typeof s === "number" && Number.isFinite(s) && s >= 0;

/** One immutable local attempt, including callbacks arriving after its product generation ended. */
export class UsageReporter {
  private readonly now: () => number;
  private readonly active: ActiveTimeMetrics;
  private readonly speech = new SourceSpeechMetrics();
  private readonly baseline: MetricCounters;
  private counters: MetricCounters = {};
  private state: ProductObservation;
  private sequence = 0;
  private finalized = false;
  private discarded = false;
  private work: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private checkpoint: number | undefined;
  private providerStartedObservedAt: number | undefined;
  private interpreterReadyObservedAt: number | undefined;
  private readyCheckpoint: number | undefined;
  constructor(private readonly localId: string, private readonly conversationId: string,
    private readonly outbox: Pick<UsageOutbox, "enqueue" | "finishProducer" | "noProvider">,
    options: { now?: () => number; automatic?: boolean; initial?: ProductObservation } = {}) {
    this.now = options.now ?? (() => performance.now()); const start = this.now();
    this.active = new ActiveTimeMetrics(start);
    this.state = options.initial ?? { atMs: start, visible: globalThis.document?.visibilityState !== "hidden", state: "connecting", interpreterReady: false, mediaReady: false, speechEligible: false, counters: {} };
    this.baseline = { ...this.state.counters };
    this.observeProduct({ ...this.state, atMs: start });
    if (options.automatic !== false) {
      this.timer = setInterval(() => this.emit({ schemaVersion: 1 }), 15000);
      globalThis.document?.addEventListener("visibilitychange", this.onVisibility);
    }
  }
  private readonly onVisibility = () => {
    if (this.finalized) return;
    const visible = document.visibilityState !== "hidden";
    this.observeProduct({ ...this.state, atMs: this.now(), visible, mediaReady: visible ? false : this.state.mediaReady, speechEligible: false, sample: undefined, completedTurnId: undefined });
    this.emit({ schemaVersion: 1 });
  };
  providerStarted(): void { this.providerStartedObservedAt ??= Date.now(); }
  observeProduct(observation: ProductObservation): void {
    if (this.finalAppSent) return;
    for (const name of COUNTER_NAMES) {
      const total = observation.counters[name];
      if (typeof total === "number" && Number.isFinite(total)) this.counters[name] = Math.max(this.counters[name] ?? 0, total - (this.baseline[name] ?? 0));
    }
    if (this.finalized) return;
    this.active.update(observation, observation.atMs);
    this.speech.transition(observation.speechEligible, observation.atMs);
    if (observation.resetSpeech) this.speech.reset(observation.atMs);
    if (observation.sample) this.speech.sample(observation.sample, observation.speechEligible, observation.turnId);
    if (observation.completedTurnId) this.speech.complete(observation.completedTurnId);
    if (observation.interpreterReady && this.interpreterReadyObservedAt === undefined) {
      this.interpreterReadyObservedAt = Date.now(); this.readyCheckpoint = this.checkpoint;
    }
    this.state = { ...observation, sample: undefined, completedTurnId: undefined, resetSpeech: undefined };
  }
  observeUsage(usage: UsageObservation): void {
    if (this.discarded) return;
    if (usage.kind === "checkpoint") {
      if (!usableSeconds(usage.seconds)) return;
      this.checkpoint = Math.max(this.checkpoint ?? 0, usage.seconds);
      this.emit({ schemaVersion: 1, checkpointSeconds: usage.seconds }); return;
    }
    this.finalize();
    if (usage.kind === "provider_closed") {
      this.emit({ schemaVersion: 1, providerClosed: {
        ...(usableSeconds(usage.seconds) ? { seconds: usage.seconds } : {}),
        ...(typeof usage.reason === "string" && usage.reason.length > 0 && usage.reason.length <= 256 && !Array.from(usage.reason).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ? { reason: usage.reason } : {}),
      } });
    } else this.emit({ schemaVersion: 1, localCloseUnconfirmed: true });
  }
  private finalize(): void {
    if (this.finalized) return;
    const now = this.now(); this.speech.transition(false, now); this.active.finish(now);
    this.finalized = true; this.stop();
  }
  private stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer); this.timer = undefined;
    globalThis.document?.removeEventListener("visibilitychange", this.onVisibility);
  }
  async noProvider(): Promise<void> {
    this.finalize(); this.discarded = true;
    await this.work; await this.outbox.noProvider(this.localId, this.conversationId);
  }
  private finalAppSent = false;
  private finalAppScheduled = false;
  private snapshot(): AppMetricsReport {
    return { activityReportSeq: ++this.sequence, measurementVersion: "active-time-v1", ...this.active.snapshot(this.now()),
      ...this.speech.snapshot(), speechMeasurementVersion: "vam-pre-tail-v1", appMetricsFinalized: this.finalized, counters: { ...this.counters },
      ...(this.providerStartedObservedAt !== undefined ? { providerStartedObservedAt: this.providerStartedObservedAt } : {}),
      ...(this.interpreterReadyObservedAt !== undefined ? { interpreterReadyObservedAt: this.interpreterReadyObservedAt } : {}),
      ...(this.readyCheckpoint !== undefined ? { lastCheckpointAtInterpreterReady: this.readyCheckpoint } : {}),
    };
  }
  private emit(report: UsageReport): void {
    if (this.discarded) return;
    const finishedNow = this.finalized && !this.finalAppScheduled;
    if (!this.finalized) report.app = this.snapshot();
    // Freeze time synchronously, but let synchronous teardown/product callbacks record their outcome.
    // Do not wait for earlier IDB/network delivery to choose the final measurement cut.
    const finalApp = finishedNow ? Promise.resolve().then(() => { this.finalAppSent = true; return this.snapshot(); }) : undefined;
    if (finishedNow) this.finalAppScheduled = true;
    this.work = this.work.then(async () => {
      if (finalApp) report.app = await finalApp;
      await this.outbox.enqueue(this.localId, this.conversationId, report);
      if (finishedNow) await this.outbox.finishProducer(this.localId, this.conversationId);
    }).catch(() => { console.error("Usage delivery metadata degraded", { localId: this.localId }); });
  }
  idle(): Promise<void> { return this.work; }
}
