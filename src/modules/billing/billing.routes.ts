import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { MembershipNotActiveError, InvalidTenantContextError } from "../../context/errors.js";
import { respondInternalError } from "../../observability/internalError.js";
import * as drafts from "./drafts.service.js";
import * as issuing from "./issue.service.js";
import { BillingError, getAccess, grantPermission, grantSchema, listPermissions, revokePermission, revokeSchema } from "./billing.service.js";

/**
 * Facturación Premium routes (/organizations/:id/billing/*). Writes sit behind
 * FACTURACION (orgFeatureGate); reads pass the gate so the history stays
 * available in read-only mode and billing.view decides. A 500 never carries
 * internal detail.
 */
const router = Router();
const uuid = z.string().uuid();
const base = "/organizations/:organizationId/billing";
type Handler = (req: AuthenticatedRequest, organizationId: string) => Promise<unknown>;

export function handle(status: number, work: Handler) {
  return async (req: Request, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    if (!org.success) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
    try {
      res.status(status).json(await work(req as AuthenticatedRequest, org.data));
    } catch (error) {
      if (error instanceof BillingError) {
        const detail = (error as BillingError & { detail?: unknown }).detail;
        res.status(error.status).json(detail ? { error: error.code, detail } : { error: error.code });
        return;
      }
      if (error instanceof z.ZodError) { res.status(400).json({ error: "INVALID_PAYLOAD" }); return; }
      if (error instanceof MembershipNotActiveError) { res.status(403).json({ error: "BILLING_FORBIDDEN" }); return; }
      if (error instanceof InvalidTenantContextError) { res.status(400).json({ error: "INVALID_ID" }); return; }
      respondInternalError(res, "billing", error, req);
    }
  };
}
const user = (req: AuthenticatedRequest) => req.auth!.userId;
const id = (req: Request, name: string) => uuid.parse(req.params[name]);

router.get(`${base}/access`, requireAuth, handle(200, (req, org) => getAccess(user(req), org)));
router.get(`${base}/permissions`, requireAuth, handle(200, (req, org) => listPermissions(user(req), org)));
router.post(`${base}/permissions`, requireAuth, handle(201, async (req, org) => ({ permission: await grantPermission(user(req), org, grantSchema.parse(req.body)) })));
router.post(`${base}/permissions/:permissionId/revoke`, requireAuth, handle(200, async (req, org) => ({ permission: await revokePermission(user(req), org, id(req, "permissionId"), revokeSchema.parse(req.body)) })));

// F2.2 — tax treatment, drafts, lines and reservations (issuing arrives in F2.3).
const q = (req: Request) => req.query as Record<string, unknown>;
router.get(`${base}/tax`, requireAuth, handle(200, (req, org) => drafts.listTax(user(req), org)));
router.post(`${base}/tax`, requireAuth, handle(201, async (req, org) => ({ tax: await drafts.setTax(user(req), org, drafts.taxSetSchema.parse(req.body)) })));
router.get(`${base}/clients`, requireAuth, handle(200, (req, org) => drafts.billingClients(user(req), org)));
router.get(`${base}/eligible-shifts`, requireAuth, handle(200, (req, org) => drafts.eligibleShifts(user(req), org, drafts.eligibleQuerySchema.parse(q(req)))));
router.get(`${base}/invoices`, requireAuth, handle(200, (req, org) => drafts.listInvoices(user(req), org)));
router.post(`${base}/invoices`, requireAuth, handle(201, async (req, org) => ({ invoice: await drafts.createDraft(user(req), org, drafts.draftCreateSchema.parse(req.body)) })));
router.get(`${base}/invoices/:invoiceId`, requireAuth, handle(200, (req, org) => drafts.getInvoice(user(req), org, id(req, "invoiceId"))));
router.patch(`${base}/invoices/:invoiceId`, requireAuth, handle(200, async (req, org) => { await drafts.updateDraft(user(req), org, id(req, "invoiceId"), drafts.draftUpdateSchema.parse(req.body)); return { ok: true }; }));
router.post(`${base}/invoices/:invoiceId/shift-lines`, requireAuth, handle(201, (req, org) => drafts.addShiftLines(user(req), org, id(req, "invoiceId"), drafts.shiftLinesSchema.parse(req.body))));
router.post(`${base}/invoices/:invoiceId/manual-lines`, requireAuth, handle(201, (req, org) => drafts.addManualLine(user(req), org, id(req, "invoiceId"), drafts.manualLineSchema.parse(req.body))));
router.post(`${base}/invoices/:invoiceId/lines/:lineId/remove`, requireAuth, handle(200, (req, org) => drafts.removeLine(user(req), org, id(req, "invoiceId"), id(req, "lineId"), drafts.removeLineSchema.parse(req.body))));
router.post(`${base}/invoices/:invoiceId/recalculate`, requireAuth, handle(200, (req, org) => drafts.recalculate(user(req), org, id(req, "invoiceId"), drafts.versionOnlySchema.parse(req.body))));
router.post(`${base}/invoices/:invoiceId/discard`, requireAuth, handle(200, (req, org) => drafts.discardDraft(user(req), org, id(req, "invoiceId"), drafts.discardSchema.parse(req.body))));
router.post(`${base}/invoices/:invoiceId/recover`, requireAuth, handle(200, (req, org) => drafts.recoverDraft(user(req), org, id(req, "invoiceId"), drafts.discardSchema.parse(req.body))));

// F2.3 — invoice profile, issuing, void, private PDF downloads.
router.get(`${base}/settings`, requireAuth, handle(200, (req, org) => issuing.getSettings(user(req), org)));
router.put(`${base}/settings`, requireAuth, handle(200, async (req, org) => { await issuing.updateSettings(user(req), org, issuing.settingsSchema.parse(req.body)); return { ok: true }; }));
router.post(`${base}/settings/tax-validation`, requireAuth, handle(200, async (req, org) => { await issuing.setTaxValidation(user(req), org, issuing.taxValidationSchema.parse(req.body)); return { ok: true }; }));
router.post(`${base}/settings/logo`, requireAuth, express.raw({ type: ["image/png", "image/jpeg"], limit: issuing.LOGO_MAX_BYTES + 1024 }),
  handle(201, async (req, org) => ({ logo: await issuing.uploadLogo(user(req), org, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)) })));
router.post(`${base}/invoices/:invoiceId/issue`, requireAuth, handle(200, async (req, org) => ({ issued: await issuing.issueInvoice(user(req), org, id(req, "invoiceId"), issuing.issueSchema.parse(req.body)) })));
router.post(`${base}/invoices/:invoiceId/void`, requireAuth, handle(200, async (req, org) => ({ voided: await issuing.voidInvoice(user(req), org, id(req, "invoiceId"), issuing.voidSchema.parse(req.body)) })));

/** Binary responses: same error handling, private and never cached. */
function binary(work: (req: AuthenticatedRequest, org: string) => Promise<{ body: Buffer; headers: Record<string, string> }>) {
  return handleRaw(async (req, res, org) => {
    const out = await work(req, org);
    for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v); // built by the service (tenant context)
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(200).send(out.body);
  });
}
function handleRaw(work: (req: AuthenticatedRequest, res: Response, org: string) => Promise<void>) {
  return async (req: Request, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    if (!org.success) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
    try { await work(req as AuthenticatedRequest, res, org.data); } catch (error) {
      if (error instanceof BillingError) { res.status(error.status).json({ error: error.code }); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: "INVALID_PAYLOAD" }); return; }
      if (error instanceof MembershipNotActiveError) { res.status(403).json({ error: "BILLING_FORBIDDEN" }); return; }
      if (error instanceof InvalidTenantContextError) { res.status(400).json({ error: "INVALID_ID" }); return; }
      respondInternalError(res, "billing", error, req);
    }
  };
}
router.get(`${base}/settings/logo`, requireAuth, binary(async (req, org) => ({ body: await issuing.getLogo(user(req), org), headers: { "Content-Type": "image/png" } })));
router.get(`${base}/invoices/:invoiceId/pdf`, requireAuth, binary(async (req, org) => {
  const kind = z.enum(["original", "void_copy"]).parse((req.query as Record<string, unknown>).kind ?? "original");
  return issuing.downloadDocument(user(req), org, id(req, "invoiceId"), kind);
}));

export default router;
