// Módulo contractual, Etapa 1 (152). Con CONTRACTS_MODULE apagado todas las rutas responden 404.
import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { UnauthorizedPlatformAccessError } from "../../context/errors.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../../security/tenantAccessDenied.js";
import {
  ContractForbiddenError, ContractNotFoundError, ContractRuleError, contractsModuleEnabled,
  orgAcceptVersion, orgAcceptanceCertificate, orgDocumentFile, orgGetVersion, orgListAcceptances, orgListContracts, orgRequestSignatureCode,
  platformContractOverview, platformCreateDocument, platformCreateVersion, platformListAcceptances, platformListContracts,
  platformPublishVersion, platformRetireVersion, platformUpdateDraft,
} from "./contracts.service.js";
import {
  orgContractStatus, orgListSignatories, platformCreateSubscriptionOrder, platformDesignateSignatory, platformGetVersion,
  platformListSignatories, platformRecordLegalApproval, platformRevokeSignatory, platformSetEnforcement,
  FOUNDING_PROGRAM, platformRecordCommercialApproval, platformUpdateOrderTerms,
} from "./contractsSaas.service.js";

const router = Router();
const uuid = z.string().uuid();
const sha = z.string().regex(/^[0-9a-f]{64}$/);

router.use(["/platform/contracts", "/organizations/:organizationId/contracts"], (_req, res: Response, next: NextFunction) => {
  if (!contractsModuleEnabled()) { res.status(404).json({ error: "NOT_FOUND" }); return; }
  next();
});

function fail(x: unknown, res: Response) {
  if (x instanceof UnauthorizedPlatformAccessError) { res.status(403).json({ error: "PLATFORM_ACCESS_DENIED" }); return; }
  if (isTenantAccessDenied(x)) { res.status(403).json(TENANT_ACCESS_DENIED_BODY); return; }
  if (x instanceof ContractForbiddenError) { res.status(403).json({ error: "CONTRACT_FORBIDDEN" }); return; }
  if (x instanceof ContractNotFoundError) { res.status(404).json({ error: "CONTRACT_NOT_FOUND" }); return; }
  if (x instanceof ContractRuleError) {
    if (typeof x.extra.retryAfterSeconds === "number") res.setHeader("Retry-After", String(x.extra.retryAfterSeconds));
    res.status(x.status).json({ error: x.code, ...x.extra }); return;
  }
  res.status(500).json({ error: "INTERNAL_ERROR" });
}
const bad = (res: Response) => res.status(400).json({ error: "INVALID_PAYLOAD" });

// ---------------------------------------------------------------- ETNARA Central
const docBody = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,59}$/),
  title: z.string().trim().min(3).max(200),
  kind: z.enum(["SERVICE_AGREEMENT", "TERMS_OF_USE", "PRIVACY_NOTICE", "DATA_PROCESSING", "BUSINESS_ASSOCIATE", "OTHER"]),
  isTest: z.boolean(),
  requiredForOperation: z.boolean().optional(),
}).strict();
const versionBody = z.object({
  versionLabel: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.\-]{0,19}$/), body: z.string().min(50).max(200000), requiresNewAcceptance: z.boolean().optional(),
  sourceFileName: z.string().min(1).max(200).optional(), sourceFileSha256: sha.optional(),
}).strict();
const draftBody = z.object({ versionLabel: versionBody.shape.versionLabel.optional(), body: versionBody.shape.body.optional(), requiresNewAcceptance: z.boolean().optional() }).strict()
  .refine((v) => v.versionLabel !== undefined || v.body !== undefined || v.requiresNewAcceptance !== undefined);

router.get("/platform/contracts", requireAuth, async (req: AuthenticatedRequest, res) => {
  try { res.json({ documents: await platformListContracts(req.auth!.userId) }); } catch (x) { fail(x, res); }
});
router.post("/platform/contracts/documents", requireAuth, async (req: AuthenticatedRequest, res) => {
  const b = docBody.safeParse(req.body); if (!b.success) return void bad(res);
  try { res.status(201).json({ document: await platformCreateDocument(req.auth!.userId, b.data) }); } catch (x) { fail(x, res); }
});
router.post("/platform/contracts/documents/:documentId/versions", requireAuth, async (req: AuthenticatedRequest, res) => {
  const d = uuid.safeParse(req.params.documentId), b = versionBody.safeParse(req.body); if (!d.success || !b.success) return void bad(res);
  try { res.status(201).json({ version: await platformCreateVersion(req.auth!.userId, d.data, b.data) }); } catch (x) { fail(x, res); }
});
router.patch("/platform/contracts/versions/:versionId", requireAuth, async (req: AuthenticatedRequest, res) => {
  const v = uuid.safeParse(req.params.versionId), b = draftBody.safeParse(req.body); if (!v.success || !b.success) return void bad(res);
  try { res.json({ version: await platformUpdateDraft(req.auth!.userId, v.data, b.data) }); } catch (x) { fail(x, res); }
});
router.post("/platform/contracts/versions/:versionId/publish", requireAuth, async (req: AuthenticatedRequest, res) => {
  const v = uuid.safeParse(req.params.versionId); if (!v.success) return void bad(res);
  try { res.json({ version: await platformPublishVersion(req.auth!.userId, v.data) }); } catch (x) { fail(x, res); }
});
router.post("/platform/contracts/versions/:versionId/retire", requireAuth, async (req: AuthenticatedRequest, res) => {
  const v = uuid.safeParse(req.params.versionId); if (!v.success) return void bad(res);
  try { res.json({ version: await platformRetireVersion(req.auth!.userId, v.data) }); } catch (x) { fail(x, res); }
});
// ---- 153: vista previa, aprobación jurídica, representantes, Orden de Suscripción y reglas de acceso
router.get("/platform/contracts/versions/:versionId", requireAuth, async (req: AuthenticatedRequest, res) => {
  const v = uuid.safeParse(req.params.versionId); if (!v.success) return void bad(res);
  try { res.json({ version: await platformGetVersion(req.auth!.userId, v.data) }); } catch (x) { fail(x, res); }
});
const legalBody = z.object({ reference: z.string().trim().min(10).max(500), contentSha256: sha }).strict();
router.post("/platform/contracts/versions/:versionId/legal-approval", requireAuth, async (req: AuthenticatedRequest, res) => {
  const v = uuid.safeParse(req.params.versionId), b = legalBody.safeParse(req.body); if (!v.success || !b.success) return void bad(res);
  try { res.json({ version: await platformRecordLegalApproval(req.auth!.userId, v.data, b.data.reference, b.data.contentSha256) }); } catch (x) { fail(x, res); }
});
const signatoryBody = z.object({ userId: uuid, fullName: z.string().trim().min(5).max(150).regex(/\S+\s+\S+/), title: z.string().trim().min(2).max(100), basis: z.string().trim().min(10).max(500) }).strict();
router.get("/platform/contracts/organizations/:organizationId/signatories", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId); if (!o.success) return void bad(res);
  try { res.json({ signatories: await platformListSignatories(req.auth!.userId, o.data) }); } catch (x) { fail(x, res); }
});
router.post("/platform/contracts/organizations/:organizationId/signatories", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId), b = signatoryBody.safeParse(req.body); if (!o.success || !b.success) return void bad(res);
  try { res.status(201).json({ signatory: await platformDesignateSignatory(req.auth!.userId, o.data, b.data) }); } catch (x) { fail(x, res); }
});
router.post("/platform/contracts/organizations/:organizationId/signatories/:signatoryId/revoke", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId), s = uuid.safeParse(req.params.signatoryId), b = z.object({ reason: z.string().trim().min(5).max(500) }).strict().safeParse(req.body);
  if (!o.success || !s.success || !b.success) return void bad(res);
  try { res.json({ signatory: await platformRevokeSignatory(req.auth!.userId, o.data, s.data, b.data.reason) }); } catch (x) { fail(x, res); }
});
const money = z.number().nonnegative().max(100000).nullable().optional();
const line = z.string().trim().min(2).max(300);
/** Condiciones individuales de la Orden (todas propuestas). No hay precio predeterminado. */
const orderTerms = z.object({
  planName: z.string().trim().min(2).max(120), features: z.array(line).max(40), limits: z.string().trim().max(500).nullable().optional(),
  proposedMonthlyPriceUsd: money,
  promotions: z.array(z.object({ description: line, durationDays: z.number().int().min(1).max(366).nullable().optional() }).strict()).max(10).optional(),
  addOns: z.array(z.object({ name: line, proposedMonthlyPriceUsd: money }).strict()).max(20).optional(),
  conditions: z.array(z.string().trim().min(2).max(1000)).max(20).optional(),
  foundingProgram: z.boolean().optional(),
}).strict();
const orderBody = z.object({ isTest: z.boolean(), versionLabel: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.\-]{0,19}$/), requiredForOperation: z.boolean().optional(), terms: orderTerms }).strict();
router.get("/platform/contracts/founding-program", requireAuth, async (req: AuthenticatedRequest, res) => {
  // Solo Central (el contexto de plataforma lo verifica la consulta de la lista de contratos).
  try { await platformListContracts(req.auth!.userId); res.json({ program: FOUNDING_PROGRAM }); } catch (x) { fail(x, res); }
});
router.put("/platform/contracts/versions/:versionId/order-terms", requireAuth, async (req: AuthenticatedRequest, res) => {
  const v = uuid.safeParse(req.params.versionId), b = orderTerms.safeParse(req.body); if (!v.success || !b.success) return void bad(res);
  try { res.json({ version: await platformUpdateOrderTerms(req.auth!.userId, v.data, b.data) }); } catch (x) { fail(x, res); }
});
router.post("/platform/contracts/versions/:versionId/commercial-approval", requireAuth, async (req: AuthenticatedRequest, res) => {
  const v = uuid.safeParse(req.params.versionId), b = legalBody.safeParse(req.body); if (!v.success || !b.success) return void bad(res);
  try { res.json({ version: await platformRecordCommercialApproval(req.auth!.userId, v.data, b.data.reference, b.data.contentSha256) }); } catch (x) { fail(x, res); }
});
router.post("/platform/contracts/organizations/:organizationId/subscription-orders", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId), b = orderBody.safeParse(req.body); if (!o.success || !b.success) return void bad(res);
  try { res.status(201).json({ order: await platformCreateSubscriptionOrder(req.auth!.userId, o.data, b.data) }); } catch (x) { fail(x, res); }
});
const enforcementBody = z.object({ mode: z.enum(["off", "notice", "restrict_new_operations", "contract_only"]), enforceFrom: z.string().datetime().nullable(), reason: z.string().trim().min(5).max(500) }).strict();
router.put("/platform/contracts/organizations/:organizationId/enforcement", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId), b = enforcementBody.safeParse(req.body); if (!o.success || !b.success) return void bad(res);
  try { res.json({ enforcement: await platformSetEnforcement(req.auth!.userId, o.data, b.data) }); } catch (x) { fail(x, res); }
});
router.get("/organizations/:organizationId/contracts/status", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId); if (!o.success) return void bad(res);
  try { res.json({ status: await orgContractStatus(req.auth!.userId, o.data) }); } catch (x) { fail(x, res); }
});
router.get("/organizations/:organizationId/contracts/signatories", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId); if (!o.success) return void bad(res);
  try { res.json({ signatories: await orgListSignatories(req.auth!.userId, o.data) }); } catch (x) { fail(x, res); }
});

router.get("/platform/contracts/overview", requireAuth, async (req: AuthenticatedRequest, res) => {
  try { res.json(await platformContractOverview(req.auth!.userId)); } catch (x) { fail(x, res); }
});
router.get("/platform/contracts/versions/:versionId/acceptances", requireAuth, async (req: AuthenticatedRequest, res) => {
  const v = uuid.safeParse(req.params.versionId); if (!v.success) return void bad(res);
  try { res.json({ acceptances: await platformListAcceptances(req.auth!.userId, v.data) }); } catch (x) { fail(x, res); }
});

// ---------------------------------------------------------------- Agencia (ORGANIZATION_ADMIN)
router.get("/organizations/:organizationId/contracts", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId); if (!o.success) return void bad(res);
  try { res.json({ contracts: await orgListContracts(req.auth!.userId, o.data) }); } catch (x) { fail(x, res); }
});
router.get("/organizations/:organizationId/contracts/acceptances", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId); if (!o.success) return void bad(res);
  try { res.json({ acceptances: await orgListAcceptances(req.auth!.userId, o.data) }); } catch (x) { fail(x, res); }
});
router.get("/organizations/:organizationId/contracts/versions/:versionId", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId), v = uuid.safeParse(req.params.versionId); if (!o.success || !v.success) return void bad(res);
  try { res.json({ version: await orgGetVersion(req.auth!.userId, o.data, v.data) }); } catch (x) { fail(x, res); }
});
// Representante autorizada: nombre completo (al menos nombre y apellido), cargo y confirmación
// expresa de la declaración de autoridad que muestra el documento. Las casillas llegan desmarcadas
// y la firma exige las dos en true, más el código enviado al correo de la cuenta.
const signerFields = {
  contentSha256: sha,
  confirm: z.literal(true),
  confirmAuthority: z.literal(true),
  signerFullName: z.string().trim().min(5).max(150).regex(/\S+\s+\S+/),
  signerTitle: z.string().trim().min(2).max(100),
};
const codeRequestBody = z.object(signerFields).strict();
const acceptBody = z.object({ ...signerFields, challengeId: uuid, code: z.string().regex(/^[0-9]{6}$/) }).strict();
router.post("/organizations/:organizationId/contracts/versions/:versionId/signature-code", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId), v = uuid.safeParse(req.params.versionId), b = codeRequestBody.safeParse(req.body);
  if (!o.success || !v.success || !b.success) return void bad(res);
  try { res.status(201).json(await orgRequestSignatureCode(req.auth!.userId, o.data, v.data, b.data.contentSha256)); } catch (x) { fail(x, res); }
});
router.post("/organizations/:organizationId/contracts/versions/:versionId/accept", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId), v = uuid.safeParse(req.params.versionId), b = acceptBody.safeParse(req.body);
  if (!o.success || !v.success || !b.success) return void bad(res);
  try {
    const acceptance = await orgAcceptVersion(req.auth!.userId, o.data, v.data, b.data.contentSha256,
      { fullName: b.data.signerFullName, title: b.data.signerTitle }, { challengeId: b.data.challengeId, code: b.data.code },
      { ip: req.ip ?? null, userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null });
    res.status(201).json({ acceptance });
  } catch (x) { fail(x, res); }
});
/** Archivos binarios: el servicio construye las cabeceras dentro del contexto de la agencia. */
function sendFile(res: Response, f: { body: Buffer; headers: Record<string, string> }) {
  for (const [k, v] of Object.entries(f.headers)) res.setHeader(k, v);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(f.body);
}
for (const format of ["pdf", "txt"] as const) {
  router.get(`/organizations/:organizationId/contracts/versions/:versionId/document.${format}`, requireAuth, async (req: AuthenticatedRequest, res) => {
    const o = uuid.safeParse(req.params.organizationId), v = uuid.safeParse(req.params.versionId); if (!o.success || !v.success) return void bad(res);
    try { sendFile(res, await orgDocumentFile(req.auth!.userId, o.data, v.data, format)); } catch (x) { fail(x, res); }
  });
}
router.get("/organizations/:organizationId/contracts/acceptances/:acceptanceId/certificate.pdf", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId), a = uuid.safeParse(req.params.acceptanceId); if (!o.success || !a.success) return void bad(res);
  try { sendFile(res, await orgAcceptanceCertificate(req.auth!.userId, o.data, a.data)); } catch (x) { fail(x, res); }
});

export default router;
