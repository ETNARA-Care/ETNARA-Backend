import { Router, type Response } from "express";
import { z } from "zod";
import {
  createAssignment,
  listAssignments,
  removeAssignment,
  createAssignmentSchema,
  ShiftNotFoundError,
  MembershipNotInOrgError,
  WorkerNotEligibleError,
  ShiftCancelledError,
  DuplicateAssignmentError,
  ScheduleConflictError,
  AssignmentNotFoundError,
} from "./assignments.service.js";
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
  if (err instanceof ShiftNotFoundError || err instanceof MembershipNotInOrgError || err instanceof AssignmentNotFoundError) {
    // Same 404 for all three -- no enumeration signal about which
    // cross-tenant ID was actually the problem.
    res.status(404).json({ error: "NOT_FOUND" });
    return true;
  }
  if (err instanceof ShiftCancelledError) {
    res.status(409).json({ error: "SHIFT_CANCELLED" });
    return true;
  }
  if (err instanceof WorkerNotEligibleError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof DuplicateAssignmentError) {
    res.status(409).json({ error: "ASSIGNMENT_ALREADY_EXISTS" });
    return true;
  }
  if (err instanceof ScheduleConflictError) {
    res.status(409).json({ error: "SCHEDULE_CONFLICT" });
    return true;
  }
  return false;
}

router.post(
  "/organizations/:organizationId/shifts/:shiftId/assignments",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = createAssignmentSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const assignment = await createAssignment(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.shiftId),
        bodyParsed.data
      );
      res.status(201).json({ assignment });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/shifts/:shiftId/assignments",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const assignments = await listAssignments(req.auth!.userId, orgIdParsed.data, String(req.params.shiftId));
      res.status(200).json({ assignments });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.patch(
  "/organizations/:organizationId/shifts/:shiftId/assignments/:assignmentId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      await removeAssignment(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.shiftId),
        String(req.params.assignmentId),
        typeof req.body?.reason === "string" ? req.body.reason : undefined
      );
      res.status(200).json({ ok: true });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;
