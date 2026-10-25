import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { MembershipNotActiveError, InvalidTenantContextError } from "../../context/errors.js";
import { respondInternalError } from "../../observability/internalError.js";
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
      if (error instanceof BillingError) { res.status(error.status).json({ error: error.code }); return; }
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

export default router;
