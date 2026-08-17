import { Router, type Response } from "express";
import { z } from "zod";
import {
  evaluateWorkerEligibility,
  getComplianceSummary,
  MembershipNotFoundError,
  NoApplicableRequirementSetError,
} from "./eligibility.service.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import {
  OrganizationAccessDeniedError,
  InvalidOrganizationIdError,
} from "../organizationContext/organizationContext.service.js";
import { MembershipNotActiveError, InvalidTenantContextError } from "../../context/errors.js";

const router = Router();
const uuidParam = z.string().uuid();

function handleError(err: unknown, res: Response): boolean {
  if (err instanceof MembershipNotActiveError || err instanceof OrganizationAccessDeniedError) {
    res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" });
    return true;
  }
  if (err instanceof InvalidTenantContextError || err instanceof InvalidOrganizationIdError) {
    res.status(400).json({ error: "INVALID_ID" });
    return true;
  }
  if (err instanceof MembershipNotFoundError) {
    res.status(404).json({ error: "MEMBERSHIP_NOT_FOUND" });
    return true;
  }
  if (err instanceof NoApplicableRequirementSetError) {
    res.status(404).json({ error: "NO_APPLICABLE_REQUIREMENT_SET" });
    return true;
  }
  return false;
}

// No POST/PUT endpoint accepts an eligibility value from the client --
// evaluation is the ONLY write path, and it is 100% derived from DB state.
router.post(
  "/organizations/:organizationId/workers/:membershipId/eligibility/evaluate",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const result = await evaluateWorkerEligibility(req.auth!.userId, orgIdParsed.data, String(req.params.membershipId));
      res.status(200).json(result);
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/workers/:membershipId/compliance",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const summary = await getComplianceSummary(req.auth!.userId, orgIdParsed.data, String(req.params.membershipId));
      res.status(200).json(summary);
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;
