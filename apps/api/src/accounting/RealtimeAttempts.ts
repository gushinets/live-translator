import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { apiConfig } from "../config.js";
import { LedgerError } from "./types.js";
import { transaction } from "../persistence/database.js";
import type { LeaseRegistry } from "../security/SessionLeaseRegistry.js";
import { makeRealtimeProvider, type RealtimeCallCreator, type RealtimeCallCloser } from "../openai/realtimeCall.js";
import { boundedWait } from "./LedgerRuntime.js";

const PREPARATION_TTL_MS = 60000;
export type RealtimeUsageObservation =
  | { operation: "response"; responseId: string; usage: object }
  | { operation: "transcription"; itemId: string; contentIndex: number; usage: object };

interface Attempt {
  id: string; owner: string; generation: number; state: string; call_id: string | null;
  lease_id: string | null; expires_at: number; cleanup_at: number | null;
  close_confirmed: number; next_cleanup_at: number; cleanup_count: number;
  handoff_at: number | null;
  created_at: number; creation_token: string | null; model: string; transcription_model: string;
}
export function openRealtimeDatabase(path: string): DatabaseSync {
  if (!path.trim()) throw new Error("Invalid realtime database path");
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
  private readonly emergencyCalls = new Map<string, { callId: string; closed: boolean }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private accepting = true;
  private readonly shutdownAbort = new AbortController();
  private readonly closeAbort = new AbortController();
  private disposed = false;
  private stopWork: Promise<void> | undefined;
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
    if (!db.prepare("SELECT 1 FROM pragma_table_info('realtime_attempts') WHERE name='creation_token'").get()) db.exec("ALTER TABLE realtime_attempts ADD COLUMN creation_token TEXT");
    db.exec(`CREATE TABLE IF NOT EXISTS realtime_usage (
      attempt_id TEXT NOT NULL REFERENCES realtime_attempts(id), operation TEXT NOT NULL,
      observation_id TEXT NOT NULL, content_index INTEGER NOT NULL, model TEXT NOT NULL,
      usage_json TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'provider_data_channel_via_browser',
      received_at INTEGER NOT NULL, PRIMARY KEY(attempt_id,operation,observation_id,content_index));
      INSERT OR IGNORE INTO realtime_usage
        SELECT u.attempt_id,'response',u.response_id,-1,a.model,u.usage_json,u.source,u.received_at
        FROM realtime_response_usage u JOIN realtime_attempts a ON a.id=u.attempt_id;`);
    db.prepare("UPDATE realtime_attempts SET state='failed',cleanup_at=?,close_confirmed=1 WHERE state='prepared'").run(this.now());
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
    // Product expiry triggers cleanup; it is never evidence of provider closure.
    // ponytail: fail closed until confirmed hangup; reconciliation is required for lost IDs.
    return (this.db.prepare("SELECT lease_id,call_id FROM realtime_attempts WHERE close_confirmed=0 AND lease_id IS NOT NULL").all() as unknown as Array<{lease_id:string;call_id:string|null}>)
      .map(r => ({ leaseId: r.lease_id, expiresAt: Number.MAX_SAFE_INTEGER, sessionId: r.call_id ?? `realtime:${r.lease_id}` }));
  }
  private prunePreparations() {
    this.db.prepare("DELETE FROM realtime_attempts WHERE call_id IS NULL AND lease_id IS NULL AND state IN ('prepared','failed') AND created_at<=? AND NOT EXISTS (SELECT 1 FROM realtime_usage WHERE attempt_id=realtime_attempts.id) AND NOT EXISTS (SELECT 1 FROM realtime_response_usage WHERE attempt_id=realtime_attempts.id)").run(this.now()-PREPARATION_TTL_MS);
  }
  prepare(owner: string, id: string, generation: number) {
    if (!this.accepting) throw new LedgerError("server_shutting_down", 503);
    this.prunePreparations();
    if (this.row(id)) { this.owned(owner, id); throw new LedgerError("attempt_already_exists"); }
    if (this.db.prepare("SELECT 1 FROM realtime_attempts WHERE owner=? AND (state='prepared' OR (close_confirmed=0 AND lease_id IS NOT NULL))").get(owner)) throw new LedgerError("attempt_in_progress");
    if ((this.db.prepare("SELECT COUNT(*) AS n FROM realtime_attempts WHERE call_id IS NULL AND lease_id IS NULL").get()!.n as number)>=2048) throw new LedgerError("preparation_limit",429);
    const token=randomUUID();
    this.db.prepare("INSERT INTO realtime_attempts(id,owner,generation,model,transcription_model,state,created_at,expires_at,creation_token) VALUES(?,?,?,?,?,'prepared',?,?,?)")
      .run(id,owner,generation,apiConfig.realtimeModel,apiConfig.realtimeTranscriptionModel,this.now(),this.now()+PREPARATION_TTL_MS,token);
    return { admissionToken:token };
  }
  create(owner: string, id: string, generation: number, sdp: string, disconnected: () => boolean, admissionToken: string) {
    if (!this.accepting) throw new LedgerError("server_shutting_down", 503);
    const prepared=this.owned(owner,id);
    if (prepared.state!=="prepared" || prepared.creation_token!==admissionToken || prepared.generation!==generation || prepared.expires_at<=this.now()) throw new LedgerError("attempt_not_activatable");
    this.options.syncAdmission?.();
    const lease = this.registry.acquire(this.now());
    if (!lease) {
      this.db.prepare("UPDATE realtime_attempts SET state='failed',close_confirmed=1,cleanup_at=? WHERE id=?").run(this.now(),id);
      throw new LedgerError("concurrent_session_limit", 429);
    }
    try {
      // Reserve before any async dispatch; also restrict each anonymous owner to one call.
      transaction(this.db, () => {
        if (this.db.prepare("SELECT 1 FROM realtime_attempts WHERE owner=? AND close_confirmed=0 AND lease_id IS NOT NULL").get(owner)) throw new LedgerError("attempt_in_progress");
        this.db.prepare("UPDATE realtime_attempts SET state='creating',lease_id=?,expires_at=? WHERE id=?")
          .run(lease.leaseId, this.now() + Math.min(apiConfig.maxProviderSessionMs, apiConfig.maxConversationElapsedMs, apiConfig.leaseMs),id);
      });
    } catch (error) { lease.release(); throw error; }
    this.registry.bindSession(lease.leaseId, `realtime:${lease.leaseId}`, this.now(),Number.MAX_SAFE_INTEGER);
    const work = this.dispatch(owner, id, sdp, disconnected).finally(() => this.creating.delete(id));
    this.creating.set(id, work);
    return work;
  }
  private async dispatch(owner: string, id: string, sdp: string, disconnected: () => boolean) {
    try {
      if(!this.options.create)this.provider ??= makeRealtimeProvider();
      let remembered=false;
      const remember=(callId:string)=> {
        remembered=true;
        this.emergencyCalls.set(id,{callId,closed:false});
        if(this.disposed) {void this.closeDetached(callId);throw new LedgerError("attempt_cancelled");}
        this.db.prepare("UPDATE realtime_attempts SET call_id=? WHERE id=?").run(callId,id);
        const row=this.owned(owner,id);
        if(row.lease_id)this.registry.bindSession(row.lease_id,callId,this.now(),Number.MAX_SAFE_INTEGER);
      };
      const call = await (this.options.create ?? this.provider!.create)(sdp, AbortSignal.any([AbortSignal.timeout(30000),this.shutdownAbort.signal]),remember);
      if(this.disposed) {if(!this.emergencyCalls.has(id))void this.closeDetached(call.callId);throw new LedgerError("attempt_cancelled");}
      if(!remembered)remember(call.callId);
      const row = this.owned(owner, id);
      if (row.cleanup_at !== null || row.close_confirmed || row.state!=="creating" || row.expires_at<=this.now() || disconnected() || !this.accepting) {
        await this.cleanup(owner, id);
        throw new LedgerError("attempt_cancelled");
      }
      this.db.prepare("UPDATE realtime_attempts SET state='active' WHERE id=?").run(id);
      return { attemptId: id, sdp: call.sdp, expiresAt: row.expires_at };
    } catch (error) {
      const definitive = error instanceof OpenAI.APIError && [400,401,403,404,422,429].includes(error.status ?? 0);
      // A network timeout is ambiguous, never reported as a no-cost failure.
      if(this.disposed)throw new LedgerError("attempt_cancelled");
      const known=this.emergencyCalls.get(id);
      if(known) {
        try {await this.cleanup(owner,id);} catch {await this.closeEmergency(known);}
        throw error instanceof LedgerError ? error : new LedgerError("realtime_provider_unavailable",502);
      }
      const row = this.row(id);
      if (row && row.call_id === null) this.db.prepare("UPDATE realtime_attempts SET state=?,error_category='provider_creation_failed',cleanup_at=COALESCE(cleanup_at,?),lease_id=CASE WHEN ? THEN NULL ELSE lease_id END,close_confirmed=CASE WHEN ? THEN 1 ELSE close_confirmed END WHERE id=?")
        .run(definitive ? "failed" : "unknown", this.now(), definitive ? 1 : 0, definitive ? 1 : 0, id);
      this.options.syncAdmission?.();
      if (definitive && row?.lease_id) this.registry.releaseSession(`realtime:${row.lease_id}`);
      throw error instanceof LedgerError ? error : new LedgerError("realtime_provider_unavailable", 502);
    }
  }
  async cleanup(owner: string, id: string): Promise<Attempt> {
    const row = this.owned(owner, id);
    this.db.prepare("UPDATE realtime_attempts SET cleanup_at=COALESCE(cleanup_at,?),close_confirmed=CASE WHEN state='prepared' THEN 1 ELSE close_confirmed END,state=CASE WHEN state='prepared' THEN 'failed' WHEN call_id IS NOT NULL AND close_confirmed=0 THEN 'closing' ELSE state END WHERE id=?").run(this.now(), id);
    const callId=row.call_id ?? this.emergencyCalls.get(id)?.callId;
    if (!callId || row.close_confirmed) return this.owned(owner,id);
    const old = this.closing.get(id); if (old) return old;
    const work = this.closeKnown(owner, id, callId, row).finally(() => this.closing.delete(id));
    this.closing.set(id, work); return work;
  }
  private async closeDetached(callId:string) {
    try {if(!this.options.close)this.provider??=makeRealtimeProvider();await (this.options.close??this.provider!.close)(callId,AbortSignal.timeout(apiConfig.sessionCloseTimeoutMs));}
    catch {console.error("Late Realtime hangup unconfirmed; durable reservation retained");}
  }
  private async closeEmergency(value:{callId:string;closed:boolean}) {
    if(value.closed)return;
    if(!this.options.close)this.provider??=makeRealtimeProvider();
    try {await (this.options.close??this.provider!.close)(value.callId,AbortSignal.any([AbortSignal.timeout(apiConfig.sessionCloseTimeoutMs),this.closeAbort.signal]));value.closed=true;}
    catch { /* Keep the known ID for retry after persistence recovery. */ }
  }
  private async closeKnown(owner: string, id: string, callId: string, before:Attempt) {
    const known=this.emergencyCalls.get(id)??{callId,closed:false};this.emergencyCalls.set(id,known);
    try {
      if(!this.options.close)this.provider ??= makeRealtimeProvider();
      if(!known.closed)await (this.options.close ?? this.provider!.close)(callId, AbortSignal.any([AbortSignal.timeout(apiConfig.sessionCloseTimeoutMs),this.closeAbort.signal]));
      known.closed=true;
      if(this.disposed)return before;
      this.db.prepare("UPDATE realtime_attempts SET call_id=?,state='closed',close_confirmed=1,closed_at=?,lease_id=NULL,error_category=NULL WHERE id=?").run(callId,this.now(), id);
      this.registry.releaseSession(callId);
      if(before.lease_id)this.registry.releaseSession(`realtime:${before.lease_id}`);
      this.emergencyCalls.delete(id);
    } catch {
      if(this.disposed)return before;
      // Do not claim that a failed hangup closed the provider, including HTTP 404.
      this.db.prepare("UPDATE realtime_attempts SET state='unknown',error_category='hangup_unknown',cleanup_count=cleanup_count+1,next_cleanup_at=? WHERE id=?")
        .run(this.now() + 10000, id);
    }
    this.options.syncAdmission?.();
    return this.owned(owner,id);
  }
  recordUsage(owner: string, id: string, observation: RealtimeUsageObservation) {
    const row=this.owned(owner,id);
    if(!row.call_id)throw new LedgerError("usage_before_provider_call");
    const operation=observation.operation, key=operation==="response"?observation.responseId:observation.itemId;
    const index=operation==="transcription"?observation.contentIndex:-1;
    const existing=this.db.prepare("SELECT 1 FROM realtime_usage WHERE attempt_id=? AND operation=? AND observation_id=? AND content_index=?").get(id,operation,key,index);
    // 128 input items, <=32 ASR parts each, <=1 response per item.
    const cap=operation==="response"?128:4096;
    if(!existing && (this.db.prepare("SELECT COUNT(*) AS n FROM realtime_usage WHERE attempt_id=? AND operation=?").get(id,operation)!.n as number)>=cap)throw new LedgerError("usage_observation_limit",429);
    this.db.prepare("INSERT INTO realtime_usage(attempt_id,operation,observation_id,content_index,model,usage_json,received_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(attempt_id,operation,observation_id,content_index) DO UPDATE SET usage_json=excluded.usage_json,received_at=excluded.received_at")
      .run(id,operation,key,index,operation==="response"?row.model:row.transcription_model,JSON.stringify(observation.usage),this.now());
  }
  handoff(owner:string,id:string) {
    const row=this.owned(owner,id);
    if(row.state!=="active" || row.cleanup_at!==null || row.expires_at<=this.now()) throw new LedgerError("attempt_not_activatable");
    if (row.handoff_at === null) this.db.prepare("UPDATE realtime_attempts SET handoff_at=? WHERE id=?").run(this.now(),id);
  }
  async sweep() {
    if(this.disposed)return;
    this.prunePreparations();
    for (const [id, value] of this.emergencyCalls) {
      const row=this.row(id);
      if(value.closed) {
        this.db.prepare("UPDATE realtime_attempts SET call_id=?,state='closed',close_confirmed=1,closed_at=?,lease_id=NULL,error_category=NULL WHERE id=?").run(value.callId,this.now(),id);
        this.registry.releaseSession(value.callId);
        if(row?.lease_id)this.registry.releaseSession(`realtime:${row.lease_id}`);
        this.emergencyCalls.delete(id);
      } else if(row?.call_id===null) {
        this.db.prepare("UPDATE realtime_attempts SET call_id=?,cleanup_at=COALESCE(cleanup_at,?),state='closing' WHERE id=?").run(value.callId,this.now(),id);
      }
    }
    const rows = this.db.prepare("SELECT * FROM realtime_attempts WHERE call_id IS NOT NULL AND close_confirmed=0 AND (cleanup_at IS NOT NULL OR expires_at<=? OR (handoff_at IS NULL AND created_at<=?)) AND next_cleanup_at<=? AND cleanup_count<6 LIMIT 5")
      .all(this.now(),this.now()-apiConfig.sessionHandoffAckTimeoutMs,this.now()) as unknown as Attempt[];
    await Promise.allSettled(rows.map(r => this.cleanup(r.owner,r.id)));
  }
  shutdown(options={drainMs:100,timeoutMs:1000}) {
    this.stopWork??=this.stop(options);return this.stopWork;
  }
  private async stop(options:{drainMs:number;timeoutMs:number}) {
    const deadline=performance.now()+options.timeoutMs;
    this.accepting = false;
    if (this.timer) clearInterval(this.timer);
    try {this.db.prepare("UPDATE realtime_attempts SET cleanup_at=COALESCE(cleanup_at,?) WHERE close_confirmed=0").run(this.now());}
    catch {console.error("Realtime shutdown fence unavailable; admission remains closed");}
    const work=Promise.allSettled([...this.creating.values()]);
    await boundedWait(work,Math.min(options.drainMs,Math.max(0,deadline-performance.now())));
    this.shutdownAbort.abort();
    await boundedWait(work,Math.min(100,Math.max(0,deadline-performance.now())));
    await boundedWait(this.sweep().catch(()=>console.error("Realtime shutdown persistence unavailable")),Math.max(0,deadline-performance.now()));
    this.disposed=true;this.closeAbort.abort();
    if (this.options.ownsDb) this.db.close();
  }
}
