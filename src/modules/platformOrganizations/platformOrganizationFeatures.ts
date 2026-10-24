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
export const FEATURE_CODES = ["SMARTMATCH", "EN_CAMINO", "ACTIVITY_PHOTOS"] as const;
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
    return { code, enabled, changed };
  });
}

function handle(error: unknown, res: Response) {
  if (error instanceof UnauthorizedPlatformAccessError) { res.status(403).json({ error: "PLATFORM_ADMIN_REQUIRED" }); return; }
  if (error instanceof Error && error.message === "ORGANIZATION_NOT_FOUND") { res.status(404).json({ error: "ORGANIZATION_NOT_FOUND" }); return; }
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
export default router;
