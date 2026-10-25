import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { respondInternalError } from "../../observability/internalError.js";
import {
  ShiftReportError, approveSchema, approveShiftReport, getShiftReports, grantShiftReportReviewer, listSchema, listShiftReportReviewers,
  listShiftReports, myShiftReportAccess, refreshShiftReport, returnSchema, returnShiftReport, reviewerGrantSchema, revokeShiftReportReviewer,
} from "./shiftReports.service.js";
import { familyShiftReportPdf, getFamilyShiftReport, listFamilyShiftReports, sendShiftReportPdf } from "./shiftReportsFamily.service.js";
import { getMyShiftReport, listMyShiftReports, observationSchema, setMyObservation, submitMyShiftReport } from "./shiftReportsCaregiver.service.js";

/**
 * Informe de Turno F1 routes (126). Behind SHIFT_REPORTS (orgFeatureGate: 404
 * FEATURE_NOT_ENABLED while off) and only for the agency's managers. Errors are
 * fixed codes; a 500 never carries internal detail or report content.
 */
const router = Router();
const uuid = z.string().uuid();

type Handler = (req: AuthenticatedRequest, organizationId: string) => Promise<unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the sender knows its own payload (F3 PDF)
function handle(status: number, work: Handler, send?: (res: Response, out: any) => void) {
  return async (req: Request, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    if (!org.success) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
    try {
      const out = await work(req as AuthenticatedRequest, org.data);
      if (send) send(res, out); else res.status(status).json(out);
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

router.post("/organizations/:organizationId/shift-reports/:reportId/return", requireAuth,
  handle(200, (req, org) => returnShiftReport(user(req), org, id(req, "reportId"), returnSchema.parse(req.body ?? {}))));

// F2 (128): the caregiver's own reports.
router.get("/organizations/:organizationId/me/shift-reports", requireAuth,
  handle(200, (req, org) => listMyShiftReports(user(req), org)));
router.get("/organizations/:organizationId/me/shift-reports/:reportId", requireAuth,
  handle(200, (req, org) => getMyShiftReport(user(req), org, id(req, "reportId"))));
router.post("/organizations/:organizationId/me/shift-reports/:reportId/observation", requireAuth,
  handle(200, (req, org) => setMyObservation(user(req), org, id(req, "reportId"), observationSchema.parse(req.body ?? {}))));
router.post("/organizations/:organizationId/me/shift-reports/:reportId/submit", requireAuth,
  handle(200, (req, org) => submitMyShiftReport(user(req), org, id(req, "reportId"))));

// F3 (129): the family reads approved reports of her own resident and downloads the PDF.
router.get("/organizations/:organizationId/care-recipients/:recipientId/shift-reports", requireAuth,
  handle(200, (req, org) => listFamilyShiftReports(user(req), org, id(req, "recipientId"))));
router.get("/organizations/:organizationId/care-recipients/:recipientId/shift-reports/:reportId", requireAuth,
  handle(200, (req, org) => getFamilyShiftReport(user(req), org, id(req, "recipientId"), id(req, "reportId"))));
router.get("/organizations/:organizationId/care-recipients/:recipientId/shift-reports/:reportId/pdf", requireAuth,
  handle(200, (req, org) => familyShiftReportPdf(user(req), org, id(req, "recipientId"), id(req, "reportId")), sendShiftReportPdf));

router.get("/organizations/:organizationId/shift-report-access", requireAuth,
  handle(200, (req, org) => myShiftReportAccess(user(req), org)));
router.get("/organizations/:organizationId/shift-report-reviewers", requireAuth,
  handle(200, (req, org) => listShiftReportReviewers(user(req), org)));
router.post("/organizations/:organizationId/shift-report-reviewers", requireAuth,
  handle(201, (req, org) => grantShiftReportReviewer(user(req), org, reviewerGrantSchema.parse(req.body ?? {}))));
router.post("/organizations/:organizationId/shift-report-reviewers/:membershipId/revoke", requireAuth,
  handle(200, (req, org) => revokeShiftReportReviewer(user(req), org, id(req, "membershipId"))));

export default router;
