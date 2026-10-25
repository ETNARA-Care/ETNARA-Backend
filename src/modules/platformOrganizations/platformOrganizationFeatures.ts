import { Router, type Response } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { UnauthorizedPlatformAccessError } from "../../context/errors.js";
import { withPlatformContext } from "../../context/tenantContext.js";

/**
 * SmartMatch pilot switches (migration 108). Only ETNARA central (platform
 * admin) reads or changes them; every change needs a reason and is recorded in
 * organization_feature_events (append-only).
 */
export const FEATURE_CODES = ["SMARTMATCH", "EN_CAMINO", "ACTIVITY_PHOTOS", "FINANZAS", "FACTURACION"] as const;
const uuid = z.string().uuid();
const featureCode = z.enum(FEATURE_CODES);
const setFeatureSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(3).max(300),
});

export async function listOrganizationFeatures(userId: string, organizationId: string) {
  return withPlatformContext(userId, async (trx) => {
    const org = await sql<{ id: string }>`SELECT id FROM organizations WHERE id = ${organizationId}`.execute(trx);
    if (!org.rows[0]) throw new Error("ORGANIZATION_NOT_FOUND");
    const rows = await sql<{ feature_code: string; enabled: boolean; updated_at: string | null }>`
      SELECT c.code AS feature_code, COALESCE(f.enabled, false) AS enabled, f.updated_at
      FROM unnest(${sql.raw(`ARRAY['${FEATURE_CODES.join("','")}']`)}::text[]) AS c(code)
      LEFT JOIN organization_features f ON f.organization_id = ${organizationId} AND f.feature_code = c.code
      ORDER BY c.code`.execute(trx);
    const history = await sql<{ feature_code: string; enabled: boolean; reason: string; occurred_at: string; actor_email: string | null }>`
      SELECT e.feature_code, e.enabled, e.reason, e.occurred_at, u.email AS actor_email
      FROM organization_feature_events e LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.organization_id = ${organizationId}
      ORDER BY e.occurred_at DESC LIMIT 50`.execute(trx);
    return {
      features: rows.rows.map((r) => ({ code: r.feature_code, enabled: r.enabled, updatedAt: r.updated_at })),
      history: history.rows.map((h) => ({ code: h.feature_code, enabled: h.enabled, reason: h.reason, occurredAt: h.occurred_at, actorEmail: h.actor_email })),
    };
  });
}

export async function setOrganizationFeature(userId: string, organizationId: string, code: (typeof FEATURE_CODES)[number], enabled: boolean, reason: string) {
  return withPlatformContext(userId, async (trx) => {
    const org = await sql<{ id: string }>`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`.execute(trx);
    if (!org.rows[0]) throw new Error("ORGANIZATION_NOT_FOUND");
    const before = await sql<{ enabled: boolean }>`
      SELECT enabled FROM organization_features WHERE organization_id = ${organizationId} AND feature_code = ${code}`.execute(trx);
    const changed = (before.rows[0]?.enabled ?? false) !== enabled;
    await sql`
      INSERT INTO organization_features (organization_id, feature_code, enabled, updated_by_user_id, updated_at)
      VALUES (${organizationId}, ${code}, ${enabled}, ${userId}, now())
      ON CONFLICT (organization_id, feature_code)
      DO UPDATE SET enabled = EXCLUDED.enabled, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`.execute(trx);
    if (changed) {
      await sql`
        INSERT INTO organization_feature_events (organization_id, feature_code, enabled, reason, actor_user_id)
        VALUES (${organizationId}, ${code}, ${enabled}, ${reason}, ${userId})`.execute(trx);
    }
    // F2.1: an agency with a single administrator receives the initial billing
    // permissions when FACTURACION is turned on (several: ETNARA designates the manager).
    let initialBillingPermissions = 0;
    if (code === "FACTURACION" && enabled) {
      initialBillingPermissions = (await sql<{ n: number }>`SELECT app_billing_bootstrap_permissions(${organizationId}::uuid) AS n`.execute(trx)).rows[0]?.n ?? 0;
    }
    return { code, enabled, changed, initialBillingPermissions };
  });
}

/**
 * F2.1 — ETNARA central and billing: it only sees the agency's administrators
 * (email, whether they manage billing permissions) and can designate the
 * billing permission manager. Never invoices, rates or amounts (SECURITY
 * DEFINER functions of migration 123 return nothing else).
 */
export async function listBillingAdmins(userId: string, organizationId: string) {
  return withPlatformContext(userId, async (trx) => {
    const org = await sql<{ id: string }>`SELECT id FROM organizations WHERE id = ${organizationId}`.execute(trx);
    if (!org.rows[0]) throw new Error("ORGANIZATION_NOT_FOUND");
    const enabled = (await sql<{ e: boolean }>`SELECT app_org_billing_enabled(${organizationId}::uuid) AS e`.execute(trx)).rows[0]?.e === true;
    const admins = await sql<{ membership_id: string; email: string; is_manager: boolean; capabilities: string[] }>`
      SELECT membership_id, email, is_manager, capabilities FROM app_platform_billing_admins(${organizationId}::uuid)`.execute(trx);
    return { billingEnabled: enabled, admins: admins.rows.map((a) => ({ membershipId: a.membership_id, email: a.email, isManager: a.is_manager })) };
  });
}

export async function designateBillingManager(userId: string, organizationId: string, membershipId: string, reason: string) {
  return withPlatformContext(userId, async (trx) => {
    const org = await sql<{ id: string }>`SELECT id FROM organizations WHERE id = ${organizationId}`.execute(trx);
    if (!org.rows[0]) throw new Error("ORGANIZATION_NOT_FOUND");
    const added = (await sql<{ n: number }>`SELECT app_platform_designate_billing_manager(${organizationId}::uuid, ${membershipId}::uuid, ${reason}) AS n`.execute(trx)).rows[0]?.n ?? 0;
    return { membershipId, granted: added };
  });
}

const KNOWN_DB_CODES: Record<string, number> = {
  FEATURE_REQUIRES_FINANZAS: 409, FEATURE_NOT_ENABLED: 409, BILLING_PERMISSION_ADMIN_ONLY: 409, REASON_REQUIRED: 400,
};

function handle(error: unknown, res: Response) {
  if (error instanceof UnauthorizedPlatformAccessError) { res.status(403).json({ error: "PLATFORM_ADMIN_REQUIRED" }); return; }
  if (error instanceof Error && error.message === "ORGANIZATION_NOT_FOUND") { res.status(404).json({ error: "ORGANIZATION_NOT_FOUND" }); return; }
  const known = error instanceof Error ? Object.keys(KNOWN_DB_CODES).find((k) => error.message.includes(k)) : undefined;
  if (known) { res.status(KNOWN_DB_CODES[known]).json({ error: known }); return; }
  console.error("Unexpected organization feature failure", error instanceof Error ? { name: error.name } : {});
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

const router = Router();
router.get("/platform/organizations/:organizationId/features", requireAuth, async (req: AuthenticatedRequest, res) => {
  const org = uuid.safeParse(req.params.organizationId);
  if (!org.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
  try { res.json(await listOrganizationFeatures(req.auth!.userId, org.data)); } catch (e) { handle(e, res); }
});
router.put("/platform/organizations/:organizationId/features/:featureCode", requireAuth, async (req: AuthenticatedRequest, res) => {
  const org = uuid.safeParse(req.params.organizationId);
  const code = featureCode.safeParse(req.params.featureCode);
  const body = setFeatureSchema.safeParse(req.body);
  if (!org.success || !code.success || !body.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try { res.json({ feature: await setOrganizationFeature(req.auth!.userId, org.data, code.data, body.data.enabled, body.data.reason) }); } catch (e) { handle(e, res); }
});
const designateSchema = z.object({ membershipId: uuid, reason: z.string().trim().min(3).max(300) });
router.get("/platform/organizations/:organizationId/billing-admins", requireAuth, async (req: AuthenticatedRequest, res) => {
  const org = uuid.safeParse(req.params.organizationId);
  if (!org.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
  try { res.json(await listBillingAdmins(req.auth!.userId, org.data)); } catch (e) { handle(e, res); }
});
router.post("/platform/organizations/:organizationId/billing-manager", requireAuth, async (req: AuthenticatedRequest, res) => {
  const org = uuid.safeParse(req.params.organizationId);
  const body = designateSchema.safeParse(req.body);
  if (!org.success || !body.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try { res.json({ designation: await designateBillingManager(req.auth!.userId, org.data, body.data.membershipId, body.data.reason) }); } catch (e) { handle(e, res); }
});
export default router;
