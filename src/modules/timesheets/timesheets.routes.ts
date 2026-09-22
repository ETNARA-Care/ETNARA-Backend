import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { OrganizationAccessDeniedError } from "../organizationContext/organizationContext.service.js";
import {
  FinancialRateMembershipNotFoundError,
  FinancialRateRequiredError,
  TimesheetAlreadyApprovedError,
  TimesheetForbiddenError,
  TimesheetNotFoundError,
  financialRateSchema,
  listFinancialRates,
  listTimesheets,
  reviewTimesheet,
  timesheetFiltersSchema,
  timesheetReviewSchema,
  upsertFinancialRate,
} from "./timesheets.service.js";

const router = Router();
const uuidParam = z.string().uuid();

function handleError(error: unknown, res: Response): boolean {
  if (
    error instanceof TimesheetForbiddenError
    || error instanceof MembershipNotActiveError
    || error instanceof OrganizationAccessDeniedError
  ) {
    res.status(403).json({ error: "TIMESHEET_FORBIDDEN" });
    return true;
  }
  if (error instanceof InvalidTenantContextError || error instanceof RangeError) {
    res.status(400).json({ error: error instanceof RangeError ? error.message : "INVALID_ID" });
    return true;
  }
  if (error instanceof FinancialRateMembershipNotFoundError || error instanceof TimesheetNotFoundError) {
    res.status(404).json({ error: error.message });
    return true;
  }
  if (error instanceof FinancialRateRequiredError || error instanceof TimesheetAlreadyApprovedError) {
    res.status(409).json({ error: error.message });
    return true;
  }
  return false;
}

router.get(
  "/organizations/:organizationId/financial-rates",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuidParam.safeParse(req.params.organizationId);
    if (!organizationId.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const rates = await listFinancialRates(req.auth!.userId, organizationId.data);
      res.status(200).json({ rates });
    } catch (error) {
      if (!handleError(error, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.put(
  "/organizations/:organizationId/financial-rates/:membershipId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuidParam.safeParse(req.params.organizationId);
    const membershipId = uuidParam.safeParse(req.params.membershipId);
    const input = financialRateSchema.safeParse(req.body);
    if (!organizationId.success || !membershipId.success || !input.success) {
      res.status(400).json({ error: "INVALID_FINANCIAL_RATE_REQUEST" });
      return;
    }
    try {
      const rate = await upsertFinancialRate(req.auth!.userId, organizationId.data, membershipId.data, input.data);
      res.status(200).json({ rate });
    } catch (error) {
      if (!handleError(error, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/timesheets",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuidParam.safeParse(req.params.organizationId);
    const filters = timesheetFiltersSchema.safeParse({
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      status: req.query.status || undefined,
    });
    if (!organizationId.success || !filters.success) {
      res.status(400).json({ error: "INVALID_TIMESHEET_FILTERS" });
      return;
    }
    try {
      const result = await listTimesheets(req.auth!.userId, organizationId.data, filters.data);
      res.status(200).json(result);
    } catch (error) {
      if (!handleError(error, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.post(
  "/organizations/:organizationId/timesheets/:timesheetId/review",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuidParam.safeParse(req.params.organizationId);
    const timesheetId = uuidParam.safeParse(req.params.timesheetId);
    const input = timesheetReviewSchema.safeParse(req.body);
    if (!organizationId.success || !timesheetId.success || !input.success) {
      res.status(400).json({ error: "INVALID_TIMESHEET_REVIEW" });
      return;
    }
    try {
      const timesheet = await reviewTimesheet(
        req.auth!.userId,
        organizationId.data,
        timesheetId.data,
        input.data
      );
      res.status(200).json({ timesheet });
    } catch (error) {
      if (!handleError(error, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;
