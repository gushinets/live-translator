import { CLIENT_BUILD_ID } from "../config/BuildInfo";
import type { DiagnosticData, DiagnosticEvent, DiagnosticPolicy, DiagnosticReceipt, DiagnosticSink, DiagnosticType } from "../../../../types/diagnostics.js";
export type { DiagnosticSink, DiagnosticData } from "../../../../types/diagnostics.js";

export const DIAGNOSTIC_TEXT_KEY = "liveTranslatorDiagnosticText";
const MAX_BYTES = 5 * 1024 * 1024, TTL_MS = 86400000;
export interface DiagnosticQueueRow { key: string; event: DiagnosticEvent; queuedAt: number; bytes: number }
export interface DiagnosticQueue {
  put(row: DiagnosticQueueRow): Promise<{ expired: DiagnosticQueueRow[]; overflow: DiagnosticQueueRow[] }>;
  read(): Promise<DiagnosticQueueRow[]>;
  remove(keys: string[]): Promise<void>;
}

/** This database never shares a transaction or capacity reservation with accounting/recovery. */
export class IndexedDiagnosticQueue implements DiagnosticQueue {
  private database: Promise<IDBDatabase> | undefined;
  constructor(private readonly maxBytes = MAX_BYTES, private readonly now = () => Date.now()) {}
  private open(): Promise<IDBDatabase> {
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("live-translator-diagnostics-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("events", { keyPath: "key" });
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); this.database = undefined; }; resolve(request.result); };
      request.onerror = () => { this.database = undefined; reject(new Error("diagnostics_storage_unavailable")); };
      request.onblocked = () => { this.database = undefined; reject(new Error("diagnostics_storage_blocked")); };
    });
  }
  async put(row: DiagnosticQueueRow): Promise<{ expired: DiagnosticQueueRow[]; overflow: DiagnosticQueueRow[] }> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("events", "readwrite"), store = tx.objectStore("events");
      const request = store.getAll(); const expired: DiagnosticQueueRow[] = [], overflow: DiagnosticQueueRow[] = [];
      request.onsuccess = () => {
        const rows = (request.result as DiagnosticQueueRow[]).filter(old => old.key !== row.key).sort((a, b) => a.queuedAt - b.queuedAt);
        let bytes = rows.reduce((sum, old) => sum + old.bytes, 0) + row.bytes;
        for (const old of rows) {
          const stale = old.queuedAt + TTL_MS <= this.now();
          if (stale || bytes > this.maxBytes) { store.delete(old.key); bytes -= old.bytes; (stale ? expired : overflow).push(old); }
        }
        if (row.bytes <= this.maxBytes) store.put(row); else overflow.push(row);
      };
      tx.oncomplete = () => resolve({ expired, overflow });
      tx.onabort = () => reject(new Error("diagnostics_storage_unavailable"));
      tx.onerror = () => reject(new Error("diagnostics_storage_unavailable"));
    });
  }
  async read(): Promise<DiagnosticQueueRow[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("events"), request = tx.objectStore("events").getAll();
      tx.oncomplete = () => resolve((request.result as DiagnosticQueueRow[]).sort((a, b) => a.queuedAt - b.queuedAt || a.event.seq - b.event.seq));
      tx.onabort = () => reject(new Error("diagnostics_storage_unavailable"));
      tx.onerror = () => reject(new Error("diagnostics_storage_unavailable"));
    });
  }
  async remove(keys: string[]): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("events", "readwrite");
      for (const key of keys) tx.objectStore("events").delete(key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error("diagnostics_storage_unavailable"));
      tx.onerror = () => reject(new Error("diagnostics_storage_unavailable"));
    });
  }
}

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function textOptedIn(): boolean {
  try { return sessionStorage.getItem(DIAGNOSTIC_TEXT_KEY) === "1"; } catch { return false; }
}
export class DiagnosticOutbox {
  policy: DiagnosticPolicy | undefined;
  private readonly queue: DiagnosticQueue;
  private readonly volatile = new Map<string, DiagnosticQueueRow>();
  private readonly streams = new Map<string, DiagnosticStream>();
  private work: Promise<void> = Promise.resolve();
  private flushing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private retryAt = 0;
  private failures = 0;
  private stopped = false;
  private loadPolicy: (() => Promise<DiagnosticPolicy | undefined>) | undefined;
  private policyWork: Promise<void> | undefined;
  private lastWarningAt = -Infinity;
  constructor(private readonly options: { queue?: DiagnosticQueue; fetch?: typeof fetch; automatic?: boolean; now?: () => number } = {}) {
    this.queue = options.queue ?? new IndexedDiagnosticQueue();
  }
  now(): number { return (this.options.now ?? Date.now)(); }
  stream(): DiagnosticStream {
    const stream = new DiagnosticStream(this); this.streams.set(stream.id, stream); return stream;
  }
  start(loadPolicy: () => Promise<DiagnosticPolicy | undefined>): void {
    this.loadPolicy = loadPolicy;
    this.activate();
  }
  configure(policy?: DiagnosticPolicy): void {
    if (this.stopped) return;
    this.policy = policy?.schemaVersion === 1 ? policy : { enabled: false, textEnabled: false, schemaVersion: 1 };
    for (const stream of this.streams.values()) stream.drain();
    this.activate();
  }
  private activate(): void {
    if (this.timer || this.options.automatic === false || this.stopped) return;
    this.timer = setInterval(this.wake, 2000);
    globalThis.addEventListener?.("online", this.wake);
    globalThis.addEventListener?.("pagehide", this.pagehide);
    globalThis.document?.addEventListener("visibilitychange", this.wake);
    this.wake();
  }
  private readonly wake = () => {
    if (this.stopped || this.now() < this.retryAt) return;
    if (!this.policy && this.loadPolicy && !this.policyWork) this.policyWork = Promise.resolve().then(() => this.loadPolicy!())
      .then(policy => this.configure(policy)).catch(() => this.failed(new Error("policy_unavailable")))
      .finally(() => { this.policyWork = undefined; });
    void this.flush();
  };
  private readonly pagehide = () => { void this.flush(true); };
  stop(): void {
    this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    globalThis.removeEventListener?.("online", this.wake); globalThis.removeEventListener?.("pagehide", this.pagehide);
    globalThis.document?.removeEventListener("visibilitychange", this.wake);
  }
  enqueue(event: DiagnosticEvent): void {
    if (!this.policy?.enabled) return;
    const urgent = event.type === "app.state" && ["ending", "ended", "error"].includes(event.data.to) ||
      event.type === "transport.event" && ["error", "invalid"].includes(event.data.type) ||
      event.type === "audio.state" && ["buffer_error", "decoder_error", "capture_failed"].includes(event.data.phase);
    this.work = this.work.then(async () => {
      const row = { key: `${event.streamId}:${event.seq}`, event, queuedAt: this.now(), bytes: bytesOf(event) + 128 };
      try {
        const loss = await this.queue.put(row);
        if (event.type !== "diagnostic.loss") {
          this.lossRows(loss.expired, "expired");
          this.lossRows(loss.overflow, "queue_overflow");
        }
      } catch {
        this.volatile.set(row.key, row);
        let size = [...this.volatile.values()].reduce((sum, value) => sum + value.bytes, 0);
        const lost: DiagnosticQueueRow[] = [];
        for (const [key, value] of this.volatile) {
          if (size <= MAX_BYTES) break;
          this.volatile.delete(key); size -= value.bytes; lost.push(value);
        }
        // One marker per degradation episode, rather than one per failed IndexedDB operation.
        if (event.type !== "diagnostic.loss" && this.volatile.size === 1) this.loss(event, "storage_unavailable", 1);
        if (event.type !== "diagnostic.loss") this.lossRows(lost, "queue_overflow");
      }
    }).catch(() => console.error("Conversation diagnostics incomplete"));
    if (urgent) void this.work.then(() => this.flush());
  }
  private loss(event: DiagnosticEvent, reason: DiagnosticData["diagnostic.loss"]["reason"], count: number): void {
    let stream = this.streams.get(event.streamId);
    if (!stream) { stream = this.stream(); stream.bind(event.conversationId, event.liveSessionId); }
    stream.emit("diagnostic.loss", { reason, count, affectedStreamId: event.streamId });
  }
  private lossRows(rows: DiagnosticQueueRow[], reason: DiagnosticData["diagnostic.loss"]["reason"]): void {
    const groups = new Map<string, { event: DiagnosticEvent; count: number }>();
    for (const { event } of rows) {
      if (event.type === "diagnostic.loss") continue;
      const key = `${event.conversationId}:${event.liveSessionId ?? ""}:${event.streamId}`;
      const group = groups.get(key) ?? { event, count: 0 }; group.count++; groups.set(key, group);
    }
    for (const { event, count } of groups.values()) this.loss(event, reason, count);
  }
  private failed(error: unknown): void {
    this.retryAt = this.now() + Math.min(30000, 1000 * 2 ** Math.min(++this.failures, 5));
    if (this.now() - this.lastWarningAt < 60000) return;
    this.lastWarningAt = this.now();
    const code = error instanceof Error && ["diagnostics_ack_storage_failed", "diagnostics_storage_unavailable", "policy_unavailable"].includes(error.message) ? error.message : "delivery_failed";
    console.error("Conversation diagnostics retry scheduled", { code });
  }
  flush(keepalive = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.flushing ??= this.runFlush(keepalive).catch(error => this.failed(error)).finally(() => { this.flushing = undefined; });
  }
  private async runFlush(keepalive: boolean): Promise<void> {
    await this.work;
    let rows: DiagnosticQueueRow[];
    try { rows = await this.queue.read(); } catch { rows = []; this.failed(new Error("diagnostics_storage_unavailable")); }
    const merged = new Map(rows.map(row => [row.key, row]));
    for (const [key, row] of this.volatile) merged.set(key, row);
    rows = [...merged.values()];
    const expired = rows.filter(row => row.queuedAt + TTL_MS <= this.now());
    if (expired.length) {
      await this.remove(expired);
      this.lossRows(expired, "expired");
    }
    rows = rows.filter(row => row.queuedAt + TTL_MS > this.now());
    if (this.policy && (!this.policy.enabled || !this.policy.textEnabled || !textOptedIn())) {
      for (const row of rows) {
        if (row.event.text === undefined && row.event.textTruncated === undefined) continue;
        delete row.event.text; delete row.event.textTruncated; row.bytes = bytesOf(row.event) + 128;
        try { const lost = await this.queue.put(row); this.lossRows(lost.expired, "expired"); this.lossRows(lost.overflow, "queue_overflow"); }
        catch { this.volatile.set(row.key, row); this.failed(new Error("diagnostics_storage_unavailable")); }
      }
    }
    if (!this.policy?.enabled || this.stopped) return;
    const first = rows[0]; if (!first) return;
    const batch: DiagnosticQueueRow[] = [];
    for (const row of rows) {
      if (row.event.conversationId !== first.event.conversationId) continue;
      if (batch.length === 100) break;
      const candidate = { schemaVersion: 1, events: [...batch.map(value => value.event), row.event] };
      if (bytesOf(candidate) > 32768) {
        if (!batch.length) { await this.remove([row]); this.loss(row.event, "oversize", 1); }
        break;
      }
      batch.push(row);
    }
    if (!batch.length) return;
    const sentAt = this.now();
    const sentMono = performance.now();
    const response = await (this.options.fetch ?? fetch)(`/api/conversations/${encodeURIComponent(first.event.conversationId)}/diagnostics`, {
      method: "POST", credentials: "same-origin", keepalive, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, events: batch.map(row => row.event) }), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      if ([400, 401, 403, 404, 409, 410, 413, 507].includes(response.status)) {
        await this.remove(batch);
        const reason = response.status === 507 ? "server_limit" : response.status === 410 ? "expired" :
          [401, 403, 404].includes(response.status) ? "identity_lost" : "invalid_event";
        this.lossRows(batch, reason);
        if ([401, 403, 404, 507].includes(response.status)) {
          // Never relabel an old owner's queue with a new cookie/conversation.
          for (const stream of this.streams.values()) if (stream.conversationId === first.event.conversationId) stream.disable();
          await this.remove(rows.filter(row => row.event.conversationId === first.event.conversationId));
        }
      }
      throw new Error("diagnostics_delivery_failed");
    }
    const receipt = await response.json() as DiagnosticReceipt;
    if (receipt.schemaVersion !== 1 || !Array.isArray(receipt.accepted) || !Number.isFinite(receipt.serverTime)) throw new Error("invalid_diagnostics_receipt");
    const accepted = new Set(receipt.accepted.map(row => `${row.streamId}:${row.seq}`));
    const committed = batch.filter(row => accepted.has(row.key));
    await this.remove(committed);
    const receivedAt = this.now(); this.retryAt = 0; this.failures = 0;
    const roundtrip = Math.max(0, performance.now() - sentMono);
    const wallAdjustment = Math.abs(receivedAt - sentAt - roundtrip);
    for (const streamId of new Set(committed.map(row => row.event.streamId)))
      this.streams.get(streamId)?.clock(receipt.serverTime - (sentAt + receivedAt) / 2, (roundtrip + wallAdjustment) / 2);
  }
  private async remove(rows: DiagnosticQueueRow[]): Promise<void> {
    const volatileOnly = rows.every(row => this.volatile.has(row.key));
    for (const row of rows) this.volatile.delete(row.key);
    try { await this.queue.remove(rows.map(row => row.key)); }
    catch { if (!volatileOnly) throw new Error("diagnostics_ack_storage_failed"); }
  }
}

/** One immutable transport scope. Pending startup metadata is bounded before server identity exists. */
export class DiagnosticStream implements DiagnosticSink {
  readonly id = crypto.randomUUID();
  conversationId: string | undefined;
  private liveSessionId: string | undefined;
  private seq = 0;
  private disabled = false;
  private readonly pending: Array<Omit<DiagnosticEvent, "conversationId">> = [];
  private pendingBytes = 0;
  private lost = 0;
  private clockRecorded = false;
  get enabled(): boolean { return !this.disabled && this.outbox.policy?.enabled === true; }
  constructor(private readonly outbox: DiagnosticOutbox) {}
  bind(conversationId: string, liveSessionId?: string): void {
    if (this.conversationId && (this.conversationId !== conversationId || this.liveSessionId !== liveSessionId)) { this.disable(); return; }
    this.conversationId = conversationId; this.liveSessionId = liveSessionId; this.drain();
  }
  disable(): void { this.disabled = true; this.pending.length = 0; this.pendingBytes = 0; }
  emit<K extends DiagnosticType>(type: K, data: DiagnosticData[K], text?: string): void {
    try {
      if (this.disabled || this.outbox.policy?.enabled === false || type.startsWith("server.")) return;
      const includeText = this.outbox.policy?.textEnabled && ["transcript.fragment", "caption.block"].includes(type) && text !== undefined && textOptedIn();
      const event = { schemaVersion: 1 as const, source: "browser" as const, streamId: this.id, seq: ++this.seq,
        wallMs: this.outbox.now(), monoMs: performance.now(), type, data: JSON.parse(JSON.stringify(data)), clientBuildId: CLIENT_BUILD_ID,
        ...(includeText ? { text: text.slice(0, 4096), ...(text.length > 4096 ? { textTruncated: true } : {}) } : {}) };
      if (this.conversationId && this.outbox.policy?.enabled) this.outbox.enqueue({ ...event, conversationId: this.conversationId, ...(this.liveSessionId ? { liveSessionId: this.liveSessionId } : {}) } as DiagnosticEvent);
      else {
        const bytes = bytesOf(event);
        if (bytes > 65536) { this.lost++; return; }
        this.pending.push(event as Omit<DiagnosticEvent, "conversationId">); this.pendingBytes += bytes;
        while (this.pending.length > 200 || this.pendingBytes > 65536) { this.pendingBytes -= bytesOf(this.pending.shift()!); this.lost++; }
      }
    } catch { /* Observability must never throw into audio, rendering or transport callbacks. */ }
  }
  drain(): void {
    if (this.outbox.policy?.enabled === false) { this.disable(); return; }
    if (!this.conversationId || !this.outbox.policy?.enabled || this.disabled) return;
    for (const event of this.pending.splice(0)) this.outbox.enqueue({ ...event, conversationId: this.conversationId, ...(this.liveSessionId ? { liveSessionId: this.liveSessionId } : {}) } as DiagnosticEvent);
    this.pendingBytes = 0;
    if (this.lost) { const count = this.lost; this.lost = 0; this.emit("diagnostic.loss", { reason: "queue_overflow", count }); }
  }
  clock(offsetMs: number, uncertaintyMs: number): void {
    if (this.clockRecorded) return; this.clockRecorded = true;
    this.emit("diagnostic.clock", { offsetMs, uncertaintyMs });
  }
}
