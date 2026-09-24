import { MetadataDeliveryBudget, METADATA_TTL_MS, type CleanupReason, type CloseMetadata, type EndIntent } from "./MetadataDeliveryBudget";
export const producerLeaseKey = (id: string) => `live-metadata-producer:${id}`;
export interface AttemptProof {
  cleanupRequestedAt?: number | null; closeConfirmed?: boolean; state?: string; openaiSessionId?: string | null; leaseReleasedAt?: number | null;
}
export interface CleanupTransport {
  cleanup(localId: string, reason: CleanupReason): Promise<AttemptProof>;
  recover?(localId: string, conversationId: string, reason: CleanupReason): Promise<AttemptProof>;
  closed(localId: string, observation: CloseMetadata): Promise<AttemptProof>;
  readAttempt?(localId: string): Promise<AttemptProof>;
  readConversation(conversationId: string): Promise<unknown>;
  end?(id: string, version: number, reason: EndIntent["reason"]): Promise<{ status: string }>;
}
const statusOf = (error: unknown) => typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
export const cleanupProofReceived = (p: AttemptProof) => p.cleanupRequestedAt != null || p.closeConfirmed === true || p.state === "closed" || (p.state === "failed" && !p.openaiSessionId);
export const terminalRetirementProof = (p: AttemptProof) => p.closeConfirmed === true || p.state === "closed" || (p.state === "failed" && !p.openaiSessionId);

/** A durable cleanup marker transfers responsibility. Admission DELETE alone never does. */
export class CleanupIntentOutbox {
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private retries = 0;
  private revision = 0;
  private readonly deferredCleanup = new Set<string>();
  constructor(private readonly budget: MetadataDeliveryBudget, private readonly transport: CleanupTransport,
    private readonly retryPendingFinalizations?: () => Promise<void>,
    private readonly anomaly: (code: string) => void = code => console.error("Metadata delivery anomaly", { code })) {}
  async enqueue(localId: string, reason: CleanupReason): Promise<void> {
    await this.budget.enqueueCleanup(localId, reason);
    this.deferredCleanup.delete(localId);
    try { await this.budget.finishProducer(localId, "lost"); }
    catch (error) { this.revision++; this.schedule(); throw error; }
    this.revision++; this.schedule();
  }
  async observeClosed(localId: string, observation: CloseMetadata): Promise<void> {
    await this.budget.enqueueClose(localId, observation); this.deferredCleanup.delete(localId); this.revision++; this.schedule();
  }
  async enqueueEnd(id: string, version: number, reason: EndIntent["reason"], cleanupLocalIds: readonly string[] = [], closeTimeoutMs = 0): Promise<void> {
    await this.budget.enqueueEnd(id, version, reason, cleanupLocalIds, closeTimeoutMs); this.revision++; this.schedule();
  }
  deferCleanup(localIds: readonly string[]): void { for (const id of localIds) this.deferredCleanup.add(id); }
  confirmRetirement(localId: string): void { this.deferredCleanup.delete(localId); }
  wake(): void { this.revision++; this.onWake(); }
  start(): void {
    if (this.started) return; this.started = true;
    globalThis.addEventListener?.("online", this.onWake); globalThis.document?.addEventListener("visibilitychange", this.onWake); this.onWake();
  }
  stop(): void {
    this.started = false; if (this.timer) clearTimeout(this.timer);
    globalThis.removeEventListener?.("online", this.onWake); globalThis.document?.removeEventListener("visibilitychange", this.onWake);
  }
  private readonly onWake = () => { void this.flush().catch(() => { this.anomaly("storage_unavailable"); this.retries++; this.schedule(); }); };
  private schedule(): void {
    if (!this.started || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.onWake(); }, Math.min(30000, 1000 * 2 ** Math.min(this.retries, 5)));
  }
  private async finishForeignRetirement(localId: string, proof: AttemptProof): Promise<boolean> {
    if (!terminalRetirementProof(proof)) return false;
    await this.budget.finishUsageProducer(localId);
    const outcome = proof.state === "failed" && !proof.openaiSessionId ? "no_provider" : proof.closeConfirmed === true ? "provider_closed" : "lost";
    await this.budget.finishProducerAndRelease(localId, outcome);
    return true;
  }
  flush(): Promise<void> {
    this.flushing ??= (async () => {
      let revision: number;
      do { revision = this.revision; await this.deliver(); } while (revision !== this.revision);
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  private async deliver(): Promise<void> {
    let pending = false;
    try { await this.retryPendingFinalizations?.(); } catch { pending = true; }
    for (const row of await this.budget.entries()) {
      if (!row.producerFinalized && (row.dispatchStartedAt === null || row.cleanupAcknowledged) && !row.cleanup && !row.closeObservation && Date.now() >= row.reservedAt + METADATA_TTL_MS) {
        await this.budget.finishProducerAndRelease(row.localId, row.dispatchStartedAt === null ? "no_provider" : "lost");
        continue;
      }
      if (row.producerOutcome === "no_provider") {
        await this.budget.finishProducerAndRelease(row.localId, "no_provider");
        continue;
      }
      if (!row.cleanup && !row.closeObservation) {
        if (row.producerId !== this.budget.ownerProducerId && row.dispatchStartedAt !== null && !row.producerFinalized &&
            (row.cleanupAcknowledged || !globalThis.navigator?.locks)) {
          try {
            const proof = await this.transport.readAttempt?.(row.localId);
            if (!proof || !(await this.finishForeignRetirement(row.localId, proof))) { pending = true; continue; }
          } catch (error) {
            if (statusOf(error) !== 404 || !this.transport.recover) { pending = true; continue; }
            try {
              const proof = await this.transport.recover(row.localId, row.conversationId, "response_not_received");
              if (!(await this.finishForeignRetirement(row.localId, proof))) pending = true;
            } catch { pending = true; }
          }
        }
        continue;
      }
      if (!row.closeObservation && this.deferredCleanup.has(row.localId)) { pending = true; continue; }
      const deliverRow = async () => {
        if (Date.now() >= (row.cleanup?.expiresAt ?? row.reservedAt + 7 * 86400000)) {
          this.anomaly("metadata_delivery_expired"); await this.discard(row.localId); return;
        }
        try {
          const proof = row.closeObservation ? await this.transport.closed(row.localId, row.closeObservation) : await this.transport.cleanup(row.localId, row.cleanup!.reason);
          if (!cleanupProofReceived(proof)) { pending = true; return; }
          if (row.closeObservation) await this.budget.acknowledgeCloseAndRelease(row.localId);
          else await this.budget.acknowledgeCleanupAndRelease(row.localId);
        } catch (error) {
          // A registration race 404 is retried unless a separate owner/conversation read proves identity loss.
          if ([401, 403, 404].includes(Number(statusOf(error)))) {
            try { await this.transport.readConversation(row.conversationId); }
            catch (readError) {
              if (statusOf(readError) === 401 || statusOf(readError) === 404) { this.anomaly("metadata_identity_lost"); await this.discard(row.localId); return; }
            }
          }
          pending = true;
        }
      };
      // A foreign cleanup marker is replayed through the authoritative server fence.
      // Web Locks only prove the old document is gone; the server fence orders recovery against a late create.
      if (row.cleanup && !row.closeObservation && row.producerId !== this.budget.ownerProducerId) {
        if (Date.now() >= row.cleanup.expiresAt) {
          this.anomaly("metadata_delivery_expired"); await this.discard(row.localId); continue;
        }
        const recoverForeignCleanup = async () => {
          if (!this.transport.recover) { pending = true; return; }
          try {
            const proof = await this.transport.recover(row.localId, row.conversationId, row.cleanup!.reason);
            if (!cleanupProofReceived(proof)) { pending = true; return; }
            await this.budget.acknowledgeForeignCleanupFence(row.localId);
            if (!(await this.finishForeignRetirement(row.localId, proof))) pending = true;
          } catch (error) {
            if ([401, 403, 404].includes(Number(statusOf(error)))) {
              try { await this.transport.readConversation(row.conversationId); }
              catch (readError) {
                if (statusOf(readError) === 401 || statusOf(readError) === 404) {
                  this.anomaly("metadata_identity_lost"); await this.discard(row.localId); return;
                }
              }
            }
            pending = true;
          }
        };
        const locks = globalThis.navigator?.locks;
        if (locks) {
          try {
            await locks.request(producerLeaseKey(row.producerId), { ifAvailable: true }, async lock => {
              if (!lock) { pending = true; return; }
              await recoverForeignCleanup();
            });
          } catch { pending = true; }
        } else await recoverForeignCleanup();
      } else await deliverRow();
    }
    for (const intent of await this.budget.ends()) {
      if (Date.now() >= intent.expiresAt) { this.anomaly("conversation_end_expired"); await this.budget.acknowledgeEnd(intent.conversationId, intent.expectedVersion); continue; }
      const cleanupLocalIds = intent.cleanupLocalIds ?? (await this.budget.entries())
        .filter(row => row.conversationId === intent.conversationId && (row.cleanup || row.closeObservation))
        .map(row => row.localId);
      if (cleanupLocalIds.length > 0) { pending = true; continue; }
      try {
        if (!this.transport.end) { pending = true; continue; }
        const result = await this.transport.end(intent.conversationId, intent.expectedVersion, intent.reason);
        if (result.status === "ended") await this.budget.acknowledgeEnd(intent.conversationId, intent.expectedVersion); else pending = true;
      } catch (error) {
        if ([401, 403, 404, 409].includes(Number(statusOf(error)))) {
          try {
            const c = await this.transport.readConversation(intent.conversationId) as { status?: string; version?: number };
            if (c.status === "ended" || (c.version !== undefined && c.version > intent.expectedVersion)) {
              await this.budget.acknowledgeEnd(intent.conversationId, intent.expectedVersion); continue;
            }
          } catch (readError) {
            if (statusOf(readError) === 401 || statusOf(readError) === 404) {
              this.anomaly("conversation_end_identity_lost"); await this.budget.acknowledgeEnd(intent.conversationId, intent.expectedVersion); continue;
            }
          }
        }
        pending = true;
      }
    }
    this.retries = pending ? this.retries + 1 : 0; if (pending) this.schedule();
  }
  private async discard(localId: string) {
    await this.budget.discardDelivery(localId);
  }
}
