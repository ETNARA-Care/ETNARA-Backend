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

type DatabaseLikeError = Error & { code?: unknown };

function logUnexpectedEstablishmentError(operation: string, error: unknown) {
  const candidate = error instanceof Error ? (error as DatabaseLikeError) : undefined;
  console.error("Unexpected establishment operation failure", {
    operation,
    name: candidate?.name ?? "UnknownError",
    message: candidate?.message ?? "Unknown error",
    code: typeof candidate?.code === "string" ? candidate.code : undefined,
  });
}

function handleError(error: unknown, res: Response, operation: string) {
  if (error instanceof EstablishmentManagementForbiddenError || error instanceof MembershipNotActiveError) {
    res.status(403).json({ error: error.message });
  } else if (error instanceof EstablishmentNotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof InvalidTenantContextError) {
    res.status(400).json({ error: "INVALID_ID" });
  } else {
    logUnexpectedEstablishmentError(operation, error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
}

router.get("/organizations/:organizationId/establishments", requireAuth, async (req: AuthenticatedRequest, res) => {
  const organization = uuid.safeParse(req.params.organizationId);
  if (!organization.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
  try {
    res.json({ establishments: await listEstablishments(req.auth!.userId, organization.data) });
  } catch (error) {
    handleError(error, res, "list_establishments");
  }
});

router.post("/organizations/:organizationId/establishments", requireAuth, async (req: AuthenticatedRequest, res) => {
  const organization = uuid.safeParse(req.params.organizationId);
  const input = createEstablishmentSchema.safeParse(req.body);
  if (!organization.success || !input.success) return void res.status(400).json({ error: "INVALID_ESTABLISHMENT" });
  try {
    res.status(201).json({ establishment: await createEstablishment(req.auth!.userId, organization.data, input.data) });
  } catch (error) {
    handleError(error, res, "create_establishment");
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
    handleError(error, res, "update_establishment");
  }
});

export default router;
