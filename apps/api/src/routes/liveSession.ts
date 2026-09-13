import { Router } from "express";
import OpenAI from "openai";
import { z } from "zod";
import {
  makeLiveSessionCreator,
  type LiveSessionCreator,
} from "../openai/createLiveSession.js";
import type { LeaseRegistry } from "../security/SessionLeaseRegistry.js";

const liveSessionRequestSchema = z.object({
  sdp: z.string().refine((sdp) => sdp.trim().length > 0),
});

export interface LiveSessionRouteDependencies {
  createLiveSession?: LiveSessionCreator;
  leaseRegistry: LeaseRegistry;
  webOrigin: string;
  logger?: Pick<Console, "error">;
}

export function createLiveSessionRouter(
  dependencies: LiveSessionRouteDependencies,
) {
  const router = Router();
  const logger = dependencies.logger ?? console;
  let createLiveSession = dependencies.createLiveSession;

  router.post("/", async (request, response) => {
    if (request.get("Origin") !== dependencies.webOrigin) {
      response.status(403).json({ error: "Unexpected request origin" });
      return;
    }

    const parsedRequest = liveSessionRequestSchema.safeParse(request.body);
    if (!parsedRequest.success) {
      response.status(400).json({ error: "An SDP offer is required" });
      return;
    }

    if (
      process.env.OPENAI_API_KEY === undefined ||
      process.env.OPENAI_API_KEY.trim().length === 0
    ) {
      response
        .status(503)
        .json({ error: "Set OPENAI_API_KEY on the server" });
      return;
    }

    const lease = dependencies.leaseRegistry.acquire();
    if (lease === null) {
      response
        .status(429)
        .json({ error: "Concurrent session limit reached" });
      return;
    }

    try {
      if (createLiveSession === undefined) {
        createLiveSession = makeLiveSessionCreator();
      }
      const session = await createLiveSession(parsedRequest.data.sdp);
      response.status(201).json(session);
    } catch (error) {
      lease.release();
      if (error instanceof OpenAI.APIError) {
        const status = error.status ?? 502;
        logger.error("OpenAI Live session creation failed", {
          status,
        });
        response
          .status(status)
          .json({ error: "Live session creation failed" });
        return;
      }
      logger.error("Unexpected Live session creation failure", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  });

  return router;
}
