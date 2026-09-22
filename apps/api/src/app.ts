import express from "express";
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
  app.post("/api/live/session", sessionCreationLimiter);
  app.use(
    "/api/live/session",
    createLiveSessionRouter({
      createLiveSession: dependencies.createLiveSession,
      leaseRegistry,
      webOrigin: apiConfig.webOrigin,
      logger: dependencies.logger,
    }),
  );
  return app;
}
