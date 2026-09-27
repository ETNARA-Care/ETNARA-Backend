import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { MembershipNotActiveError, InvalidTenantContextError } from "../../context/errors.js";
import {
  createEstablishment,
  createEstablishmentSchema,
  EstablishmentManagementForbiddenError,
  EstablishmentNotFoundError,
  listEstablishments,
  updateEstablishment,
  updateEstablishmentSchema,
} from "./establishments.service.js";

const router = Router();
const uuid = z.string().uuid();

function handleError(error: unknown, res: Response) {
  if (error instanceof EstablishmentManagementForbiddenError || error instanceof MembershipNotActiveError) {
    res.status(403).json({ error: error.message });
  } else if (error instanceof EstablishmentNotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof InvalidTenantContextError) {
    res.status(400).json({ error: "INVALID_ID" });
  } else {
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
}

router.get("/organizations/:organizationId/establishments", requireAuth, async (req: AuthenticatedRequest, res) => {
  const organization = uuid.safeParse(req.params.organizationId);
  if (!organization.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
  try {
    res.json({ establishments: await listEstablishments(req.auth!.userId, organization.data) });
  } catch (error) {
    handleError(error, res);
  }
});

router.post("/organizations/:organizationId/establishments", requireAuth, async (req: AuthenticatedRequest, res) => {
  const organization = uuid.safeParse(req.params.organizationId);
  const input = createEstablishmentSchema.safeParse(req.body);
  if (!organization.success || !input.success) return void res.status(400).json({ error: "INVALID_ESTABLISHMENT" });
  try {
    res.status(201).json({ establishment: await createEstablishment(req.auth!.userId, organization.data, input.data) });
  } catch (error) {
    handleError(error, res);
  }
});

router.patch("/organizations/:organizationId/establishments/:establishmentId", requireAuth, async (req: AuthenticatedRequest, res) => {
  const organization = uuid.safeParse(req.params.organizationId);
  const establishment = uuid.safeParse(req.params.establishmentId);
  const input = updateEstablishmentSchema.safeParse(req.body);
  if (!organization.success || !establishment.success || !input.success) {
    return void res.status(400).json({ error: "INVALID_ESTABLISHMENT" });
  }
  try {
    res.json({ establishment: await updateEstablishment(req.auth!.userId, organization.data, establishment.data, input.data) });
  } catch (error) {
    handleError(error, res);
  }
});

export default router;
