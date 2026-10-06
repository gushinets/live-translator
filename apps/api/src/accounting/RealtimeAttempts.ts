import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import OpenAI from "openai";
import { apiConfig } from "../config.js";
import { LedgerError } from "./types.js";
import { transaction } from "../persistence/database.js";
import type { LeaseRegistry } from "../security/SessionLeaseRegistry.js";
import { makeRealtimeProvider, type RealtimeCallCreator, type RealtimeCallCloser } from "../openai/realtimeCall.js";

interface Attempt {
  id: string; owner: string; generation: number; state: string; call_id: string | null;
  lease_id: string | null; expires_at: number; cleanup_at: number | null;
  close_confirmed: number; next_cleanup_at: number; cleanup_count: number;
  handoff_at: number | null;
}
export function openRealtimeDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;");
  return db;
}

/** Separate experimental records; no Live seconds, snapshots, or pricing. */
export class RealtimeAttempts {
  private provider: ReturnType<typeof makeRealtimeProvider> | undefined;
  private readonly creating = new Map<string, Promise<unknown>>();
  private readonly closing = new Map<string, Promise<Attempt>>();
  private readonly emergencyCalls = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private accepting = true;
  private readonly shutdownAbort = new AbortController();
  constructor(readonly db: DatabaseSync, private readonly registry: LeaseRegistry, private readonly options: {
    create?: RealtimeCallCreator; close?: RealtimeCallCloser; syncAdmission?: () => void;
    startWorker?: boolean; ownsDb?: boolean; now?: () => number;
  } = {}) {
    db.exec(`CREATE TABLE IF NOT EXISTS realtime_attempts (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL,
      model TEXT NOT NULL, transcription_model TEXT NOT NULL, engine TEXT NOT NULL DEFAULT 'realtime',
      state TEXT NOT NULL, call_id TEXT, lease_id TEXT, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, cleanup_at INTEGER, close_confirmed INTEGER NOT NULL DEFAULT 0,
      next_cleanup_at INTEGER NOT NULL DEFAULT 0, cleanup_count INTEGER NOT NULL DEFAULT 0,
      error_category TEXT, closed_at INTEGER, handoff_at INTEGER);
      CREATE TABLE IF NOT EXISTS realtime_response_usage (
        attempt_id TEXT NOT NULL REFERENCES realtime_attempts(id), response_id TEXT NOT NULL,
        usage_json TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'browser', received_at INTEGER NOT NULL,
        PRIMARY KEY(attempt_id,response_id));`);
    if (!db.prepare("SELECT 1 FROM pragma_table_info('realtime_attempts') WHERE name='handoff_at'").get()) db.exec("ALTER TABLE realtime_attempts ADD COLUMN handoff_at INTEGER");
    // Startup cannot adopt an old browser call. Retain unknown outcomes for audit.
    db.prepare("UPDATE realtime_attempts SET cleanup_at=COALESCE(cleanup_at,?), state=CASE WHEN call_id IS NULL THEN 'unknown' ELSE 'closing' END WHERE state IN ('creating','active','closing','unknown')").run(this.now());
    if (options.startWorker !== false) {
      this.timer = setInterval(() => { void this.sweep().catch(() => console.error("Realtime cleanup persistence unavailable")); }, 1000);
      this.timer.unref();
    }
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private row(id: string): Attempt | undefined {
    return this.db.prepare("SELECT * FROM realtime_attempts WHERE id=?").get(id) as unknown as Attempt | undefined;
  }
  owned(owner: string, id: string): Attempt {
    const row = this.row(id);
    if (!row || row.owner !== owner) throw new LedgerError("not_found", 404);
    return row;
  }
  reservations() {
    return (this.db.prepare("SELECT lease_id,expires_at,call_id FROM realtime_attempts WHERE close_confirmed=0 AND lease_id IS NOT NULL AND expires_at>?").all(this.now()) as unknown as Array<{lease_id:string;expires_at:number;call_id:string|null}>)
      .map(r => ({ leaseId: r.lease_id, expiresAt: r.expires_at, sessionId: r.call_id }));
  }
  create(owner: string, id: string, generation: number, sdp: string, disconnected: () => boolean) {
    if (!this.accepting) throw new LedgerError("server_shutting_down", 503);
    if (this.row(id)) { this.owned(owner, id); throw new LedgerError("attempt_already_exists"); }
    this.options.syncAdmission?.();
    const lease = this.registry.acquire(this.now());
    if (!lease) throw new LedgerError("concurrent_session_limit", 429);
    try {
      // Reserve before any async dispatch; also restrict each anonymous owner to one call.
      transaction(this.db, () => {
        if (this.db.prepare("SELECT 1 FROM realtime_attempts WHERE owner=? AND expires_at>? AND close_confirmed=0 AND lease_id IS NOT NULL").get(owner, this.now())) throw new LedgerError("attempt_in_progress");
        this.db.prepare("INSERT INTO realtime_attempts(id,owner,generation,model,transcription_model,state,lease_id,created_at,expires_at) VALUES(?,?,?,?,?,'creating',?,?,?)")
          .run(id, owner, generation, apiConfig.realtimeModel, apiConfig.realtimeTranscriptionModel, lease.leaseId,
            this.now(), this.now() + Math.min(apiConfig.maxProviderSessionMs, apiConfig.maxConversationElapsedMs, apiConfig.leaseMs));
      });
    } catch (error) { lease.release(); throw error; }
    this.registry.bindSession(lease.leaseId, `realtime:${id}`, this.now());
    const work = this.dispatch(owner, id, sdp, disconnected).finally(() => this.creating.delete(id));
    this.creating.set(id, work);
    return work;
  }
  private async dispatch(owner: string, id: string, sdp: string, disconnected: () => boolean) {
    try {
      if(!this.options.create)this.provider ??= makeRealtimeProvider();
      const call = await (this.options.create ?? this.provider!.create)(sdp, AbortSignal.any([AbortSignal.timeout(30000),this.shutdownAbort.signal]));
      this.emergencyCalls.set(id, call.callId);
      this.db.prepare("UPDATE realtime_attempts SET call_id=?,state='active' WHERE id=?").run(call.callId, id);
      this.emergencyCalls.delete(id);
      const row = this.owned(owner, id);
      if (row.lease_id) this.registry.bindSession(row.lease_id,call.callId,this.now());
      if (row.cleanup_at !== null || disconnected() || !this.accepting) {
        await this.cleanup(owner, id);
        throw new LedgerError("attempt_cancelled");
      }
      return { attemptId: id, sdp: call.sdp, expiresAt: row.expires_at };
    } catch (error) {
      const definitive = error instanceof OpenAI.APIError && [400,401,403,404,422,429].includes(error.status ?? 0);
      // A network timeout is ambiguous, never reported as a no-cost failure.
      const row = this.row(id);
      if (row && row.call_id === null) this.db.prepare("UPDATE realtime_attempts SET state=?,error_category='provider_creation_failed',cleanup_at=COALESCE(cleanup_at,?),lease_id=CASE WHEN ? THEN NULL ELSE lease_id END WHERE id=?")
        .run(definitive ? "failed" : "unknown", this.now(), definitive ? 1 : 0, id);
      this.options.syncAdmission?.();
      if (definitive) this.registry.releaseSession(`realtime:${id}`);
      throw error instanceof LedgerError ? error : new LedgerError("realtime_provider_unavailable", 502);
    }
  }
  async cleanup(owner: string, id: string): Promise<Attempt> {
    // A cancel can beat the create request. This durable tombstone forbids dispatch later.
    if (!this.row(id)) this.db.prepare("INSERT INTO realtime_attempts(id,owner,generation,model,transcription_model,state,created_at,expires_at,cleanup_at,close_confirmed) VALUES(?,?,0,?,?,'failed',?,?,?,1)")
      .run(id, owner, apiConfig.realtimeModel, apiConfig.realtimeTranscriptionModel, this.now(), this.now(), this.now());
    const row = this.owned(owner, id);
    this.db.prepare("UPDATE realtime_attempts SET cleanup_at=COALESCE(cleanup_at,?),state=CASE WHEN call_id IS NOT NULL AND close_confirmed=0 THEN 'closing' ELSE state END WHERE id=?").run(this.now(), id);
    if (!row.call_id || row.close_confirmed) return this.owned(owner,id);
    const old = this.closing.get(id); if (old) return old;
    const work = this.closeKnown(owner, id, row.call_id).finally(() => this.closing.delete(id));
    this.closing.set(id, work); return work;
  }
  private async closeKnown(owner: string, id: string, callId: string) {
    try {
      if(!this.options.close)this.provider ??= makeRealtimeProvider();
      await (this.options.close ?? this.provider!.close)(callId, AbortSignal.timeout(apiConfig.sessionCloseTimeoutMs));
      this.db.prepare("UPDATE realtime_attempts SET state='closed',close_confirmed=1,closed_at=?,lease_id=NULL,error_category=NULL WHERE id=? AND call_id=?").run(this.now(), id, callId);
      this.registry.releaseSession(callId);
    } catch {
      // Do not claim that a failed hangup closed the provider, including HTTP 404.
      this.db.prepare("UPDATE realtime_attempts SET state='unknown',error_category='hangup_unknown',cleanup_count=cleanup_count+1,next_cleanup_at=? WHERE id=?")
        .run(this.now() + 10000, id);
    }
    this.options.syncAdmission?.();
    return this.owned(owner,id);
  }
  recordUsage(owner: string, id: string, responseId: string, usage: object) {
    this.owned(owner,id);
    this.db.prepare("INSERT INTO realtime_response_usage(attempt_id,response_id,usage_json,received_at) VALUES(?,?,?,?) ON CONFLICT(attempt_id,response_id) DO UPDATE SET usage_json=excluded.usage_json,received_at=excluded.received_at")
      .run(id, responseId, JSON.stringify(usage), this.now());
  }
  handoff(owner:string,id:string) {
    const row=this.owned(owner,id);
    if(row.state!=="active" || row.cleanup_at!==null || row.expires_at<=this.now()) throw new LedgerError("attempt_not_activatable");
    this.db.prepare("UPDATE realtime_attempts SET handoff_at=COALESCE(handoff_at,?) WHERE id=?").run(this.now(),id);
  }
  async sweep() {
    for (const [id, callId] of this.emergencyCalls) {
      this.db.prepare("UPDATE realtime_attempts SET call_id=?,cleanup_at=COALESCE(cleanup_at,?),state='closing' WHERE id=?").run(callId,this.now(),id);
      this.emergencyCalls.delete(id);
    }
    const rows = this.db.prepare("SELECT * FROM realtime_attempts WHERE call_id IS NOT NULL AND close_confirmed=0 AND (cleanup_at IS NOT NULL OR expires_at<=? OR (handoff_at IS NULL AND created_at<=?)) AND next_cleanup_at<=? AND cleanup_count<6 LIMIT 5")
      .all(this.now(),this.now()-apiConfig.sessionHandoffAckTimeoutMs,this.now()) as unknown as Attempt[];
    await Promise.allSettled(rows.map(r => this.cleanup(r.owner,r.id)));
  }
  async shutdown() {
    this.accepting = false;
    this.shutdownAbort.abort();
    if (this.timer) clearInterval(this.timer);
    this.db.prepare("UPDATE realtime_attempts SET cleanup_at=COALESCE(cleanup_at,?) WHERE close_confirmed=0").run(this.now());
    await Promise.allSettled([...this.creating.values()]);
    await this.sweep();
    if (this.options.ownsDb) this.db.close();
  }
}
