import type { NextFunction, Request, Response } from "express";
import { sql } from "kysely";
import { db } from "../config/db.js";
import { withTenantContext } from "../context/tenantContext.js";
import { validateSessionToken } from "../modules/auth/auth.service.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../security/tenantAccessDenied.js";

/**
 * SmartMatch pilot: features that stay hidden for every agency until ETNARA
 * central enables them (migration 108). A MEMBER of a disabled agency gets 404
 * FEATURE_NOT_ENABLED, as if the route did not exist; a non-member always gets
 * 403 ORGANIZATION_ACCESS_DENIED, whatever the agency has enabled. Requests without a token
 * fall through so requireAuth still answers 401 and the pilot list is not
 * revealed to anonymous callers.
 */
import { gatedFeatureFor, type OrgFeature } from "./orgFeatureRules.js";

export { gatedFeatureFor, type OrgFeature };

export async function isOrgFeatureEnabled(organizationId: string, feature: OrgFeature): Promise<boolean> {
  const r = await sql<{ enabled: boolean }>`SELECT app_org_feature_enabled(${organizationId}::uuid, ${feature}) AS enabled`.execute(db);
  return r.rows[0]?.enabled === true;
}

export async function orgFeatureGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method === "OPTIONS") { next(); return; }
  const gated = gatedFeatureFor(req.path, req.method);
  if (!gated || !(req.headers.authorization ?? "").startsWith("Bearer ")) { next(); return; }
  // Non-members are refused BEFORE the feature is looked up (auditoría B4): otherwise
  // 404 FEATURE_NOT_ENABLED vs the route's own 403 told an outsider whether an agency
  // exists and which features it has on. Invalid sessions fall through to requireAuth (401).
  let userId: string;
  try {
    ({ userId } = await validateSessionToken((req.headers.authorization ?? "").slice("Bearer ".length).trim()));
  } catch { next(); return; }
  try {
    await withTenantContext({ userId, organizationId: gated.organizationId }, async () => true);
  } catch (error) {
    if (isTenantAccessDenied(error)) { res.status(403).json(TENANT_ACCESS_DENIED_BODY); return; }
    next(); return; // malformed ids: the route answers its own 400
  }
  // Read-only mode (Facturación): reads continue; billing.view decides in the service and the database.
  if (gated.readOnlyPass) { next(); return; }
  try {
    if (await isOrgFeatureEnabled(gated.organizationId, gated.feature)) { next(); return; }
    res.status(404).json({ error: "FEATURE_NOT_ENABLED" });
  } catch {
    res.status(503).json({ error: "FEATURE_CHECK_UNAVAILABLE" });
  }
}
