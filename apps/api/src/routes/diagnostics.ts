import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { UsageLedger } from "../accounting/UsageLedger.js";
import { DiagnosticError, type DiagnosticJournal, type DiagnosticConversation } from "../diagnostics/DiagnosticJournal.js";
import { diagnosticBatchSchema, parseDiagnosticEvent } from "../diagnostics/schema.js";
import type { AnonymousIdentity } from "../security/AnonymousIdentity.js";
import { requireOrigin, uuidSchema } from "./conversations.js";

export function createDiagnosticsRouter(journal: DiagnosticJournal, ledger: UsageLedger, identity: AnonymousIdentity, webOrigin: string) {
  const router = Router();
  router.post("/:id/diagnostics", requireOrigin(webOrigin), (req, res, next) => {
    try { identity.require(req); next(); } catch { res.status(401).json({ code: "identity_required" }); }
  }, rateLimit({ windowMs: 60000, limit: 120, keyGenerator: req => identity.require(req), standardHeaders: "draft-8", legacyHeaders: false }), (req, res) => {
    try {
      if (Buffer.byteLength(JSON.stringify(req.body), "utf8") > 32768) throw new DiagnosticError("diagnostics_batch_too_large", 413);
      const owner = identity.require(req), id = uuidSchema.parse(req.params.id);
      // Diagnostics must never advance lifecycle or expire a conversation while checking ownership.
      const conversation = ledger.db.prepare("SELECT id,anonymous_user_id,created_at FROM conversations WHERE id=? AND anonymous_user_id=?").get(id, owner) as unknown as DiagnosticConversation | undefined;
      if (!conversation) throw new DiagnosticError("not_found", 404);
      const batch = diagnosticBatchSchema.parse(req.body);
      const events = batch.events.map(event => parseDiagnosticEvent(event, journal.options.textEnabled ?? false));
      for (const event of events) {
        if (event.conversationId !== id || event.liveSessionId && !ledger.db.prepare("SELECT 1 FROM live_sessions WHERE id=? AND conversation_id=?").get(event.liveSessionId, id))
          throw new DiagnosticError("not_found", 404);
      }
      const receipt = journal.append(conversation, events);
      identity.renew(res, owner); res.json(receipt);
    } catch (error) {
      if (error instanceof DiagnosticError) res.status(error.status).json({ code: error.code });
      else if (error instanceof z.ZodError || error instanceof Error && ["invalid_event", "text_not_allowed"].includes(error.message)) res.status(400).json({ code: "invalid_diagnostic_event" });
      else { journal.warn(); res.status(503).json({ code: "diagnostics_unavailable" }); }
    }
  });
  return router;
}
