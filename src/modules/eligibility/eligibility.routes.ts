import { Router, type Response } from "express";
import { z } from "zod";
import {
  evaluateWorkerEligibility,
  getComplianceSummary,
  MembershipNotFoundError,
  NoApplicableRequirementSetError,
  ComplianceCredentialTypeNotFoundError,
  ComplianceManagementForbiddenError,
  getComplianceConfiguration,
  listComplianceAudit,
  saveCompliancePolicy,
  saveCompliancePolicySchema,
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
  if (err instanceof ComplianceManagementForbiddenError) {
    res.status(403).json({ error: "COMPLIANCE_MANAGEMENT_FORBIDDEN" });
    return true;
  }
  if (err instanceof ComplianceCredentialTypeNotFoundError) {
    res.status(400).json({ error: "COMPLIANCE_CREDENTIAL_TYPE_NOT_FOUND" });
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

router.get(
  "/organizations/:organizationId/compliance/configuration",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuidParam.safeParse(req.params.organizationId);
    if (!organizationId.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
    try {
      const configuration = await getComplianceConfiguration(req.auth!.userId, organizationId.data);
      res.status(200).json(configuration);
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.put(
  "/organizations/:organizationId/compliance/configuration",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuidParam.safeParse(req.params.organizationId);
    const body = saveCompliancePolicySchema.safeParse(req.body);
    if (!organizationId.success || !body.success) {
      return void res.status(400).json({ error: "INVALID_PAYLOAD" });
    }
    try {
      const policy = await saveCompliancePolicy(req.auth!.userId, organizationId.data, body.data);
      res.status(200).json({ policy });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/compliance/audit",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuidParam.safeParse(req.params.organizationId);
    if (!organizationId.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
    try {
      const entries = await listComplianceAudit(req.auth!.userId, organizationId.data);
      res.status(200).json({ entries });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;
