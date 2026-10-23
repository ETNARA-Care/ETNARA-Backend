import { Router, type Response } from "express";
import { z } from "zod";
import {
  checkIn,
  checkOut,
  getVerification,
  supervisorOverrideCheckEvent,
  checkInSchema,
  checkOutSchema,
  supervisorOverrideSchema,
  WorkerNotLinkedError,
  ShiftNotFoundError,
  ShiftCancelledError,
  ShiftCompletedError,
  NoAssignmentError,
  AssignmentNotAcceptedError,
  WorkerNotEligibleError,
  InvalidVerificationMethodError,
  AlreadyCheckedInError,
  OccurredAtOutOfRangeError,
  NoActiveCheckInError,
  NotOrgManagerError,
} from "./verification.service.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import {
  AlreadyArrivedError, ArrivalAfterCheckInError, ArrivalOutsideWindowError, LocationConsentRequiredError, NoArrivalToReviewError,
  arrivalReviewSchema, arrivalSchema, consentSchema,
  getMyLocationConsent, grantLocationConsent, recordArrival, reviewArrival, revokeLocationConsent,
} from "./verification.arrival.js";
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
  if (err instanceof WorkerNotLinkedError) {
    res.status(403).json({ error: "USER_HAS_NO_WORKER_PROFILE" });
    return true;
  }
  if (err instanceof ShiftNotFoundError || err instanceof NoAssignmentError) {
    // Same 404 for both -- no enumeration signal about whether the shift
    // exists elsewhere or this worker simply isn't assigned to it.
    res.status(404).json({ error: "NOT_FOUND" });
    return true;
  }
  if (err instanceof ShiftCancelledError) {
    res.status(409).json({ error: "SHIFT_CANCELLED" });
    return true;
  }
  if (err instanceof ShiftCompletedError) {
    res.status(409).json({ error: "SHIFT_COMPLETED" });
    return true;
  }
  if (err instanceof AssignmentNotAcceptedError) {
    res.status(409).json({ error: "ASSIGNMENT_NOT_ACCEPTED" });
    return true;
  }
  if (err instanceof WorkerNotEligibleError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof InvalidVerificationMethodError) {
    res.status(400).json({ error: "INVALID_VERIFICATION_METHOD" });
    return true;
  }
  if (err instanceof OccurredAtOutOfRangeError) {
    res.status(400).json({ error: "OCCURRED_AT_OUT_OF_RANGE" });
    return true;
  }
  if (err instanceof AlreadyCheckedInError) {
    res.status(409).json({ error: "ALREADY_CHECKED_IN" });
    return true;
  }
  if (err instanceof NoActiveCheckInError) {
    res.status(409).json({ error: "NO_ACTIVE_CHECK_IN" });
    return true;
  }
  if (err instanceof ArrivalOutsideWindowError) {
    res.status(409).json({ error: "ARRIVAL_OUTSIDE_WINDOW" });
    return true;
  }
  if (err instanceof AlreadyArrivedError || err instanceof ArrivalAfterCheckInError || err instanceof NoArrivalToReviewError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof LocationConsentRequiredError) {
    res.status(400).json({ error: "LOCATION_CONSENT_REQUIRED" });
    return true;
  }
  if (err instanceof NotOrgManagerError) {
    res.status(403).json({ error: "SUPERVISOR_OVERRIDE_REQUIRES_ORG_MANAGER" });
    return true;
  }
  return false;
}

router.post(
  "/organizations/:organizationId/shifts/:shiftId/check-in",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = checkInSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const { replayed, ...event } = await checkIn(req.auth!.userId, orgIdParsed.data, String(req.params.shiftId), bodyParsed.data);
      res.status(replayed ? 200 : 201).json({ event, replayed: replayed === true });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.post(
  "/organizations/:organizationId/shifts/:shiftId/check-out",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = checkOutSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const { replayed, ...event } = await checkOut(req.auth!.userId, orgIdParsed.data, String(req.params.shiftId), bodyParsed.data);
      res.status(replayed ? 200 : 201).json({ event, replayed: replayed === true });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/shifts/:shiftId/visit-verification",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const summary = await getVerification(req.auth!.userId, orgIdParsed.data, String(req.params.shiftId));
      res.status(200).json(summary);
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.post(
  "/organizations/:organizationId/shifts/:shiftId/verification/supervisor-override",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = supervisorOverrideSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const event = await supervisorOverrideCheckEvent(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.shiftId),
        bodyParsed.data
      );
      res.status(201).json({ event });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

// ---------------------------------------------------------------- Gate 6: arrival
// Request bodies here may carry one device reading: never log them.
function gate6(handler: (req: AuthenticatedRequest, res: Response, orgId: string) => Promise<void>) {
  return async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
    try { await handler(req, res, orgIdParsed.data); }
    catch (err) {
      if (handleError(err, res)) return;
      // Bounded diagnostics: the code only, never the body (it may carry a device reading).
      console.error("ARRIVAL_ERROR", { code: (err as { code?: string })?.code ?? "UNKNOWN" });
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  };
}
router.get("/organizations/:organizationId/me/location-consent", requireAuth, gate6(async (req, res, orgId) => {
  res.status(200).json(await getMyLocationConsent(req.auth!.userId, orgId));
}));
router.post("/organizations/:organizationId/me/location-consent", requireAuth, gate6(async (req, res, orgId) => {
  if (!consentSchema.safeParse(req.body).success) { res.status(400).json({ error: "INVALID_PAYLOAD" }); return; }
  res.status(201).json(await grantLocationConsent(req.auth!.userId, orgId));
}));
router.delete("/organizations/:organizationId/me/location-consent", requireAuth, gate6(async (req, res, orgId) => {
  res.status(200).json(await revokeLocationConsent(req.auth!.userId, orgId));
}));
router.post("/organizations/:organizationId/shifts/:shiftId/arrival", requireAuth, gate6(async (req, res, orgId) => {
  const shiftId = uuidParam.safeParse(req.params.shiftId);
  const body = arrivalSchema.safeParse(req.body ?? {});
  if (!shiftId.success || !body.success) { res.status(400).json({ error: "INVALID_PAYLOAD" }); return; }
  const arrival = await recordArrival(req.auth!.userId, orgId, shiftId.data, body.data);
  res.status("replayed" in arrival ? 200 : 201).json({ arrival });
}));
router.post("/organizations/:organizationId/shifts/:shiftId/arrival/review", requireAuth, gate6(async (req, res, orgId) => {
  const shiftId = uuidParam.safeParse(req.params.shiftId);
  const body = arrivalReviewSchema.safeParse(req.body ?? {});
  if (!shiftId.success || !body.success) { res.status(400).json({ error: "INVALID_PAYLOAD" }); return; }
  res.status(200).json(await reviewArrival(req.auth!.userId, orgId, shiftId.data, body.data));
}));

export default router;
