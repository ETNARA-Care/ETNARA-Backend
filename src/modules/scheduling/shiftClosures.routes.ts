import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../../security/tenantAccessDenied.js";
import { MembershipNotActiveError, InvalidTenantContextError } from "../../context/errors.js";
import { respondInternalError } from "../../observability/internalError.js";
import {
  closeShiftSchema,
  closeShiftWithoutService,
  getShiftAttention,
  listClosuresSchema,
  listShiftClosures,
  omittedVisitCorrectionSchema,
  recordOmittedVisitCorrection,
  rectifyClosureSchema,
  rectifyShiftClosure,
  ShiftClosureError,
} from "./shiftClosures.service.js";

const router = Router();
const uuid = z.string().uuid();

function handle(status: number, fn: (req: AuthenticatedRequest, organizationId: string) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    if (!org.success) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
    try {
      res.status(status).json(await fn(req as AuthenticatedRequest, org.data));
    } catch (error) {
      if (isTenantAccessDenied(error)) { res.status(403).json(TENANT_ACCESS_DENIED_BODY); return; }
      if (error instanceof ShiftClosureError) { res.status(error.status).json({ error: error.code }); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: "INVALID_PAYLOAD" }); return; }
      if (error instanceof MembershipNotActiveError) { res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" }); return; }
      if (error instanceof InvalidTenantContextError) { res.status(400).json({ error: "INVALID_ID" }); return; }
      respondInternalError(res, "shift-closures", error, req);
    }
  };
}
const user = (req: AuthenticatedRequest) => req.auth!.userId;

router.get("/organizations/:organizationId/shifts/:shiftId/attention", requireAuth,
  handle(200, (req, org) => getShiftAttention(user(req), org, String(req.params.shiftId))));
router.post("/organizations/:organizationId/shifts/:shiftId/close-without-service", requireAuth,
  handle(201, async (req, org) => ({ closure: await closeShiftWithoutService(user(req), org, String(req.params.shiftId), closeShiftSchema.parse(req.body ?? {})) })));
router.post("/organizations/:organizationId/shifts/:shiftId/verification/omitted-visit-correction", requireAuth,
  handle(201, (req, org) => recordOmittedVisitCorrection(user(req), org, String(req.params.shiftId), omittedVisitCorrectionSchema.parse(req.body ?? {}))));
router.post("/organizations/:organizationId/shift-closures/:closureId/rectify", requireAuth,
  handle(200, async (req, org) => ({ closure: await rectifyShiftClosure(user(req), org, String(req.params.closureId), rectifyClosureSchema.parse(req.body ?? {})) })));
router.get("/organizations/:organizationId/shift-closures", requireAuth,
  handle(200, (req, org) => listShiftClosures(user(req), org, listClosuresSchema.parse(req.query ?? {}))));

export default router;
