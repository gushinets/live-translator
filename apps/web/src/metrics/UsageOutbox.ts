import { MetadataDeliveryBudget, attemptKey } from "../session/MetadataDeliveryBudget";
import { coalesceUsage, type UsageReport, type UsageReceipt } from "./UsageTypes";
export interface UsageTransport {
  usage(localId: string, conversationId: string, report: UsageReport, keepalive?: boolean): Promise<UsageReceipt>;
  readConversation(conversationId: string): Promise<unknown>;
}
const statusOf = (error: unknown) => error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
const USAGE_TTL = 7 * 86400000;
interface VolatileReport { localId: string; conversationId: string; report: UsageReport; expiresAt: number | undefined; persisted: boolean; delivered: boolean; }
interface AttemptIdentity { localId: string; conversationId: string; }

/** Delivery is independent of the current conversation, transport and product generation. */
export class UsageOutbox {
  private readonly volatile = new Map<string, VolatileReport>();
  private readonly reservationExpiry = new Map<string, number>();
  private readonly pendingFinalization = new Map<string, AttemptIdentity>();
  private readonly pendingDiscard = new Map<string, AttemptIdentity>();
  private flushing: Promise<void> | null = null;
  private revision = 0;
  private started = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly budget: MetadataDeliveryBudget, private readonly transport: UsageTransport,
    private readonly anomaly: (code: string) => void = code => console.error("Usage delivery anomaly", { code })) {}
  async enqueue(localId: string, conversationId: string, report: UsageReport): Promise<void> {
    const key = attemptKey(conversationId, localId), old = this.volatile.get(key);
    let expiresAt = old?.expiresAt ?? this.reservationExpiry.get(key);
    if (expiresAt === undefined) {
      try { const row = await this.budget.get(localId); expiresAt = row?.conversationId === conversationId ? row.usage?.expiresAt ?? row.reservedAt + USAGE_TTL : Date.now(); }
      catch { /* Keep the report until its original reservation expiry can be recovered. */ }
    }
    const pending: VolatileReport = { localId, conversationId, report: coalesceUsage(old?.report, report), expiresAt, persisted: false, delivered: false };
    this.volatile.set(key, pending);
    try { await this.budget.enqueueUsage(localId, conversationId, pending.report); pending.persisted = true; }
    catch {
      // Only already-reserved attempts use this object. New creation still fails closed in PR2.
      this.anomaly("usage_storage_degraded");
    }
    this.revision++; if (this.started) this.onWake();
  }
  async finishProducer(localId: string, conversationId: string): Promise<void> {
    const key = attemptKey(conversationId, localId);
    this.pendingFinalization.set(key, { localId, conversationId });
    const shadow = this.volatile.get(key);
    if (shadow && !shadow.persisted && !shadow.delivered) { this.revision++; if (this.started) this.onWake(); return; }
    try {
      await this.budget.finishUsageProducer(localId, conversationId);
      if (shadow?.delivered && this.volatile.get(key) === shadow) this.volatile.delete(key);
    }
    catch { this.anomaly("usage_finalization_storage_degraded"); this.revision++; if (this.started) this.onWake(); return; }
    this.pendingFinalization.delete(key);
  }
  async noProvider(localId: string, conversationId: string): Promise<void> {
    const key = attemptKey(conversationId, localId);
    this.pendingFinalization.delete(key);
    this.volatile.delete(key);
    this.pendingDiscard.set(key, { localId, conversationId });
    try { await this.budget.discardUsage(localId, conversationId); this.pendingDiscard.delete(key); }
    catch { this.anomaly("usage_no_provider_storage_degraded"); this.revision++; if (this.started) { this.onWake(); this.schedule(); } }
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
      const receipt = await this.transport.usage(id, conversationId, report, globalThis.document?.visibilityState === "hidden");
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
    for (const [key, { localId, conversationId }] of this.pendingFinalization) {
      const shadow = this.volatile.get(key);
      if (shadow && !shadow.persisted && !shadow.delivered) { pending = true; continue; }
      try {
        await this.budget.finishUsageProducer(localId, conversationId);
        if (shadow?.delivered && this.volatile.get(key) === shadow) this.volatile.delete(key);
        this.pendingFinalization.delete(key);
      }
      catch { this.anomaly("usage_finalization_storage_degraded"); pending = true; }
    }
    for (const [key, { localId, conversationId }] of this.pendingDiscard) {
      try {
        await this.budget.discardUsage(localId, conversationId); this.pendingDiscard.delete(key);
        this.pendingFinalization.delete(key); this.volatile.delete(key);
      }
      catch { this.anomaly("usage_no_provider_storage_degraded"); pending = true; }
    }
    let storageAvailable = true;
    try {
      const rows = await this.budget.entries();
      const live = new Set(rows.map(row => attemptKey(row.conversationId, row.localId)));
      for (const key of this.reservationExpiry.keys()) if (!live.has(key)) this.reservationExpiry.delete(key);
      for (const [key, shadow] of this.volatile) if (shadow.expiresAt === undefined && !live.has(key)) shadow.expiresAt = Date.now();
      for (const row of rows) {
        const key = attemptKey(row.conversationId, row.localId);
        const expiresAt = row.usage?.expiresAt ?? row.reservedAt + USAGE_TTL;
        this.reservationExpiry.set(key, expiresAt);
        if (this.pendingDiscard.has(key)) continue;
        if (row.producerOutcome === "no_provider") {
          this.pendingDiscard.set(key, { localId: row.localId, conversationId: row.conversationId });
          await this.budget.discardUsage(row.localId, row.conversationId);
          this.pendingDiscard.delete(key); this.pendingFinalization.delete(key); this.volatile.delete(key);
          continue;
        }
        let queued = row.usage;
        let shadow = this.volatile.get(key);
        if (shadow && shadow.expiresAt === undefined) shadow.expiresAt = expiresAt;
        if (shadow?.delivered) {
          if (queued) await this.budget.acknowledgeUsage(row.localId, row.conversationId, queued.revision);
          if (this.volatile.get(key) === shadow) this.volatile.delete(key);
          continue;
        }
        if (shadow && !shadow.persisted) {
          await this.budget.enqueueUsage(row.localId, row.conversationId, shadow.report);
          if (this.volatile.get(key) === shadow) shadow.persisted = true;
          const current = await this.budget.get(row.localId);
          queued = current?.conversationId === row.conversationId ? current.usage : null;
        }
        if (!queued) {
          if (row.usagePending && row.usageProducerFinalized !== true && row.producerFinalized && Date.now() >= row.reservedAt + 7 * 86400000) {
            this.anomaly("usage_delivery_expired");
            await this.budget.discardUsage(row.localId, row.conversationId);
          }
          if (this.volatile.get(key) === shadow) this.volatile.delete(key);
          continue;
        }
        shadow ??= { localId: row.localId, conversationId: row.conversationId, report: queued.report, expiresAt: queued.expiresAt, persisted: true, delivered: false };
        if (Date.now() >= queued.expiresAt) {
          this.anomaly("usage_delivery_expired"); this.pendingDiscard.set(key, { localId: row.localId, conversationId: row.conversationId });
          this.pendingFinalization.delete(key);
          await this.budget.discardUsage(row.localId, row.conversationId, queued.revision); this.pendingDiscard.delete(key);
          if (this.volatile.get(key) === shadow) this.volatile.delete(key);
          continue;
        }
        const outcome = await this.send(row.localId, shadow.conversationId, shadow.report);
        if (outcome === "ack") {
          shadow.delivered = true;
          await this.budget.acknowledgeUsage(row.localId, row.conversationId, queued.revision);
          if (this.volatile.get(key) === shadow) this.volatile.delete(key);
        } else if (outcome === "lost") {
          this.pendingDiscard.set(key, { localId: row.localId, conversationId: row.conversationId });
          this.pendingFinalization.delete(key);
          await this.budget.discardUsage(row.localId, row.conversationId, queued.revision); this.pendingDiscard.delete(key);
          if (this.volatile.get(key) === shadow) this.volatile.delete(key);
        }
        else pending = true;
      }
    } catch { this.anomaly("usage_storage_degraded"); pending = true; storageAvailable = false; }
    for (const [key, row] of [...this.volatile]) {
      if (this.pendingDiscard.has(key) || row.delivered || (storageAvailable && row.persisted)) continue;
      if (row.expiresAt === undefined) { pending = true; continue; }
      if (Date.now() >= row.expiresAt) { this.anomaly("usage_volatile_expired"); this.pendingDiscard.set(key, { localId: row.localId, conversationId: row.conversationId }); this.pendingFinalization.delete(key); if (this.volatile.get(key) === row) this.volatile.delete(key); pending = true; continue; }
      const outcome = await this.send(row.localId, row.conversationId, row.report);
      if (outcome === "ack" && this.volatile.get(key) === row) row.delivered = true;
      else if (outcome === "lost" && this.volatile.get(key) === row) { this.pendingDiscard.set(key, { localId: row.localId, conversationId: row.conversationId }); this.pendingFinalization.delete(key); this.volatile.delete(key); }
      if (outcome === "retry") pending = true;
      else if (outcome === "ack" || outcome === "lost") pending = true;
    }
    if (pending) { this.schedule(); this.failures++; }
    else { this.failures = 0; if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
  }
}

