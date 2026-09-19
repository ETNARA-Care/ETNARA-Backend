import { Router, type Response } from "express";
import { z } from "zod";
import { MembershipNotActiveError, InvalidTenantContextError } from "../../context/errors.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import {
  CarePlanAccessDeniedError,
  CarePlanManagementForbiddenError,
  CarePlanRecipientNotFoundError,
  carePlanDetailsSchema,
  createCarePlanVersion,
  getActiveCarePlan,
} from "./carePlans.service.js";

const router = Router();
const uuidParam = z.string().uuid();

function handleError(error: unknown, res: Response): boolean {
  if (
    error instanceof CarePlanAccessDeniedError ||
    error instanceof CarePlanManagementForbiddenError ||
    error instanceof MembershipNotActiveError
  ) {
    res.status(403).json({ error: error instanceof CarePlanManagementForbiddenError ? "CARE_PLAN_MANAGEMENT_FORBIDDEN" : "CARE_PLAN_ACCESS_DENIED" });
    return true;
  }
  if (error instanceof CarePlanRecipientNotFoundError) {
    res.status(404).json({ error: "CARE_RECIPIENT_NOT_FOUND" });
    return true;
  }
  if (error instanceof InvalidTenantContextError) {
    res.status(400).json({ error: "INVALID_ID" });
    return true;
  }
  return false;
}

router.get(
  "/organizations/:organizationId/care-recipients/:recipientId/care-plan",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuidParam.safeParse(req.params.organizationId);
    const recipientId = uuidParam.safeParse(req.params.recipientId);
    if (!organizationId.success || !recipientId.success) {
      res.status(400).json({ error: "INVALID_ID" });
      return;
    }
    try {
      const carePlan = await getActiveCarePlan(
        req.auth!.userId,
        organizationId.data,
        recipientId.data
      );
      res.status(200).json({ carePlan });
    } catch (error) {
      if (!handleError(error, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.post(
  "/organizations/:organizationId/care-recipients/:recipientId/care-plan",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuidParam.safeParse(req.params.organizationId);
    const recipientId = uuidParam.safeParse(req.params.recipientId);
    const body = carePlanDetailsSchema.safeParse(req.body);
    if (!organizationId.success || !recipientId.success) {
      res.status(400).json({ error: "INVALID_ID" });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const carePlan = await createCarePlanVersion(
        req.auth!.userId,
        organizationId.data,
        recipientId.data,
        body.data
      );
      res.status(201).json({ carePlan });
    } catch (error) {
      if (!handleError(error, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;
