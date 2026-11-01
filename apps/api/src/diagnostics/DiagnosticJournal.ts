import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DiagnosticData, DiagnosticEvent, DiagnosticType } from "../../../../types/diagnostics.js";
import { transaction } from "../persistence/database.js";

export const DIAGNOSTIC_RETENTION_MS = 30 * 86400000;
export const DIAGNOSTIC_TEXT_RETENTION_MS = 7 * 86400000;
export interface DiagnosticConversation { id: string; anonymous_user_id: string; created_at: number }
type ServerLossReason = DiagnosticData["diagnostic.loss"]["reason"];
interface ServerStream { id: string; seq: number; conversation: DiagnosticConversation; liveSessionId?: string; losses: Partial<Record<ServerLossReason, number>> }
interface PendingServerEvent { stream: ServerStream; event: DiagnosticEvent; bytes: number }
/** The current anonymous ID is also a bearer cookie: never copy it into logs or exports. */
export function diagnosticOwnerId(owner: string): string { return `sha256:${createHash("sha256").update(owner).digest("hex")}`; }
export class DiagnosticError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

/** Best effort, isolated from the financial ledger. A receipt is returned only after COMMIT. */
export class DiagnosticJournal {
  readonly db: DatabaseSync;
  private readonly serverStreams = new Map<string, ServerStream>();
  private readonly serverPending: PendingServerEvent[] = [];
  private readonly serverLosses = new Set<ServerStream>();
  private serverQueueBytes = 0;
  private serverDropped = 0;
  private serverWrite: ReturnType<typeof setImmediate> | undefined;
  private serverDrain: Promise<void> | undefined;
  private serverDrainDone: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastWarningAt = -Infinity;
  constructor(path: string, readonly options: { textEnabled?: boolean; maxBytes?: number; conversationMaxBytes?: number; now?: () => number; automatic?: boolean; logger?: Pick<Console, "error"> } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout=0; PRAGMA secure_delete=ON; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=1048576; PRAGMA synchronous=NORMAL;");
      const pageSize = Number(this.db.prepare("PRAGMA page_size").get()!.page_size);
      this.db.exec(`PRAGMA max_page_count=${Math.max(32, Math.floor((options.maxBytes ?? 1073741824) / pageSize))};`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS diagnostic_conversations (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL,
          first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
          browser_bytes INTEGER NOT NULL DEFAULT 0,
          limited INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE INDEX IF NOT EXISTS diagnostic_time ON diagnostic_conversations(last_at,first_at);
        CREATE INDEX IF NOT EXISTS diagnostic_owner ON diagnostic_conversations(owner);
        CREATE TABLE IF NOT EXISTS diagnostic_ingress (
          source_key TEXT NOT NULL, window_start INTEGER NOT NULL, bytes INTEGER NOT NULL,
          PRIMARY KEY(source_key,window_start)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS diagnostic_streams (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, live_session_id TEXT, source TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS diagnostic_events (
          stream_id TEXT NOT NULL, seq INTEGER NOT NULL, conversation_id TEXT NOT NULL,
          live_session_id TEXT, source TEXT NOT NULL, wall_ms INTEGER NOT NULL, mono_ms REAL NOT NULL,
          received_at INTEGER NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL,
          client_build_id TEXT, text_expected INTEGER NOT NULL, text_truncated INTEGER NOT NULL,
          PRIMARY KEY(stream_id,seq)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS diagnostic_conversation_events ON diagnostic_events(conversation_id,received_at);
        CREATE INDEX IF NOT EXISTS diagnostic_conversation_streams ON diagnostic_streams(conversation_id);
        CREATE TABLE IF NOT EXISTS diagnostic_text (
          stream_id TEXT NOT NULL, seq INTEGER NOT NULL, conversation_id TEXT NOT NULL, text TEXT NOT NULL,
          PRIMARY KEY(stream_id,seq)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS diagnostic_conversation_text ON diagnostic_text(conversation_id);
      `);
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('diagnostic_conversations') WHERE name='browser_bytes'").get()) {
        this.db.exec("ALTER TABLE diagnostic_conversations ADD COLUMN browser_bytes INTEGER NOT NULL DEFAULT 0; UPDATE diagnostic_conversations SET browser_bytes=bytes;");
      }
      const pending = this.prune();
      if (options.automatic !== false) this.schedulePrune(pending ? 1000 : 3600000);
    } catch (error) { this.db.close(); throw error; }
  }
  private schedulePrune(delay: number): void {
    this.timer = setTimeout(() => {
      let pending = false;
      try { pending = this.prune(); } catch { this.warn(); }
      this.schedulePrune(pending ? 1000 : 3600000);
    }, delay);
    this.timer.unref();
  }
  now(): number { return (this.options.now ?? Date.now)(); }
  warn(): void {
    if (this.now() - this.lastWarningAt < 60000) return;
    this.lastWarningAt = this.now();
    if (this.serverDropped) (this.options.logger ?? console).error("Conversation diagnostics incomplete: storage unavailable or limit reached", { droppedServerEvents: this.serverDropped });
    else (this.options.logger ?? console).error("Conversation diagnostics incomplete: storage unavailable or limit reached");
  }
  append(conversation: DiagnosticConversation, events: readonly DiagnosticEvent[], sourceKey?: string) {
    const now = this.now();
    const windowStart = Math.floor(now / 86400000) * 86400000;
    if (now >= conversation.created_at + DIAGNOSTIC_RETENTION_MS) throw new DiagnosticError("diagnostics_expired", 410);
    let limited = false;
    try {
      return transaction(this.db, () => {
        this.db.prepare("INSERT OR IGNORE INTO diagnostic_conversations(id,owner,created_at,first_at,last_at) VALUES(?,?,?,?,?)")
          .run(conversation.id, diagnosticOwnerId(conversation.anonymous_user_id), conversation.created_at, conversation.created_at, now);
        const row = this.db.prepare("SELECT bytes,browser_bytes FROM diagnostic_conversations WHERE id=?").get(conversation.id)!;
        let bytes = Number(row.bytes), browserBytes = Number(row.browser_bytes);
        let total = Number(this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS total FROM diagnostic_conversations").get()!.total);
        let ownerBytes = Number(this.db.prepare("SELECT COALESCE(SUM(browser_bytes),0) AS n FROM diagnostic_conversations WHERE owner=?").get(diagnosticOwnerId(conversation.anonymous_user_id))!.n);
        let ingressBytes = sourceKey ? Number(this.db.prepare("SELECT bytes FROM diagnostic_ingress WHERE source_key=? AND window_start=?").get(sourceKey, windowStart)?.bytes ?? 0) : 0;
        const maxBytes = this.options.maxBytes ?? 1073741824, conversationMax = this.options.conversationMaxBytes ?? 20971520;
        const accepted: Array<{ streamId: string; seq: number }> = [];
        for (const event of events) {
          if (event.conversationId !== conversation.id) throw new DiagnosticError("diagnostics_identity_conflict", 409);
          const stream = this.db.prepare("SELECT * FROM diagnostic_streams WHERE id=?").get(event.streamId);
          if (stream && (stream.conversation_id !== conversation.id || stream.live_session_id !== (event.liveSessionId ?? null) || stream.source !== event.source))
            throw new DiagnosticError("diagnostics_identity_conflict", 409);
          if (this.db.prepare("SELECT 1 FROM diagnostic_events WHERE stream_id=? AND seq=?").get(event.streamId, event.seq)) {
            accepted.push({ streamId: event.streamId, seq: event.seq }); continue;
          }
          const size = Buffer.byteLength(JSON.stringify(event), "utf8") + 256;
          bytes += size; total += size;
          if (event.source === "browser") { browserBytes += size; ownerBytes += size; ingressBytes += size; }
          // Browser traffic cannot consume the last 10% needed for server lifecycle observations.
          if (bytes > conversationMax || total > maxBytes || event.source === "browser" &&
              (bytes > conversationMax * 0.9 || total > maxBytes * 0.9 || ownerBytes > conversationMax || sourceKey !== undefined && ingressBytes > conversationMax)) {
            limited = true; throw new DiagnosticError("diagnostics_limit", 507);
          }
          this.db.prepare("INSERT OR IGNORE INTO diagnostic_streams(id,conversation_id,live_session_id,source) VALUES(?,?,?,?)")
            .run(event.streamId, conversation.id, event.liveSessionId ?? null, event.source);
          this.db.prepare(`INSERT INTO diagnostic_events(stream_id,seq,conversation_id,live_session_id,source,wall_ms,mono_ms,received_at,type,data_json,client_build_id,text_expected,text_truncated)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.streamId, event.seq, conversation.id, event.liveSessionId ?? null, event.source,
            event.wallMs, event.monoMs, now, event.type, JSON.stringify(event.data), event.clientBuildId ?? null,
            event.text === undefined ? 0 : 1, event.textTruncated ? 1 : 0);
          if (event.text !== undefined && this.options.textEnabled && now < conversation.created_at + DIAGNOSTIC_TEXT_RETENTION_MS)
            this.db.prepare("INSERT INTO diagnostic_text(stream_id,seq,conversation_id,text) VALUES(?,?,?,?)").run(event.streamId, event.seq, conversation.id, event.text);
          accepted.push({ streamId: event.streamId, seq: event.seq });
        }
        this.db.prepare("UPDATE diagnostic_conversations SET last_at=?,bytes=?,browser_bytes=? WHERE id=?").run(now, bytes, browserBytes, conversation.id);
        if (sourceKey) this.db.prepare("INSERT INTO diagnostic_ingress(source_key,window_start,bytes) VALUES(?,?,?) ON CONFLICT(source_key,window_start) DO UPDATE SET bytes=excluded.bytes").run(sourceKey, windowStart, ingressBytes);
        return { schemaVersion: 1 as const, accepted, serverTime: now };
      });
    } catch (error) {
      if (limited) {
        this.warn();
        // The rejected batch rolled back; preserve its incompleteness marker separately.
        this.db.prepare("INSERT INTO diagnostic_conversations(id,owner,created_at,first_at,last_at,limited) VALUES(?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET limited=1")
          .run(conversation.id, diagnosticOwnerId(conversation.anonymous_user_id), conversation.created_at, conversation.created_at, now);
      }
      if (!(error instanceof DiagnosticError)) this.warn();
      throw error;
    }
  }
  record<K extends DiagnosticType>(conversation: DiagnosticConversation, type: K, data: DiagnosticData[K], liveSessionId?: string): void {
    try {
      if (!this.db.isOpen) { this.warn(); return; }
      const key = `${conversation.id}:${liveSessionId ?? "conversation"}`;
      let stream = this.serverStreams.get(key);
      if (!stream) {
        if (this.serverStreams.size >= 10000) this.serverStreams.delete(this.serverStreams.keys().next().value!);
        stream = { id: randomUUID(), seq: 0, conversation: { id: conversation.id, anonymous_user_id: conversation.anonymous_user_id, created_at: conversation.created_at }, liveSessionId, losses: {} };
        this.serverStreams.set(key, stream);
      }
      const event = this.serverEvent(stream, type, data), bytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 256;
      if (Object.keys(stream.losses).length && this.serverLosses.size < 1000) this.serverLosses.add(stream);
      if (this.serverPending.length >= 1000 || this.serverQueueBytes + bytes > 1048576) this.noteServerLoss(stream, "queue_overflow");
      else { this.serverPending.push({ stream, event, bytes }); this.serverQueueBytes += bytes; }
      this.scheduleServerWrite();
    } catch { this.warn(); }
  }
  private serverEvent<K extends DiagnosticType>(stream: ServerStream, type: K, data: DiagnosticData[K]): DiagnosticEvent {
    return { schemaVersion: 1, source: "server", conversationId: stream.conversation.id,
      ...(stream.liveSessionId ? { liveSessionId: stream.liveSessionId } : {}), streamId: stream.id, seq: ++stream.seq,
      wallMs: this.now(), monoMs: performance.now(), type, data: JSON.parse(JSON.stringify(data)) } as DiagnosticEvent;
  }
  private noteServerLoss(stream: ServerStream, reason: ServerLossReason): void {
    this.serverDropped++;
    if (this.serverLosses.has(stream) || this.serverLosses.size < 1000) {
      stream.losses[reason] = (stream.losses[reason] ?? 0) + 1; this.serverLosses.add(stream);
    }
    this.warn();
  }
  private scheduleServerWrite(): void {
    if (this.serverWrite || !this.db.isOpen) return;
    // Ledger callbacks only enqueue immutable post-COMMIT snapshots; yield after each write.
    this.serverWrite = setImmediate(() => {
      this.serverWrite = undefined;
      let next = this.serverPending.shift();
      if (next) this.serverQueueBytes -= next.bytes;
      else if (this.serverLosses.size) {
        const stream = this.serverLosses.values().next().value!;
        const [reason, count] = Object.entries(stream.losses)[0]! as [ServerLossReason, number];
        delete stream.losses[reason]; if (!Object.keys(stream.losses).length) this.serverLosses.delete(stream);
        next = { stream, bytes: 0, event: this.serverEvent(stream, "diagnostic.loss", { reason, count, affectedStreamId: stream.id }) };
      }
      if (next) {
        try { this.append(next.stream.conversation, [next.event]); }
        catch (error) {
          if (next.event.type !== "diagnostic.loss") this.noteServerLoss(next.stream, error instanceof DiagnosticError && error.code === "diagnostics_limit" ? "server_limit" :
            error instanceof DiagnosticError && error.code === "diagnostics_expired" ? "expired" : "storage_unavailable");
          else {
            const { reason, count } = next.event.data;
            next.stream.losses[reason] = (next.stream.losses[reason] ?? 0) + count;
            this.serverLosses.delete(next.stream);
            this.warn(); // Retry a failed loss marker only when another observation arrives.
          }
        }
      }
      if (this.serverPending.length || this.serverLosses.size) this.scheduleServerWrite();
      else { this.serverDrainDone?.(); this.serverDrain = undefined; this.serverDrainDone = undefined; }
    });
  }
  flushServerEvents(): Promise<void> {
    if (!this.serverPending.length && !this.serverLosses.size) return Promise.resolve();
    this.serverDrain ??= new Promise(resolve => { this.serverDrainDone = resolve; });
    this.scheduleServerWrite();
    return this.serverDrain;
  }
  prune(): boolean {
    const now = this.now();
    transaction(this.db, () => {
      // Bounded batches prevent an accumulated 30-day backlog from monopolizing the API event loop.
      this.db.prepare("DELETE FROM diagnostic_text WHERE rowid IN (SELECT t.rowid FROM diagnostic_text t JOIN diagnostic_conversations c ON c.id=t.conversation_id WHERE c.created_at<=? LIMIT 1000)").run(now - DIAGNOSTIC_TEXT_RETENTION_MS);
      this.db.prepare("DELETE FROM diagnostic_events WHERE rowid IN (SELECT e.rowid FROM diagnostic_events e JOIN diagnostic_conversations c ON c.id=e.conversation_id WHERE c.created_at<=? LIMIT 1000)").run(now - DIAGNOSTIC_RETENTION_MS);
      this.db.prepare("DELETE FROM diagnostic_streams WHERE rowid IN (SELECT s.rowid FROM diagnostic_streams s JOIN diagnostic_conversations c ON c.id=s.conversation_id WHERE c.created_at<=? AND NOT EXISTS(SELECT 1 FROM diagnostic_events e WHERE e.stream_id=s.id) LIMIT 1000)").run(now - DIAGNOSTIC_RETENTION_MS);
      this.db.prepare("DELETE FROM diagnostic_conversations WHERE created_at<=? AND NOT EXISTS(SELECT 1 FROM diagnostic_events e WHERE e.conversation_id=diagnostic_conversations.id) AND NOT EXISTS(SELECT 1 FROM diagnostic_text t WHERE t.conversation_id=diagnostic_conversations.id) AND NOT EXISTS(SELECT 1 FROM diagnostic_streams s WHERE s.conversation_id=diagnostic_conversations.id)").run(now - DIAGNOSTIC_RETENTION_MS);
      this.db.prepare("DELETE FROM diagnostic_ingress WHERE window_start<?").run(Math.floor(now / 86400000) * 86400000);
    });
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum(256);");
    for (const key of this.serverStreams.keys()) {
      if (!this.db.prepare("SELECT 1 FROM diagnostic_conversations WHERE id=?").get(key.split(":")[0]!)) this.serverStreams.delete(key);
    }
    return Boolean(this.db.prepare("SELECT 1 FROM diagnostic_conversations c WHERE (c.created_at<=? AND EXISTS(SELECT 1 FROM diagnostic_text t WHERE t.conversation_id=c.id)) OR c.created_at<=? LIMIT 1").get(now - DIAGNOSTIC_TEXT_RETENTION_MS, now - DIAGNOSTIC_RETENTION_MS));
  }
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.serverWrite) clearImmediate(this.serverWrite); this.serverWrite = undefined;
    this.serverDropped += this.serverPending.length;
    if (this.serverPending.length || this.serverLosses.size) this.warn();
    this.serverPending.length = 0; this.serverQueueBytes = 0; this.serverLosses.clear(); this.serverStreams.clear();
    this.serverDrainDone?.(); this.serverDrain = undefined; this.serverDrainDone = undefined;
    if (this.db.isOpen) { try { this.prune(); } finally { this.db.close(); } }
  }
}
