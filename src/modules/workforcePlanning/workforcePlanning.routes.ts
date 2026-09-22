import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { OrganizationAccessDeniedError } from "../organizationContext/organizationContext.service.js";
import {
  getWorkforceForecast,
  WorkforcePlanningForbiddenError,
  workforceForecastSchema,
} from "./workforcePlanning.service.js";

const router = Router();
const uuidParam = z.string().uuid();

router.get(
  "/organizations/:organizationId/workforce/forecast",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuidParam.safeParse(req.params.organizationId);
    const input = workforceForecastSchema.safeParse({
      startDate: req.query.startDate,
      days: req.query.days,
      timezone: req.query.timezone ?? "America/Puerto_Rico",
    });
    if (!organizationId.success || !input.success) {
      res.status(400).json({ error: "INVALID_WORKFORCE_FORECAST_REQUEST" });
      return;
    }

    try {
      const forecast = await getWorkforceForecast(req.auth!.userId, organizationId.data, input.data);
      res.status(200).json({ forecast });
    } catch (error) {
      if (
        error instanceof WorkforcePlanningForbiddenError
        || error instanceof MembershipNotActiveError
        || error instanceof OrganizationAccessDeniedError
      ) {
        res.status(403).json({ error: "WORKFORCE_PLANNING_FORBIDDEN" });
        return;
      }
      if (error instanceof InvalidTenantContextError || error instanceof RangeError) {
        res.status(400).json({ error: "INVALID_WORKFORCE_FORECAST_REQUEST" });
        return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;
