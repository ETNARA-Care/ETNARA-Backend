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
  WorkerNotEligibleError,
  InvalidVerificationMethodError,
  AlreadyCheckedInError,
  NoActiveCheckInError,
  NotOrgManagerError,
} from "./verification.service.js";
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
  if (err instanceof WorkerNotEligibleError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof InvalidVerificationMethodError) {
    res.status(400).json({ error: "INVALID_VERIFICATION_METHOD" });
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
      const event = await checkIn(req.auth!.userId, orgIdParsed.data, String(req.params.shiftId), bodyParsed.data);
      res.status(201).json({ event });
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
      const event = await checkOut(req.auth!.userId, orgIdParsed.data, String(req.params.shiftId), bodyParsed.data);
      res.status(201).json({ event });
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

export default router;
