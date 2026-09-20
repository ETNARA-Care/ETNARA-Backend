import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import {
  CoverageCampaignAlreadyOpenError, CoverageOfferAlreadyRespondedError, CoverageOfferForbiddenError,
  CoverageOfferNoCandidatesError, CoverageOfferNotFoundError, CoverageOfferShiftNotFoundError,
  listMyCoverageOffers, listShiftCoverageOffers, openCoverageCampaign, openCoverageCampaignSchema,
  respondCoverageOffer, respondCoverageOfferSchema,
} from "./coverageOffers.service.js";

const router = Router();
const uuid = z.string().uuid();
function fail(error: unknown, res: Response): void {
  if (error instanceof CoverageOfferForbiddenError) res.status(403).json({ error: "COVERAGE_OFFER_FORBIDDEN" });
  else if (error instanceof CoverageOfferShiftNotFoundError || error instanceof CoverageOfferNotFoundError) res.status(404).json({ error: "NOT_FOUND" });
  else if (error instanceof CoverageCampaignAlreadyOpenError) res.status(409).json({ error: "COVERAGE_CAMPAIGN_ALREADY_OPEN" });
  else if (error instanceof CoverageOfferNoCandidatesError) res.status(409).json({ error: "NO_AVAILABLE_CANDIDATES" });
  else if (error instanceof CoverageOfferAlreadyRespondedError) res.status(409).json({ error: "COVERAGE_OFFER_ALREADY_RESPONDED" });
  else res.status(500).json({ error: "INTERNAL_ERROR" });
}

router.post("/organizations/:organizationId/shifts/:shiftId/coverage-campaigns", requireAuth, async (req: AuthenticatedRequest, res) => {
  const org = uuid.safeParse(req.params.organizationId); const shift = uuid.safeParse(req.params.shiftId); const body = openCoverageCampaignSchema.safeParse(req.body);
  if (!org.success || !shift.success || !body.success) { res.status(400).json({ error: "INVALID_COVERAGE_CAMPAIGN" }); return; }
  try { res.status(201).json({ campaign: await openCoverageCampaign(req.auth!.userId, org.data, shift.data, body.data) }); } catch (error) { fail(error, res); }
});
router.get("/organizations/:organizationId/shifts/:shiftId/coverage-offers", requireAuth, async (req: AuthenticatedRequest, res) => {
  const org = uuid.safeParse(req.params.organizationId); const shift = uuid.safeParse(req.params.shiftId);
  if (!org.success || !shift.success) { res.status(400).json({ error: "INVALID_ID" }); return; }
  try { res.status(200).json({ offers: await listShiftCoverageOffers(req.auth!.userId, org.data, shift.data) }); } catch (error) { fail(error, res); }
});
router.get("/organizations/:organizationId/me/coverage-offers", requireAuth, async (req: AuthenticatedRequest, res) => {
  const org = uuid.safeParse(req.params.organizationId); if (!org.success) { res.status(400).json({ error: "INVALID_ID" }); return; }
  try { res.status(200).json({ offers: await listMyCoverageOffers(req.auth!.userId, org.data) }); } catch (error) { fail(error, res); }
});
router.post("/organizations/:organizationId/me/coverage-offers/:offerId/respond", requireAuth, async (req: AuthenticatedRequest, res) => {
  const org = uuid.safeParse(req.params.organizationId); const offer = uuid.safeParse(req.params.offerId); const body = respondCoverageOfferSchema.safeParse(req.body);
  if (!org.success || !offer.success || !body.success) { res.status(400).json({ error: "INVALID_COVERAGE_RESPONSE" }); return; }
  try { res.status(200).json({ offer: await respondCoverageOffer(req.auth!.userId, org.data, offer.data, body.data) }); } catch (error) { fail(error, res); }
});
export default router;
