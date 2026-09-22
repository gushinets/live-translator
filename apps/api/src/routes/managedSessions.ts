import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { LedgerRuntime } from "../accounting/LedgerRuntime.js";
import { CLIENT_CLEANUP_REASONS, LedgerError } from "../accounting/types.js";
import { publicAttempt, publicConversation } from "../accounting/publicMetadata.js";
import type { AnonymousIdentity } from "../security/AnonymousIdentity.js";
import { modeSchema, parseBody, requireOrigin, uuidSchema } from "./conversations.js";
const creationSchema = z.object({
  sdp: z.string().min(1).max(64000).refine(s => s.trim().length > 0), conversationId: uuidSchema,
  conversationVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), liveSessionId: uuidSchema,
  initialMode: modeSchema, startReason: z.enum(["initial", "bootstrap_replacement", "resume"]),
}).strict();
export function createManagedSessionRouter(runtime: LedgerRuntime, identity: AnonymousIdentity, webOrigin: string, allowCreate = true) {
  const router = Router(), ledger = runtime.ledger;
  router.use(requireOrigin(webOrigin));
  router.post("/", async (req, res) => {
    if (!allowCreate) throw new LedgerError("new_creations_paused", 503);
    if (typeof req.body === "object" && req.body !== null && !("conversationId" in req.body)) throw new LedgerError("client_upgrade_required", 400);
    const body = parseBody(creationSchema, req.body), owner = identity.require(req);
    ledger.getConversation(owner, body.conversationId);
    if (!process.env.OPENAI_API_KEY?.trim()) throw new LedgerError("provider_key_missing", 503);
    let disconnected = req.aborted || res.destroyed, finished = false;
    const onDisconnect = () => {
      if (finished || res.writableFinished) return; disconnected = true;
      try { ledger.getAttempt(owner, body.liveSessionId); runtime.cleanup(body.liveSessionId, "client_disconnected"); }
      catch { /* The runtime retains a failed post-dispatch fence; pre-dispatch flag is rechecked. */ }
    };
    const onFinish = () => { finished = true; };
    req.once("aborted", onDisconnect); res.once("close", onDisconnect); res.once("finish", onFinish);
    try {
      const result = await runtime.create(owner, { ...body, fingerprint: createHash("sha256").update(body.sdp).digest("hex") }, body.sdp, () => disconnected);
      if (disconnected || res.destroyed) return;
      const row = ledger.getAttempt(owner, body.liveSessionId);
      if (row.cleanup_requested_at !== null || row.state !== "creating" || runtime.activationBlocked(row.id)) throw new LedgerError("attempt_not_activatable");
      identity.renew(res, owner);
      res.status(201).json({ ...result, accounting: publicAttempt(row), ...publicConversation(ledger.getConversation(owner, body.conversationId), ledger.now()) });
    } finally {
      req.removeListener("aborted", onDisconnect);
      // Handler completion is not receipt. Keep premature response-close fencing until finish.
      res.once("finish", () => { res.removeListener("close", onDisconnect); res.removeListener("finish", onFinish); });
    }
  });
  router.get("/:id", (req, res) => {
    const owner = identity.require(req), row = ledger.getAttempt(owner, req.params.id), c = ledger.getConversation(owner, row.conversation_id);
    identity.renew(res, owner); runtime.syncAdmission(); runtime.wake();
    res.json({ ...publicAttempt(ledger.getAttempt(owner, row.id)), conversation: publicConversation(c, ledger.now()) });
  });
  router.post("/:id/handoff", (req, res) => {
    parseBody(z.object({}).strict(), req.body); const owner = identity.require(req);
    ledger.getAttempt(owner, req.params.id);
    if (runtime.activationBlocked(req.params.id)) throw new LedgerError("cleanup_pending");
    const row = ledger.acknowledgeHandoff(owner, req.params.id);
    identity.renew(res, owner); runtime.syncAdmission();
    res.json({ ...publicAttempt(row), conversation: publicConversation(ledger.getConversation(owner, row.conversation_id), ledger.now()) });
  });
  router.post("/:id/cleanup", (req, res) => {
    const body = parseBody(z.object({ reason: z.enum(CLIENT_CLEANUP_REASONS) }).strict(), req.body), owner = identity.require(req);
    ledger.getAttempt(owner, req.params.id); runtime.cleanup(req.params.id, body.reason);
    identity.renew(res, owner); res.json(publicAttempt(ledger.getAttempt(owner, req.params.id)));
  });
  // Minimal terminal observation in stage 2; cumulative/app usage ingestion remains stage 3.
  router.post("/:id/closed", (req, res) => {
    const body = parseBody(z.object({ seconds: z.number().nonnegative().optional(), reason: z.string().max(256).optional() }).strict(), req.body), owner = identity.require(req);
    ledger.getAttempt(owner, req.params.id); const row = ledger.recordProviderClosed(req.params.id, body, "browser");
    runtime.syncAdmission(); identity.renew(res, owner); res.json(publicAttempt(row));
  });
  router.delete("/:id", (req, res) => {
    const owner = identity.require(req); ledger.releaseAdmission(owner, req.params.id);
    runtime.syncAdmission(); identity.renew(res, owner); res.status(204).send();
  });
  return router;
}
