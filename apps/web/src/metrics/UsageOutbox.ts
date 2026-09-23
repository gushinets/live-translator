import { MetadataDeliveryBudget } from "../session/MetadataDeliveryBudget";
import { coalesceUsage, type UsageReport, type UsageReceipt } from "./UsageTypes";
export interface UsageTransport {
  usage(localId: string, report: UsageReport, keepalive?: boolean): Promise<UsageReceipt>;
  readConversation(conversationId: string): Promise<unknown>;
}
const statusOf = (error: unknown) => error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
interface VolatileReport { conversationId: string; report: UsageReport; expiresAt: number; persisted: boolean; delivered: boolean; }

/** Delivery is independent of the current conversation, transport and product generation. */
export class UsageOutbox {
  private readonly volatile = new Map<string, VolatileReport>();
  private readonly pendingFinalization = new Set<string>();
  private readonly pendingDiscard = new Set<string>();
  private flushing: Promise<void> | null = null;
  private revision = 0;
  private started = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly budget: MetadataDeliveryBudget, private readonly transport: UsageTransport,
    private readonly anomaly: (code: string) => void = code => console.error("Usage delivery anomaly", { code })) {}
  async enqueue(localId: string, conversationId: string, report: UsageReport): Promise<void> {
    const old = this.volatile.get(localId);
    const pending: VolatileReport = { conversationId, report: coalesceUsage(old?.report, report), expiresAt: old?.expiresAt ?? Date.now() + 7 * 86400000, persisted: false, delivered: false };
    this.volatile.set(localId, pending);
    try { await this.budget.enqueueUsage(localId, pending.report); pending.persisted = true; }
    catch {
      // Only already-reserved attempts use this object. New creation still fails closed in PR2.
      this.anomaly("usage_storage_degraded");
    }
    this.revision++; if (this.started) this.onWake();
  }
  async finishProducer(localId: string): Promise<void> {
    this.pendingFinalization.add(localId);
    const shadow = this.volatile.get(localId);
    if (shadow && !shadow.persisted && !shadow.delivered) { this.revision++; if (this.started) this.onWake(); return; }
    try {
      await this.budget.finishUsageProducer(localId);
      if (shadow?.delivered && this.volatile.get(localId) === shadow) this.volatile.delete(localId);
    }
    catch { this.anomaly("usage_finalization_storage_degraded"); this.revision++; if (this.started) this.onWake(); return; }
    this.pendingFinalization.delete(localId);
  }
  async noProvider(localId: string): Promise<void> {
    this.pendingFinalization.delete(localId);
    this.volatile.delete(localId);
    this.pendingDiscard.add(localId);
    try { await this.budget.discardUsage(localId); this.pendingDiscard.delete(localId); }
    catch { this.anomaly("usage_no_provider_storage_degraded"); this.revision++; if (this.started) this.onWake(); }
  }
  start(): void {
    if (this.started) return; this.started = true;
    globalThis.addEventListener?.("online", this.onWake);
    globalThis.document?.addEventListener("visibilitychange", this.onWake); this.onWake();
  }
  stop(): void {
    this.started = false; if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined;
    globalThis.removeEventListener?.("online", this.onWake); globalThis.document?.removeEventListener("visibilitychange", this.onWake);
  }
  private readonly onWake = () => { void this.flush().catch(() => { this.anomaly("usage_delivery_failed"); this.schedule(); }); };
  private schedule(): void {
    if (!this.started || this.timer !== undefined) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.failures, 5));
    this.timer = setTimeout(() => { this.timer = undefined; this.onWake(); }, Math.round(delay * (0.8 + Math.random() * 0.2)));
  }
  flush(): Promise<void> {
    this.flushing ??= (async () => {
      let revision: number;
      do { revision = this.revision; await this.deliver(); } while (revision !== this.revision);
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  private async send(id: string, conversationId: string, report: UsageReport): Promise<"ack" | "lost" | "retry"> {
    try {
      const receipt = await this.transport.usage(id, report, globalThis.document?.visibilityState === "hidden");
      if (receipt.schemaVersion !== 1 || typeof receipt.appAccepted !== "boolean") return "retry";
      if (!receipt.appAccepted) this.anomaly("usage_app_report_rejected"); // Provider merge still committed.
      return "ack";
    } catch (error) {
      if ([401, 403, 404].includes(statusOf(error))) {
        try { await this.transport.readConversation(conversationId); }
        catch (readError) {
          if ([401, 404].includes(statusOf(readError))) { this.anomaly("usage_identity_lost"); return "lost"; }
        }
      }
      return "retry";
    }
  }
  private async deliver(): Promise<void> {
    let pending = false;
    for (const id of this.pendingFinalization) {
      const shadow = this.volatile.get(id);
      if (shadow && !shadow.persisted && !shadow.delivered) { pending = true; continue; }
      try {
        await this.budget.finishUsageProducer(id);
        if (shadow?.delivered && this.volatile.get(id) === shadow) this.volatile.delete(id);
        this.pendingFinalization.delete(id);
      }
      catch { this.anomaly("usage_finalization_storage_degraded"); pending = true; }
    }
    for (const id of this.pendingDiscard) {
      try {
        await this.budget.discardUsage(id); this.pendingDiscard.delete(id);
        this.pendingFinalization.delete(id); this.volatile.delete(id);
      }
      catch { this.anomaly("usage_no_provider_storage_degraded"); pending = true; }
    }
    let storageAvailable = true;
    try {
      for (const row of await this.budget.entries()) {
        if (this.pendingDiscard.has(row.localId)) continue;
        if (row.producerOutcome === "no_provider") {
          this.pendingDiscard.add(row.localId);
          await this.budget.discardUsage(row.localId);
          this.pendingDiscard.delete(row.localId); this.pendingFinalization.delete(row.localId); this.volatile.delete(row.localId);
          continue;
        }
        let queued = row.usage;
        let shadow = this.volatile.get(row.localId);
        if (shadow?.delivered) {
          if (queued) await this.budget.acknowledgeUsage(row.localId, queued.revision);
          if (this.volatile.get(row.localId) === shadow) this.volatile.delete(row.localId);
          continue;
        }
        if (shadow && !shadow.persisted) {
          await this.budget.enqueueUsage(row.localId, shadow.report);
          if (this.volatile.get(row.localId) === shadow) shadow.persisted = true;
          queued = (await this.budget.get(row.localId))?.usage ?? null;
        }
        if (!queued) {
          if (row.usagePending && row.usageProducerFinalized !== true && row.producerFinalized && Date.now() >= row.reservedAt + 7 * 86400000) {
            this.anomaly("usage_delivery_expired");
            await this.budget.discardUsage(row.localId);
          }
          if (this.volatile.get(row.localId) === shadow) this.volatile.delete(row.localId);
          continue;
        }
        shadow ??= { conversationId: row.conversationId, report: queued.report, expiresAt: queued.expiresAt, persisted: true, delivered: false };
        if (Date.now() >= queued.expiresAt) {
          this.anomaly("usage_delivery_expired"); this.pendingDiscard.add(row.localId);
          this.pendingFinalization.delete(row.localId);
          await this.budget.discardUsage(row.localId, queued.revision); this.pendingDiscard.delete(row.localId);
          if (this.volatile.get(row.localId) === shadow) this.volatile.delete(row.localId);
          continue;
        }
        const outcome = await this.send(row.localId, shadow.conversationId, shadow.report);
        if (outcome === "ack") {
          shadow.delivered = true;
          await this.budget.acknowledgeUsage(row.localId, queued.revision);
          if (this.volatile.get(row.localId) === shadow) this.volatile.delete(row.localId);
        } else if (outcome === "lost") {
          this.pendingDiscard.add(row.localId);
          this.pendingFinalization.delete(row.localId);
          await this.budget.discardUsage(row.localId, queued.revision); this.pendingDiscard.delete(row.localId);
          if (this.volatile.get(row.localId) === shadow) this.volatile.delete(row.localId);
        }
        else pending = true;
      }
    } catch { this.anomaly("usage_storage_degraded"); pending = true; storageAvailable = false; }
    for (const [id, row] of [...this.volatile]) {
      if (this.pendingDiscard.has(id) || row.delivered || (storageAvailable && row.persisted)) continue;
      if (Date.now() >= row.expiresAt) { this.anomaly("usage_volatile_expired"); this.pendingDiscard.add(id); this.pendingFinalization.delete(id); if (this.volatile.get(id) === row) this.volatile.delete(id); pending = true; continue; }
      const outcome = await this.send(id, row.conversationId, row.report);
      if (outcome === "ack" && this.volatile.get(id) === row) row.delivered = true;
      else if (outcome === "lost" && this.volatile.get(id) === row) { this.pendingDiscard.add(id); this.pendingFinalization.delete(id); this.volatile.delete(id); }
      if (outcome === "retry") pending = true;
      else if (outcome === "ack" || outcome === "lost") pending = true;
    }
    if (pending) { this.schedule(); this.failures++; }
    else { this.failures = 0; if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
  }
}

