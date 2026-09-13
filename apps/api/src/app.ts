import express from "express";
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

  app.use(express.json({ limit: "64kb" }));
  app.get("/health", (_request, response) => response.json({ status: "ok" }));
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
