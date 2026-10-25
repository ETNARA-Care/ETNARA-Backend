import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { respondInternalError } from "../../observability/internalError.js";
import {
  ShiftReportError, approveSchema, approveShiftReport, getShiftReports, listSchema, listShiftReports, refreshShiftReport,
} from "./shiftReports.service.js";

/**
 * Informe de Turno F1 routes (124). Behind SHIFT_REPORTS (orgFeatureGate: 404
 * FEATURE_NOT_ENABLED while off) and only for the agency's managers. Errors are
 * fixed codes; a 500 never carries internal detail or report content.
 */
const router = Router();
const uuid = z.string().uuid();

type Handler = (req: AuthenticatedRequest, organizationId: string) => Promise<unknown>;
function handle(status: number, work: Handler) {
  return async (req: Request, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    if (!org.success) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
    try {
      res.status(status).json(await work(req as AuthenticatedRequest, org.data));
    } catch (error) {
      if (error instanceof ShiftReportError) { res.status(error.status).json({ error: error.code }); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: "INVALID_PAYLOAD" }); return; }
      if (error instanceof MembershipNotActiveError) { res.status(403).json({ error: "SHIFT_REPORT_FORBIDDEN" }); return; }
      if (error instanceof InvalidTenantContextError) { res.status(400).json({ error: "INVALID_ID" }); return; }
      respondInternalError(res, "shift-reports", error, req);
    }
  };
}
const id = (req: Request, name: string) => uuid.parse(req.params[name]);
const user = (req: AuthenticatedRequest) => req.auth!.userId;

router.get("/organizations/:organizationId/shift-reports", requireAuth,
  handle(200, (req, org) => listShiftReports(user(req), org, listSchema.parse(req.query))));
router.get("/organizations/:organizationId/shifts/:shiftId/shift-reports", requireAuth,
  handle(200, (req, org) => getShiftReports(user(req), org, id(req, "shiftId"))));
router.post("/organizations/:organizationId/shift-reports/:reportId/refresh", requireAuth,
  handle(200, (req, org) => refreshShiftReport(user(req), org, id(req, "reportId"))));
router.post("/organizations/:organizationId/shift-reports/:reportId/approve", requireAuth,
  handle(200, (req, org) => approveShiftReport(user(req), org, id(req, "reportId"), approveSchema.parse(req.body ?? {}))));

export default router;
