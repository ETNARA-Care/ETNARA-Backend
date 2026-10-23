import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { MembershipNotActiveError } from "../../context/errors.js";
import { SmartMatchForbiddenError } from "./smartmatch.service.js";
import { SmartMatchApplicationNotFoundError, SmartMatchConflictError } from "./smartmatch.applications.service.js";
import {
  createShiftFromSmartMatch, getSmartMatchShiftDraft, cancelSmartMatchOpportunity, listSmartMatchOpportunityHistory, smartMatchCancelSchema, getShiftPrivateInstructions, saveShiftPrivateInstructions,
  smartMatchCreateShiftSchema, shiftPrivateInstructionsSchema,
} from "./smartmatch.shifts.service.js";
import { RecipientNotInOrgError, InvalidShiftTimesError } from "../scheduling/scheduling.service.js";
import { LocationNotFoundError } from "../careRecipients/serviceLocations.service.js";
import {
  ShiftNotFoundError, MembershipNotInOrgError, ShiftCancelledError, WorkerNotEligibleError,
  DuplicateAssignmentError, ScheduleConflictError,
} from "../assignments/assignments.service.js";
import { MembershipNotFoundError, NoApplicableRequirementSetError } from "../eligibility/eligibility.service.js";

const uuid = z.string().uuid();
const router = Router();

function fail(res: Response, error: unknown): void {
  if (error instanceof SmartMatchForbiddenError || error instanceof MembershipNotActiveError) {
    res.status(403).json({ error: "FORBIDDEN" }); return;
  }
  if (error instanceof SmartMatchApplicationNotFoundError || error instanceof ShiftNotFoundError) {
    res.status(404).json({ error: "NOT_FOUND" }); return;
  }
  if (error instanceof SmartMatchConflictError) { res.status(409).json({ error: error.reason }); return; }
  if (error instanceof LocationNotFoundError) { res.status(400).json({ error: "SERVICE_LOCATION_NOT_IN_RECIPIENT" }); return; }
  if (error instanceof RecipientNotInOrgError) { res.status(400).json({ error: "RECIPIENT_NOT_IN_AGENCY" }); return; }
  if (error instanceof InvalidShiftTimesError) { res.status(400).json({ error: "INVALID_SHIFT_TIMES" }); return; }
  if (error instanceof ScheduleConflictError) { res.status(409).json({ error: "SCHEDULE_CONFLICT" }); return; }
  if (error instanceof DuplicateAssignmentError) { res.status(409).json({ error: "ASSIGNMENT_ALREADY_EXISTS" }); return; }
  if (error instanceof ShiftCancelledError) { res.status(409).json({ error: "SHIFT_CANCELLED" }); return; }
  if (error instanceof WorkerNotEligibleError || error instanceof MembershipNotInOrgError
    || error instanceof MembershipNotFoundError || error instanceof NoApplicableRequirementSetError) {
    res.status(409).json({ error: "CAREGIVER_NOT_READY" }); return;
  }
  const code = (error as { code?: string })?.code;
  // Two administrators at once: the opportunity row lock serializes them; a
  // unique-index race (23505) or deadlock still means "already created / retry".
  if (code === "23505") { res.status(409).json({ error: "SHIFT_ALREADY_CREATED" }); return; }
  if (code === "40P01" || code === "40001") { res.status(409).json({ error: "CONCURRENT_UPDATE_RETRY" }); return; }
  console.error("SMARTMATCH_SHIFT_ERROR", { code });
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

function ids(req: AuthenticatedRequest, res: Response, key: string): [string, string] | null {
  const org = uuid.safeParse(req.params.organizationId);
  const id = uuid.safeParse(req.params[key]);
  if (!org.success || !id.success) { res.status(400).json({ error: "INVALID_ID" }); return null; }
  return [org.data, id.data];
}

router.get("/organizations/:organizationId/smartmatch/opportunities/:opportunityId/shift-draft", requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const p = ids(req, res, "opportunityId"); if (!p) return;
    try { res.json(await getSmartMatchShiftDraft(req.auth!.userId, p[0], p[1])); } catch (e) { fail(res, e); }
  });

router.post("/organizations/:organizationId/smartmatch/opportunities/:opportunityId/shift", requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const p = ids(req, res, "opportunityId"); if (!p) return;
    const body = smartMatchCreateShiftSchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "INVALID_REQUEST" }); return; }
    try { res.status(201).json(await createShiftFromSmartMatch(req.auth!.userId, p[0], p[1], body.data)); }
    catch (e) { fail(res, e); }
  });

router.get("/organizations/:organizationId/shifts/:shiftId/private-instructions", requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const p = ids(req, res, "shiftId"); if (!p) return;
    try {
      const row = await getShiftPrivateInstructions(req.auth!.userId, p[0], p[1]);
      if (!row) { res.status(404).json({ error: "NOT_FOUND" }); return; }
      res.json({ instructions: row });
    } catch (e) { fail(res, e); }
  });

router.put("/organizations/:organizationId/shifts/:shiftId/private-instructions", requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const p = ids(req, res, "shiftId"); if (!p) return;
    const body = shiftPrivateInstructionsSchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "INVALID_REQUEST" }); return; }
    try { res.json({ instructions: await saveShiftPrivateInstructions(req.auth!.userId, p[0], p[1], body.data.instructions) }); }
    catch (e) { fail(res, e); }
  });

router.post("/organizations/:organizationId/smartmatch/opportunities/:opportunityId/cancel", requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const p = ids(req, res, "opportunityId"); if (!p) return;
    const body = smartMatchCancelSchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "INVALID_REQUEST" }); return; }
    try { res.json(await cancelSmartMatchOpportunity(req.auth!.userId, p[0], p[1], body.data)); }
    catch (e) { fail(res, e); }
  });

router.get("/organizations/:organizationId/smartmatch/opportunities/:opportunityId/history", requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const p = ids(req, res, "opportunityId"); if (!p) return;
    try { res.json({ history: await listSmartMatchOpportunityHistory(req.auth!.userId, p[0], p[1]) }); }
    catch (e) { fail(res, e); }
  });

export default router;
