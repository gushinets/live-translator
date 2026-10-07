import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { apiConfig } from "../config.js";
import { LedgerError } from "../accounting/types.js";
import type { RealtimeAttempts } from "../accounting/RealtimeAttempts.js";
import { AnonymousIdentity } from "../security/AnonymousIdentity.js";
import { requireOrigin, uuidSchema, parseBody } from "./conversations.js";

const createSchema = z.object({ attemptId: uuidSchema, generation: z.number().int().positive().max(1000000),
  admissionToken:uuidSchema,
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
const observationId=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const usageObservationSchema=z.discriminatedUnion("operation",[
  z.object({operation:z.literal("response"),responseId:observationId,usage:realtimeUsageSchema}).strict(),
  z.object({operation:z.literal("transcription"),itemId:observationId,contentIndex:z.number().int().min(0).max(31),
    usage:z.union([realtimeUsageSchema.extend({type:z.literal("tokens")}),z.object({type:z.literal("duration"),seconds:z.number().finite().min(0).max(3600)}).strip()])}).strict(),
]);
export function createRealtimeRouter(attempts: RealtimeAttempts | undefined, enabled: boolean, allowCreate: () => boolean) {
  const router = Router(), identity = new AnonymousIdentity(process.env.NODE_ENV === "production");
  router.use(requireOrigin(apiConfig.webOrigin));
  // Independent maintenance quotas keep cleanup available after a creation 429.
  const limiter=(limit:number)=>rateLimit({windowMs:60000,limit,ipv6Subnet:56,standardHeaders:"draft-8",legacyHeaders:false});
  router.post("/identity",limiter(60), (req,res) => {
    if (!enabled || !allowCreate() || !attempts) throw new LedgerError("realtime_disabled",403);
    const body=parseBody(z.object({attemptId:uuidSchema,generation:z.number().int().positive().max(1000000)}).strict(),req.body);
    const owner=identity.forCreation(req),prepared=attempts.prepare(owner,body.attemptId,body.generation);
    identity.renew(res,owner);res.status(201).json(prepared);
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
      const result = await attempts.create(owner,body.attemptId,body.generation,body.sdp,() => disconnected,body.admissionToken);
      if (disconnected) return;
      identity.renew(res,owner); res.status(201).json(result);
    } finally { req.removeListener("aborted",onDisconnect); res.once("finish",() => res.removeListener("close",onDisconnect)); }
  });
  router.post("/session/:id/cleanup",limiter(1000), async (req,res) => {
    const id = parseBody(uuidSchema,req.params.id); parseBody(z.object({}).strict(),req.body);
    if (!attempts) throw new LedgerError("not_found",404);
    const row = await attempts.cleanup(identity.require(req),id);
    res.json({ attemptId:row.id,state:row.state,closeConfirmed:row.close_confirmed === 1 });
  });
  router.put("/session/:id/usage",limiter(8192), (req,res) => {
    const id = parseBody(uuidSchema,req.params.id);
    const body = parseBody(usageObservationSchema,req.body);
    if (!attempts) throw new LedgerError("not_found",404);
    attempts.recordUsage(identity.require(req),id,body);
    res.status(204).send();
  });
  router.post("/session/:id/handoff",limiter(1000),(req,res)=> {
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
