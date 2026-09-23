import { MetadataDeliveryBudget } from "../session/MetadataDeliveryBudget";
import { coalesceUsage, type UsageReport, type UsageReceipt } from "./UsageTypes";
export interface UsageTransport {
  usage(localId: string, report: UsageReport, keepalive?: boolean): Promise<UsageReceipt>;
  readConversation(conversationId: string): Promise<unknown>;
}
const statusOf = (error: unknown) => error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
interface VolatileReport { conversationId: string; report: UsageReport; expiresAt: number; }

/** Delivery is independent of the current conversation, transport and product generation. */
export class UsageOutbox {
  private readonly volatile = new Map<string, VolatileReport>();
  private flushing: Promise<void> | null = null;
  private revision = 0;
  private started = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly budget: MetadataDeliveryBudget, private readonly transport: UsageTransport,
    private readonly anomaly: (code: string) => void = code => console.error("Usage delivery anomaly", { code })) {}
  async enqueue(localId: string, conversationId: string, report: UsageReport): Promise<void> {
    try { await this.budget.enqueueUsage(localId, report); }
    catch {
      // Only already-reserved attempts use this object. New creation still fails closed in PR2.
      this.anomaly("usage_storage_degraded");
      const old = this.volatile.get(localId);
      this.volatile.set(localId, { conversationId, report: coalesceUsage(old?.report, report), expiresAt: old?.expiresAt ?? Date.now() + 7 * 86400000 });
    }
    this.revision++; if (this.started) this.onWake();
  }
  async finishProducer(localId: string): Promise<void> {
    try { await this.budget.finishUsageProducer(localId); }
    catch { this.anomaly("usage_finalization_storage_degraded"); }
  }
  async noProvider(localId: string): Promise<void> {
    this.volatile.delete(localId);
    try { await this.budget.discardUsage(localId); } catch { this.anomaly("usage_no_provider_storage_degraded"); }
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
    try {
      for (const row of await this.budget.entries()) {
        if (!row.usage) continue;
        if (Date.now() >= row.usage.expiresAt) { this.anomaly("usage_delivery_expired"); await this.budget.discardUsage(row.localId, row.usage.revision); continue; }
        const outcome = await this.send(row.localId, row.conversationId, row.usage.report);
        if (outcome === "ack") await this.budget.acknowledgeUsage(row.localId, row.usage.revision);
        else if (outcome === "lost") await this.budget.discardUsage(row.localId, row.usage.revision);
        else pending = true;
      }
    } catch { this.anomaly("usage_storage_degraded"); pending = true; }
    for (const [id, row] of [...this.volatile]) {
      if (Date.now() >= row.expiresAt) { this.anomaly("usage_volatile_expired"); if (this.volatile.get(id) === row) this.volatile.delete(id); continue; }
      const outcome = await this.send(id, row.conversationId, row.report);
      if (outcome !== "retry" && this.volatile.get(id) === row) this.volatile.delete(id);
      if (outcome === "retry") pending = true;
    }
    if (pending) { this.schedule(); this.failures++; }
    else { this.failures = 0; if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
  }
}
