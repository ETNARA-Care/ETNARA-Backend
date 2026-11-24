import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../../security/tenantAccessDenied.js";
import { ComplianceCredentialTypeNotFoundError, ComplianceManagementForbiddenError } from "../eligibility/eligibility.service.js";
import {
  PracticeError, getPracticeDocuments, practiceRequirementsSchema, registerPracticeDocument, registerPracticeDocumentSchema,
  savePracticeRequirements, updatePracticeDocument, updatePracticeDocumentSchema,
} from "./practiceDocuments.service.js";

/** 161 · «Mis documentos» del cuidador independiente: autodeclarados, sin verificación ni aprobación de ETNARA. */
const router = Router();
const uuid = z.string().uuid();

function fail(error: unknown, res: Response): void {
  if (error instanceof PracticeError) { res.status(error.status).json({ error: error.code }); return; }
  if (isTenantAccessDenied(error)) { res.status(403).json(TENANT_ACCESS_DENIED_BODY); return; }
  if (error instanceof ComplianceCredentialTypeNotFoundError) { res.status(400).json({ error: "CREDENTIAL_TYPE_NOT_FOUND" }); return; }
  if (error instanceof ComplianceManagementForbiddenError) { res.status(403).json({ error: "PRACTICE_INDEPENDENT_ONLY" }); return; }
  const message = error instanceof Error ? error.message : "";
  for (const code of ["CREDENTIAL_SELF_DECLARATION_FORBIDDEN", "INDEPENDENT_REQUIREMENT_NO_REVIEW", "CREDENTIAL_ORIGIN_IMMUTABLE"]) {
    if (message.includes(code)) { res.status(403).json({ error: code }); return; }
  }
  console.error("practice documents unexpected error", { name: error instanceof Error ? error.name : "UnknownError" });
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

router.get("/organizations/:organizationId/practice/documents", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const org = uuid.safeParse(req.params.organizationId);
  if (!org.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
  try { res.status(200).json(await getPracticeDocuments(req.auth!.userId, org.data)); } catch (e) { fail(e, res); }
});

router.post("/organizations/:organizationId/practice/documents", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const org = uuid.safeParse(req.params.organizationId);
  const body = registerPracticeDocumentSchema.safeParse(req.body ?? {});
  if (!org.success || !body.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try { res.status(201).json(await registerPracticeDocument(req.auth!.userId, org.data, body.data)); } catch (e) { fail(e, res); }
});

router.patch("/organizations/:organizationId/practice/documents/:credentialId", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const org = uuid.safeParse(req.params.organizationId);
  const body = updatePracticeDocumentSchema.safeParse(req.body ?? {});
  if (!org.success || !body.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try { res.status(200).json(await updatePracticeDocument(req.auth!.userId, org.data, String(req.params.credentialId), body.data)); } catch (e) { fail(e, res); }
});

router.put("/organizations/:organizationId/practice/requirements", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const org = uuid.safeParse(req.params.organizationId);
  const body = practiceRequirementsSchema.safeParse(req.body ?? {});
  if (!org.success || !body.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try { res.status(200).json({ policy: await savePracticeRequirements(req.auth!.userId, org.data, body.data) }); } catch (e) { fail(e, res); }
});

export default router;
