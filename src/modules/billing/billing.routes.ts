import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { MembershipNotActiveError, InvalidTenantContextError } from "../../context/errors.js";
import { respondInternalError } from "../../observability/internalError.js";
import * as drafts from "./drafts.service.js";
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

export default router;
