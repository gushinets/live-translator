import { createUsageRouter } from "./routes/usage.js";
import { DiagnosticJournal } from "./diagnostics/DiagnosticJournal.js";
import { createDiagnosticsRouter } from "./routes/diagnostics.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { existsSync } from "node:fs";
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
  diagnostics?: DiagnosticJournal;
  diagnosticsEnabled?: boolean;
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
  app.use("/api/conversations/:id/diagnostics", express.json({ limit: "32kb" }));
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (req.path.endsWith("/diagnostics") && error && typeof error === "object" && "type" in error && error.type === "entity.too.large")
      res.status(413).json({ code: "diagnostics_batch_too_large" });
    else if (req.path.endsWith("/diagnostics") && error && typeof error === "object" && "type" in error && error.type === "entity.parse.failed")
      res.status(400).json({ code: "invalid_diagnostic_event" });
    else next(error);
  });
  app.use(express.json({ limit: "64kb" }));
  app.get("/health", (_request, response) => response.json({ status: "ok" }));
  // Only the creation route consumes quota; cleanup must work after a 429.
  app.post("/api/live/session", sessionCreationLimiter);
  const enabled = dependencies.ledgerEnabled ?? (dependencies.ledger !== undefined || apiConfig.usageLedgerEnabled);
  const retainLedger = enabled || dependencies.ledger !== undefined || existsSync(apiConfig.usageDbPath);
  app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  let diagnostics: DiagnosticJournal | undefined;
  const collectDiagnostics = enabled && (dependencies.diagnosticsEnabled ?? (dependencies.diagnostics !== undefined || apiConfig.diagnosticsEnabled));
  try { diagnostics = dependencies.diagnostics ?? (collectDiagnostics || existsSync(apiConfig.diagnosticsDbPath) ? new DiagnosticJournal(apiConfig.diagnosticsDbPath, { textEnabled: collectDiagnostics && apiConfig.diagnosticsTextEnabled, logger: dependencies.logger }) : undefined); }
  catch { (dependencies.logger ?? console).error("Conversation diagnostics disabled: storage unavailable"); }
  app.locals.diagnostics = diagnostics;
  app.get("/api/policy", (_req, res) => res.json({ usageLedgerEnabled: enabled, backgroundSessionCloseEnabled: enabled && apiConfig.backgroundSessionCloseEnabled, creationPaused: !enabled && retainLedger, schemaVersion: 1,
    diagnostics: { enabled: collectDiagnostics && diagnostics !== undefined, textEnabled: collectDiagnostics && (diagnostics?.options.textEnabled ?? false), schemaVersion: 1 } }));
  if (retainLedger) {
    const ledger = dependencies.ledger ?? new UsageLedger(openUsageDatabase(apiConfig.usageDbPath), { policy: {
      ...DEFAULT_LEDGER_POLICY, conversationRetentionMs: apiConfig.conversationRetentionMs,
      maxProviderSessionMs: apiConfig.maxProviderSessionMs, maxConversationElapsedMs: apiConfig.maxConversationElapsedMs,
      sessionCloseTimeoutMs: apiConfig.sessionCloseTimeoutMs, sessionHandoffAckTimeoutMs: apiConfig.sessionHandoffAckTimeoutMs,
      resumeClaimTimeoutMs: apiConfig.resumeClaimTimeoutMs, backgroundSessionCloseEnabled: apiConfig.backgroundSessionCloseEnabled,
    } });
    ledger.diagnosticJournal = collectDiagnostics ? diagnostics : undefined;
    const runtime = new LedgerRuntime(ledger, { creator: dependencies.createLiveSession, closeOrphan: dependencies.closeOrphan,
      maxConcurrent: apiConfig.maxConcurrentSessions, leaseMs: apiConfig.leaseMs,
      workerConcurrency: apiConfig.cleanupWorkerConcurrency, workerBatchSize: apiConfig.cleanupWorkerBatchSize,
      logger: dependencies.logger, startWorker: dependencies.startWorker });
    app.locals.ledgerRuntime = runtime;
    const identity = new AnonymousIdentity(process.env.NODE_ENV === "production");
    if (collectDiagnostics && diagnostics) app.use("/api/conversations", createDiagnosticsRouter(diagnostics, ledger, identity, apiConfig.webOrigin));
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
    app.use("/api/live/session", createLiveSessionRouter({ createLiveSession: dependencies.createLiveSession,
      leaseRegistry, webOrigin: apiConfig.webOrigin, logger: dependencies.logger }));
  }
  return app;
}
