import type { NextFunction, Request, Response } from "express";
import { sql } from "kysely";
import { db } from "../config/db.js";

/**
 * SmartMatch pilot: features that stay hidden for every agency until ETNARA
 * central enables them (migration 108). A disabled agency gets 404
 * FEATURE_NOT_ENABLED, as if the route did not exist. Requests without a token
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
  // Read-only mode (Facturación): reads continue; billing.view decides in the service and the database.
  if (gated.readOnlyPass) { next(); return; }
  try {
    if (await isOrgFeatureEnabled(gated.organizationId, gated.feature)) { next(); return; }
    res.status(404).json({ error: "FEATURE_NOT_ENABLED" });
  } catch {
    res.status(503).json({ error: "FEATURE_CHECK_UNAVAILABLE" });
  }
}
