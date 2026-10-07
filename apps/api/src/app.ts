import { createUsageRouter } from "./routes/usage.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { existsSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { UsageLedger } from "./accounting/UsageLedger.js";
import { LedgerRuntime } from "./accounting/LedgerRuntime.js";
import { LedgerError, DEFAULT_LEDGER_POLICY } from "./accounting/types.js";
import type { OrphanCloser } from "./accounting/CleanupWorker.js";
import { openUsageDatabase } from "./persistence/database.js";
import { AnonymousIdentity } from "./security/AnonymousIdentity.js";
import { createConversationRouter } from "./routes/conversations.js";
import { createManagedSessionRouter } from "./routes/managedSessions.js";
import { rateLimit } from "express-rate-limit";
import { apiConfig } from "./config.js";
import type { LiveSessionCreator } from "./openai/createLiveSession.js";
import { createLiveSessionRouter } from "./routes/liveSession.js";
import { createRealtimeRouter } from "./routes/realtime.js";
import { RealtimeAttempts, openRealtimeDatabase } from "./accounting/RealtimeAttempts.js";
import type { RealtimeCallCreator, RealtimeCallCloser } from "./openai/realtimeCall.js";
import { REALTIME_VAD, REALTIME_PROMPT_VERSION, realtimeConfiguration } from "./openai/realtimeCall.js";
import {
  SessionLeaseRegistry,
  type LeaseRegistry,
} from "./security/SessionLeaseRegistry.js";

export interface AppDependencies {
  createLiveSession?: LiveSessionCreator;
  leaseRegistry?: LeaseRegistry;
  logger?: Pick<Console, "error">;
  ledger?: UsageLedger;
  closeOrphan?: OrphanCloser;
  startWorker?: boolean;
  ledgerEnabled?: boolean;
  realtimeEnabled?: boolean;
  createRealtimeCall?: RealtimeCallCreator;
  closeRealtimeCall?: RealtimeCallCloser;
}

function hasRealtimeRecords(db: DatabaseSync) {
  return !!(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='realtime_attempts'").get()
    && db.prepare("SELECT 1 FROM realtime_attempts LIMIT 1").get());
}

export function createApp(dependencies: AppDependencies = {}) {
  const app = express();
  const leaseRegistry =
    dependencies.leaseRegistry ??
    new SessionLeaseRegistry(
      apiConfig.maxConcurrentSessions,
      apiConfig.leaseMs,
    );
  const sessionCreationLimiter = rateLimit({
    windowMs: apiConfig.creationWindowMs,
    limit: apiConfig.creationLimit,
    // Keep IPv6 clients on a stable prefix key so rotating interface addresses cannot reset quota.
    ipv6Subnet: 56,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many session creation attempts" },
  });

  app.set("trust proxy", 1);
  app.use(express.json({ limit: "64kb" }));
  app.get("/health", (_request, response) => response.json({ status: "ok" }));
  // Only the creation route consumes quota; cleanup must work after a 429.
  app.post(["/api/live/session", "/api/realtime/session"], sessionCreationLimiter);
  const enabled = dependencies.ledgerEnabled ?? (dependencies.ledger !== undefined || apiConfig.usageLedgerEnabled);
  const retainLedger = enabled || dependencies.ledger !== undefined || existsSync(apiConfig.usageDbPath);
  const realtimeEnabled = dependencies.realtimeEnabled ?? apiConfig.realtimePilotEnabled;
  let realtime: RealtimeAttempts | undefined;
  app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.get("/api/policy", (_req, res) => res.json({ usageLedgerEnabled: enabled, backgroundSessionCloseEnabled: enabled && apiConfig.backgroundSessionCloseEnabled, creationPaused: !enabled && retainLedger, schemaVersion: 1,
    realtime: { enabled: realtimeEnabled && (enabled || !retainLedger), model: apiConfig.realtimeModel,
      transcriptionModel: apiConfig.realtimeTranscriptionModel, vad: REALTIME_VAD, promptVersion: REALTIME_PROMPT_VERSION,
      instructions:realtimeConfiguration().instructions,transcriptionPrompt:realtimeConfiguration().audio?.input?.transcription?.prompt,
      maxOutputTokens:realtimeConfiguration().max_output_tokens,
      schemaVersion: 2, maxSessionMs: Math.min(apiConfig.maxProviderSessionMs,apiConfig.maxConversationElapsedMs,apiConfig.leaseMs) } }));
  if (retainLedger) {
    const ledger = dependencies.ledger ?? new UsageLedger(openUsageDatabase(apiConfig.usageDbPath), { policy: {
      ...DEFAULT_LEDGER_POLICY, conversationRetentionMs: apiConfig.conversationRetentionMs,
      maxProviderSessionMs: apiConfig.maxProviderSessionMs, maxConversationElapsedMs: apiConfig.maxConversationElapsedMs,
      sessionCloseTimeoutMs: apiConfig.sessionCloseTimeoutMs, sessionHandoffAckTimeoutMs: apiConfig.sessionHandoffAckTimeoutMs,
      resumeClaimTimeoutMs: apiConfig.resumeClaimTimeoutMs, backgroundSessionCloseEnabled: apiConfig.backgroundSessionCloseEnabled,
    } });
    const ledgerFile = ledger.db.prepare("PRAGMA database_list").get()!.file as string;
    let standalone = existsSync(apiConfig.realtimeDbPath) && (!ledgerFile || realpathSync(apiConfig.realtimeDbPath) !== realpathSync(ledgerFile));
    if (standalone && hasRealtimeRecords(ledger.db)) {
      const previous = new DatabaseSync(apiConfig.realtimeDbPath, { readOnly: true });
      try {
        if (hasRealtimeRecords(previous)) {
          // ponytail: fail closed on split stores; explicit migration if mixed deployments need recovery.
          if (!dependencies.ledger) ledger.db.close();
          throw new Error("Realtime records exist in both databases; explicit reconciliation is required");
        }
        standalone = false;
      } finally { previous.close(); }
    }
    const runtime = new LedgerRuntime(ledger, { creator: dependencies.createLiveSession, closeOrphan: dependencies.closeOrphan,
      maxConcurrent: apiConfig.maxConcurrentSessions, leaseMs: apiConfig.leaseMs,
      workerConcurrency: apiConfig.cleanupWorkerConcurrency, workerBatchSize: apiConfig.cleanupWorkerBatchSize,
      logger: dependencies.logger, startWorker: dependencies.startWorker, additionalReservations: () => realtime?.reservations() ?? [] });
    app.locals.ledgerRuntime = runtime;
    realtime = new RealtimeAttempts(standalone ? openRealtimeDatabase(apiConfig.realtimeDbPath) : ledger.db, runtime.registry, { create: dependencies.createRealtimeCall,
      close: dependencies.closeRealtimeCall, syncAdmission: () => runtime.syncAdmission(), startWorker: dependencies.startWorker });
    runtime.syncAdmission();
    const identity = new AnonymousIdentity(process.env.NODE_ENV === "production");
    app.use("/api/conversations", createConversationRouter(runtime, identity, apiConfig.webOrigin, enabled));
    app.use("/api/live/session", createUsageRouter(runtime, identity, apiConfig.webOrigin));
    app.use("/api/live/session", createManagedSessionRouter(runtime, identity, apiConfig.webOrigin, enabled));
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (res.headersSent) { _next(error); return; }
      if (res.destroyed) return;
      if (error instanceof LedgerError) res.status(error.status).json({ error: error.code, code: error.code });
      else if (error instanceof z.ZodError) res.status(400).json({ error: "invalid_request", code: "invalid_request" });
      else {
        (dependencies.logger ?? console).error("Ledger request failed", { errorType: error instanceof Error ? error.name : "unknown" });
        res.status(503).json({ error: "ledger_unavailable", code: "ledger_unavailable" });
      }
    });
  } else {
    if (realtimeEnabled || existsSync(apiConfig.realtimeDbPath)) {
      realtime = new RealtimeAttempts(openRealtimeDatabase(apiConfig.realtimeDbPath), leaseRegistry, {
        create: dependencies.createRealtimeCall, close: dependencies.closeRealtimeCall, startWorker: dependencies.startWorker, ownsDb: true });
      if (leaseRegistry instanceof SessionLeaseRegistry) leaseRegistry.restoreReservations(realtime.reservations());
    }
    app.use("/api/live/session", createLiveSessionRouter({ createLiveSession: dependencies.createLiveSession,
      leaseRegistry, webOrigin: apiConfig.webOrigin, logger: dependencies.logger }));
  }
  app.locals.realtimeRuntime = realtime;
  app.use("/api/realtime",createRealtimeRouter(realtime,realtimeEnabled,() => enabled || !retainLedger));
  return app;
}
