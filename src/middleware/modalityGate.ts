import type { NextFunction, Request, Response } from "express";
import { sql } from "kysely";
import { db } from "../config/db.js";
import { withTenantContext } from "../context/tenantContext.js";
import { validateSessionToken } from "../modules/auth/auth.service.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../security/tenantAccessDenied.js";
import { teamRouteFor } from "./modalityRules.js";

export { teamRouteFor };

/**
 * 160 · Cuidador independiente: las rutas de equipo (personal, supervisoras, revisión de credenciales,
 * SmartMatch, planificación, aprobación de horas, centro operacional, agentes, establecimientos) responden
 * 403 MODALITY_NOT_AVAILABLE en una organización INDEPENDENT_PROVIDER. En agencias y hogares la petición
 * sigue exactamente igual que antes. Igual que orgFeatureGate: quien no es miembro recibe el 403 de siempre
 * (no se revela el tipo de la organización) y sin token la ruta responde su propio 401.
 * Si la consulta del tipo falla, se cierra (503): la ruta tampoco podría responder sin base de datos.
 */
export async function modalityGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method === "OPTIONS") { next(); return; }
  const team = teamRouteFor(req.path, req.method);
  if (!team || !(req.headers.authorization ?? "").startsWith("Bearer ")) { next(); return; }
  let userId: string;
  try {
    ({ userId } = await validateSessionToken((req.headers.authorization ?? "").slice("Bearer ".length).trim()));
  } catch { next(); return; }
  try {
    await withTenantContext({ userId, organizationId: team.organizationId }, async () => true);
  } catch (error) {
    if (isTenantAccessDenied(error)) { res.status(403).json(TENANT_ACCESS_DENIED_BODY); return; }
    next(); return; // ids mal formados: la ruta responde su propio 400
  }
  try {
    const r = await sql<{ independent: boolean }>`SELECT app_org_is_independent(${team.organizationId}::uuid) AS independent`.execute(db);
    if (r.rows[0]?.independent === true) { res.status(403).json({ error: "MODALITY_NOT_AVAILABLE" }); return; }
    next();
  } catch {
    res.status(503).json({ error: "MODALITY_CHECK_UNAVAILABLE" });
  }
}
