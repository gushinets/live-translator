import { Router } from "express";
import type { LedgerRuntime } from "../accounting/LedgerRuntime.js";
import { usageReportSchema } from "../accounting/mergeUsage.js";
import { publicAttempt } from "../accounting/publicMetadata.js";
import type { AnonymousIdentity } from "../security/AnonymousIdentity.js";
import { parseBody, requireOrigin, uuidSchema } from "./conversations.js";

export function createUsageRouter(runtime: LedgerRuntime, identity: AnonymousIdentity, webOrigin: string) {
  const router = Router();
  router.put("/:localId/usage", requireOrigin(webOrigin), (req, res) => {
    const owner = identity.require(req), id = uuidSchema.parse(req.params.localId);
    const report = parseBody(usageReportSchema, req.body);
    // Provenance comes from this ingestion path, never from the request body.
    const result = runtime.ledger.recordUsage(owner, id, report, "browser");
    runtime.syncAdmission(); runtime.wake(); identity.renew(res, owner);
    res.json({ ...publicAttempt(result.row), schemaVersion: 1, appAccepted: result.appAccepted,
      appRejection: result.appRejection, activityReportSeq: result.row.activity_report_seq,
      appMetricsFinalized: Boolean(result.row.app_metrics_finalized) });
  });
  return router;
}
