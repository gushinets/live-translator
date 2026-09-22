import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { LedgerRuntime } from "../accounting/LedgerRuntime.js";
import { END_REASONS, RESUME_ABORT_REASONS, LedgerError } from "../accounting/types.js";
import { publicConversation, publicAttempt } from "../accounting/publicMetadata.js";
import type { AnonymousIdentity } from "../security/AnonymousIdentity.js";
export const uuidSchema = z.string().uuid();
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const modeSchema = z.enum(["setup", "interpreter"]);
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body); if (!result.success) throw new LedgerError("invalid_request", 400); return result.data;
}
export function requireOrigin(origin: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!["GET", "HEAD"].includes(req.method) && req.get("Origin") !== origin) {
      res.status(403).json({ error: "Unexpected request origin", code: "unexpected_origin" }); return;
    }
    next();
  };
}
export function createConversationRouter(runtime: LedgerRuntime, identity: AnonymousIdentity, webOrigin: string, allowCreate = true) {
  const router = Router(), ledger = runtime.ledger;
  router.use(requireOrigin(webOrigin));
  const reply = (res: Response, owner: string, c: Parameters<typeof publicConversation>[0], status = 200) => {
    identity.renew(res, owner); runtime.syncAdmission(); runtime.wake(); res.status(status).json(publicConversation(c, ledger.now()));
  };
  router.post("/", (req, res) => {
    if (!allowCreate || !runtime.acceptingCreates) throw new LedgerError("new_creations_paused", 503);
    const body = parseBody(z.object({ createRequestId: uuidSchema, appVersion: z.string().min(1).max(64) }).strict(), req.body);
    const owner = identity.forCreation(req); reply(res, owner, ledger.createConversation(owner, body.createRequestId, body.appVersion), 201);
  });
  router.get("/:id", (req, res) => {
    const owner = identity.require(req), id = uuidSchema.parse(req.params.id), c = ledger.getConversation(owner, id);
    identity.renew(res, owner); runtime.syncAdmission(); runtime.wake();
    res.json({ ...publicConversation(c, ledger.now()), sessions: ledger.listAttempts(owner, id).map(publicAttempt) });
  });
  router.post("/:id/pause", (req, res) => {
    const body = parseBody(z.object({ expectedVersion: version }).strict(), req.body), owner = identity.require(req);
    reply(res, owner, ledger.pauseConversation(owner, req.params.id, body.expectedVersion));
  });
  router.post("/:id/end", (req, res) => {
    const body = parseBody(z.object({ expectedVersion: version, reason: z.enum(END_REASONS) }).strict(), req.body), owner = identity.require(req);
    reply(res, owner, ledger.endConversation(owner, req.params.id, body.expectedVersion, body.reason));
  });
  router.post("/:id/resume", (req, res) => {
    if (!allowCreate) throw new LedgerError("new_creations_paused", 503);
    const body = parseBody(z.object({ expectedVersion: version, resumeAttemptId: uuidSchema, initialMode: modeSchema }).strict(), req.body), owner = identity.require(req);
    const result = ledger.claimResume(owner, req.params.id, body.expectedVersion, body.resumeAttemptId, body.initialMode);
    identity.renew(res, owner); res.json({ ...publicConversation(result.conversation, ledger.now()), attempt: publicAttempt(result.attempt) });
  });
  router.post("/:id/resume/complete", (req, res) => {
    const body = parseBody(z.object({ expectedVersion: version, resumeAttemptId: uuidSchema, providerStartedObservedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), readyStage: modeSchema }).strict(), req.body), owner = identity.require(req);
    if (runtime.activationBlocked(body.resumeAttemptId)) throw new LedgerError("cleanup_pending");
    reply(res, owner, ledger.completeResume(owner, req.params.id, body.expectedVersion, body.resumeAttemptId, body.providerStartedObservedAt, body.readyStage));
  });
  router.post("/:id/resume/abort", (req, res) => {
    const body = parseBody(z.object({ expectedVersion: version, resumeAttemptId: uuidSchema, reason: z.enum(RESUME_ABORT_REASONS) }).strict(), req.body), owner = identity.require(req);
    reply(res, owner, ledger.abortResume(owner, req.params.id, body.expectedVersion, body.resumeAttemptId, body.reason));
  });
  return router;
}
