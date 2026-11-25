import type { NextFunction, Request, Response } from "express";
import { sql } from "kysely";
import { db } from "../config/db.js";
import { withTenantContext } from "../context/tenantContext.js";
import { validateSessionToken } from "../modules/auth/auth.service.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../security/tenantAccessDenied.js";
import { residentialRouteFor } from "./residentialRules.js";

export { residentialRouteFor };

/**
 * 170 · Hogares de envejecientes (RESIDENTIAL_CARE_HOME), F0. Mismo patrón que modalityGate (160):
 *   - /organizations/:id/residential/* en una organización que NO es hogar → 403 MODALITY_NOT_AVAILABLE;
 *   - Finanzas, Facturación, SmartMatch e Informe de Turno en un hogar → 403 MODALITY_NOT_AVAILABLE;
 *   - quien no es miembro recibe el 403 de siempre (no se revela el tipo); sin token, la ruta responde su 401;
 *   - cualquier otra ruta, y cualquier organización que no sea hogar en las rutas denegadas, sigue igual.
 * Si la consulta falla se cierra (503). Única excepción: en una base sin la 170 (función inexistente, 42883)
 * se mantiene el comportamiento anterior a la 170, para que un despliegue de código antes de la migración no
 * cierre Finanzas o Facturación a las agencias.
 */
export async function residentialGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method === "OPTIONS") { next(); return; }
  const route = residentialRouteFor(req.path);
  if (!route || !(req.headers.authorization ?? "").startsWith("Bearer ")) { next(); return; }
  let userId: string;
  try {
    ({ userId } = await validateSessionToken((req.headers.authorization ?? "").slice("Bearer ".length).trim()));
  } catch { next(); return; }
  try {
    await withTenantContext({ userId, organizationId: route.organizationId }, async () => true);
  } catch (error) {
    if (isTenantAccessDenied(error)) { res.status(403).json(TENANT_ACCESS_DENIED_BODY); return; }
    next(); return;
  }
  let residential: boolean;
  try {
    const r = await sql<{ residential: boolean }>`SELECT app_org_is_residential(${route.organizationId}::uuid) AS residential`.execute(db);
    residential = r.rows[0]?.residential === true;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "42883" && route.kind === "denied") { next(); return; }
    res.status(503).json({ error: "MODALITY_CHECK_UNAVAILABLE" }); return;
  }
  const blocked = route.kind === "residential" ? !residential : residential;
  if (blocked) { res.status(403).json({ error: "MODALITY_NOT_AVAILABLE" }); return; }
  next();
}
