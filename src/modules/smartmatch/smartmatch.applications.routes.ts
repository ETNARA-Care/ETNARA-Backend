import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { MembershipNotActiveError } from "../../context/errors.js";
import { SmartMatchForbiddenError } from "./smartmatch.service.js";
import {
  submitSmartMatchApplication, withdrawSmartMatchApplication, listMySmartMatchApplications,
  getSmartMatchApplicationReview, listSmartMatchOpportunityApplications,
  decideSmartMatchApplication, listSmartMatchApplicationEvents,
  SmartMatchNotAvailableError, SmartMatchDuplicateApplicationError,
  SmartMatchApplicationNotFoundError, SmartMatchConflictError,
} from "./smartmatch.applications.service.js";
import {
  SMARTMATCH_CONSENT_VERSION, smartMatchApplySchema, smartMatchDecisionSchema,
} from "./smartmatch.applications.schemas.js";

const uuid = z.string().uuid();

const router = Router();

function fail(res: Response, error: unknown): void {
  if (error instanceof SmartMatchForbiddenError || error instanceof MembershipNotActiveError) {
    res.status(403).json({ error: "FORBIDDEN" }); return;
  }
  if (error instanceof SmartMatchApplicationNotFoundError) { res.status(404).json({ error: "NOT_FOUND" }); return; }
  if (error instanceof SmartMatchNotAvailableError) { res.status(404).json({ error: "OPPORTUNITY_NOT_AVAILABLE" }); return; }
  if (error instanceof SmartMatchDuplicateApplicationError) { res.status(409).json({ error: "DUPLICATE_APPLICATION" }); return; }
  if (error instanceof SmartMatchConflictError) { res.status(409).json({ error: error.reason }); return; }
  // Deadlock / serialization failure: nothing was committed; safe to retry.
  const code = (error as { code?: string })?.code;
  if (code === "40P01" || code === "40001") { res.status(409).json({ error: "CONCURRENT_UPDATE_RETRY" }); return; }
  console.error("SMARTMATCH_APPLICATIONS_ERROR", { code: (error as { code?: string })?.code });
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

// ---------------------------------------------------------------- caregiver

router.post("/organizations/:organizationId/smartmatch/opportunities/:opportunityId/applications",
  requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    const opp = uuid.safeParse(req.params.opportunityId);
    const body = smartMatchApplySchema.safeParse(req.body);
    if (!org.success || !opp.success) { res.status(400).json({ error: "INVALID_ID" }); return; }
    if (!body.success) { res.status(400).json({ error: "CONSENT_REQUIRED", consentVersion: SMARTMATCH_CONSENT_VERSION }); return; }
    try {
      const application = await submitSmartMatchApplication(req.auth!.userId, org.data, opp.data, body.data.consentVersion);
      res.status(201).json({ application });
    } catch (error) { fail(res, error); }
  });

router.post("/organizations/:organizationId/smartmatch/applications/:applicationId/withdraw",
  requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    const app = uuid.safeParse(req.params.applicationId);
    if (!org.success || !app.success) { res.status(400).json({ error: "INVALID_ID" }); return; }
    try {
      const application = await withdrawSmartMatchApplication(req.auth!.userId, org.data, app.data);
      res.status(200).json({ application });
    } catch (error) { fail(res, error); }
  });

router.get("/organizations/:organizationId/smartmatch/my-applications",
  requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    if (!org.success) { res.status(400).json({ error: "INVALID_ID" }); return; }
    try {
      const applications = await listMySmartMatchApplications(req.auth!.userId, org.data);
      res.status(200).json({ applications, consentVersion: SMARTMATCH_CONSENT_VERSION });
    } catch (error) { fail(res, error); }
  });

// ------------------------------------------------------------------- agency

router.get("/organizations/:organizationId/smartmatch/opportunities/:opportunityId/review-queue",
  requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    const opp = uuid.safeParse(req.params.opportunityId);
    if (!org.success || !opp.success) { res.status(400).json({ error: "INVALID_ID" }); return; }
    try {
      const applications = await listSmartMatchOpportunityApplications(req.auth!.userId, org.data, opp.data);
      res.status(200).json({ applications });
    } catch (error) { fail(res, error); }
  });

router.get("/organizations/:organizationId/smartmatch/applications/:applicationId/review",
  requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    const app = uuid.safeParse(req.params.applicationId);
    if (!org.success || !app.success) { res.status(400).json({ error: "INVALID_ID" }); return; }
    try {
      res.status(200).json(await getSmartMatchApplicationReview(req.auth!.userId, org.data, app.data));
    } catch (error) { fail(res, error); }
  });

router.post("/organizations/:organizationId/smartmatch/applications/:applicationId/decision",
  requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    const app = uuid.safeParse(req.params.applicationId);
    const body = smartMatchDecisionSchema.safeParse(req.body);
    if (!org.success || !app.success) { res.status(400).json({ error: "INVALID_ID" }); return; }
    if (!body.success) { res.status(400).json({ error: "INVALID_DECISION" }); return; }
    try {
      const result = await decideSmartMatchApplication(req.auth!.userId, org.data, app.data, body.data.decision);
      if (result.outcome === "BLOCKED") {
        res.status(409).json({ error: "APPROVAL_BLOCKED", checks: result.checks }); return;
      }
      res.status(200).json(result);
    } catch (error) { fail(res, error); }
  });

router.get("/organizations/:organizationId/smartmatch/applications/:applicationId/events",
  requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    const app = uuid.safeParse(req.params.applicationId);
    if (!org.success || !app.success) { res.status(400).json({ error: "INVALID_ID" }); return; }
    try {
      const events = await listSmartMatchApplicationEvents(req.auth!.userId, org.data, app.data);
      res.status(200).json({ events });
    } catch (error) { fail(res, error); }
  });

export default router;
