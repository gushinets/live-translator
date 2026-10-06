import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { apiConfig } from "../config.js";
import { LedgerError } from "../accounting/types.js";
import type { RealtimeAttempts } from "../accounting/RealtimeAttempts.js";
import { AnonymousIdentity } from "../security/AnonymousIdentity.js";
import { requireOrigin, uuidSchema, parseBody } from "./conversations.js";

const createSchema = z.object({ attemptId: uuidSchema, generation: z.number().int().positive().max(1000000),
  sdp: z.string().min(1).max(64000).refine(s => s.trim().length > 0),
  languages: z.object({ A:z.enum(["ru","en"]), B:z.enum(["ru","en"]) }).strict().refine(l => l.A !== l.B),
}).strict();
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Explicit whitelist keeps transcript, payloads and arbitrary strings out of storage.
export const realtimeUsageSchema = z.object({ total_tokens:tokens, input_tokens:tokens, output_tokens:tokens,
  input_token_details: z.object({ cached_tokens:tokens.optional(), text_tokens:tokens.optional(), audio_tokens:tokens.optional(),
    image_tokens:tokens.optional(), cached_tokens_details:z.object({text_tokens:tokens.optional(),audio_tokens:tokens.optional(),image_tokens:tokens.optional()}).strip().optional() }).strip().optional(),
  output_token_details:z.object({text_tokens:tokens.optional(),audio_tokens:tokens.optional()}).strip().optional(),
}).strip();
export function createRealtimeRouter(attempts: RealtimeAttempts | undefined, enabled: boolean, allowCreate: () => boolean) {
  const router = Router(), identity = new AnonymousIdentity(process.env.NODE_ENV === "production");
  router.use(requireOrigin(apiConfig.webOrigin));
  router.post("/identity", (req,res) => {
    if (!enabled || !allowCreate()) throw new LedgerError("realtime_disabled",403);
    identity.renew(res, identity.forCreation(req)); res.status(204).send();
  });
  router.post("/session", async (req,res) => {
    if (!enabled || !allowCreate() || !attempts) throw new LedgerError("realtime_disabled",403);
    const owner = identity.require(req), body = parseBody(createSchema,req.body);
    if (!process.env.OPENAI_API_KEY?.trim()) throw new LedgerError("provider_key_missing",503);
    let disconnected = req.aborted || res.destroyed;
    const onDisconnect = () => {
      if (res.writableFinished) return;
      disconnected = true;
      void attempts.cleanup(owner,body.attemptId).catch(() => console.error("Realtime disconnect cleanup pending"));
    };
    req.once("aborted",onDisconnect); res.once("close",onDisconnect);
    try {
      const result = await attempts.create(owner,body.attemptId,body.generation,body.sdp,() => disconnected);
      if (disconnected) return;
      identity.renew(res,owner); res.status(201).json(result);
    } finally { req.removeListener("aborted",onDisconnect); res.once("finish",() => res.removeListener("close",onDisconnect)); }
  });
  router.post("/session/:id/cleanup", async (req,res) => {
    const id = parseBody(uuidSchema,req.params.id); parseBody(z.object({}).strict(),req.body);
    if (!attempts) throw new LedgerError("not_found",404);
    const row = await attempts.cleanup(identity.require(req),id);
    res.json({ attemptId:row.id,state:row.state,closeConfirmed:row.close_confirmed === 1 });
  });
  router.put("/session/:id/usage", (req,res) => {
    const id = parseBody(uuidSchema,req.params.id);
    const body = parseBody(z.object({responseId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),usage:realtimeUsageSchema}).strict(),req.body);
    if (!attempts) throw new LedgerError("not_found",404);
    attempts.recordUsage(identity.require(req),id,body.responseId,body.usage);
    res.status(204).send();
  });
  router.post("/session/:id/handoff",(req,res)=> {
    const id=parseBody(uuidSchema,req.params.id);parseBody(z.object({}).strict(),req.body);
    if(!attempts)throw new LedgerError("not_found",404);
    attempts.handoff(identity.require(req),id);res.status(204).send();
  });
  router.use((error: unknown,_req:Request,res:Response,_next:NextFunction) => {
    if (res.headersSent) { _next(error); return; }
    const code = error instanceof LedgerError ? error.code : error instanceof z.ZodError ? "invalid_request" : "realtime_unavailable";
    res.status(error instanceof LedgerError ? error.status : error instanceof z.ZodError ? 400 : 503).json({error:code,code});
  });
  return router;
}
