import { Router, type Response } from "express";
import { z } from "zod";
import {
  createShift,
  listShifts,
  getShift,
  updateShift,
  cancelShift,
  getCoverageSummary,
  createShiftSchema,
  updateShiftSchema,
  ShiftNotFoundError,
  InvalidShiftTimesError,
  RecipientNotInOrgError,
  RoomNotInOrgError,
} from "./scheduling.service.js";
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
  if (err instanceof ShiftNotFoundError) {
    res.status(404).json({ error: "SHIFT_NOT_FOUND" });
    return true;
  }
  if (err instanceof InvalidShiftTimesError) {
    res.status(400).json({ error: "INVALID_SHIFT_TIMES" });
    return true;
  }
  if (err instanceof RecipientNotInOrgError || err instanceof RoomNotInOrgError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  return false;
}

router.post(
  "/organizations/:organizationId/shifts",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = createShiftSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const shift = await createShift(req.auth!.userId, orgIdParsed.data, bodyParsed.data);
      res.status(201).json({ shift });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/shifts",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const shifts = await listShifts(req.auth!.userId, orgIdParsed.data, {
        dateFrom: req.query.dateFrom as string | undefined,
        dateTo: req.query.dateTo as string | undefined,
        status: req.query.status as string | undefined,
        careRecipientId: req.query.careRecipientId as string | undefined,
        coverage: req.query.assignmentStatus as "covered" | "uncovered" | undefined,
      });
      res.status(200).json({ shifts });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/shifts/coverage",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const summary = await getCoverageSummary(req.auth!.userId, orgIdParsed.data);
      res.status(200).json(summary);
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/shifts/:shiftId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const shift = await getShift(req.auth!.userId, orgIdParsed.data, String(req.params.shiftId));
      res.status(200).json({ shift });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.patch(
  "/organizations/:organizationId/shifts/:shiftId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = updateShiftSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const shift = await updateShift(req.auth!.userId, orgIdParsed.data, String(req.params.shiftId), bodyParsed.data);
      res.status(200).json({ shift });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.post(
  "/organizations/:organizationId/shifts/:shiftId/cancel",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const shift = await cancelShift(req.auth!.userId, orgIdParsed.data, String(req.params.shiftId));
      res.status(200).json({ shift });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;
