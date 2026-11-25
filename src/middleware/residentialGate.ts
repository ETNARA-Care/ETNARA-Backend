import type { NextFunction, Request, Response } from "express";
import { sql } from "kysely";
import { InvalidTenantContextError } from "../context/errors.js";
import { withTenantContext } from "../context/tenantContext.js";
import { SessionInvalidError, validateSessionToken } from "../modules/auth/auth.service.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../security/tenantAccessDenied.js";
import { residentialRouteFor } from "./residentialRules.js";

export { residentialRouteFor };

/**
 * 170 · Hogares de envejecientes (RESIDENTIAL_CARE_HOME), F0:
 *   - /organizations/:id/residential/* en una organización que NO es hogar → 403 MODALITY_NOT_AVAILABLE;
 *   - Finanzas, Facturación, SmartMatch e Informe de Turno en un hogar → 403 MODALITY_NOT_AVAILABLE;
 *   - cualquier otra ruta, y cualquier organización que no sea hogar en las rutas denegadas, sigue igual.
 *
 * Revisión independiente 25-nov (A2), siempre cerrada ante lo inesperado:
 *   - sin token, o sesión inválida, revocada o caducada (SessionInvalidError) → continúa: la ruta responde su 401;
 *   - quien no es miembro, o la organización no está activa → 403 ORGANIZATION_ACCESS_DENIED (no revela el tipo);
 *   - identificador inválido (no debería ocurrir: la regla ya exige un UUID) → 400 INVALID_ORGANIZATION_ID;
 *   - cualquier otro error al validar la sesión, al comprobar la pertenencia o al consultar la modalidad
 *     (base caída, permisos, función inexistente…) → 503 MODALITY_CHECK_UNAVAILABLE. Nunca se continúa.
 * Ya no hay excepción para 42883: Railway aplica la 170 en preDeploy antes de arrancar este código y, si falla,
 * el despliegue se aborta y sigue el código anterior; además la 170 solo se revierte después de volver a desplegar
 * el código anterior (ops/170…rollback.sql). Sin la función, la guarda se cierra en vez de abrir el hogar.
 * La consulta de modalidad corre DENTRO del contexto de la organización (misma transacción, pertenencia ya
 * comprobada): app_org_is_residential no responde fuera de ese contexto (A3).
 */
export async function residentialGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method === "OPTIONS") { next(); return; }
  const route = residentialRouteFor(req.path);
  if (!route || !(req.headers.authorization ?? "").startsWith("Bearer ")) { next(); return; }
  let userId: string;
  try {
    ({ userId } = await validateSessionToken((req.headers.authorization ?? "").slice("Bearer ".length).trim()));
  } catch (error) {
    if (error instanceof SessionInvalidError) { next(); return; }
    unavailable(res, "session", error); return;
  }
  let residential: boolean;
  try {
    residential = await withTenantContext({ userId, organizationId: route.organizationId }, async (trx) => {
      const r = await sql<{ residential: boolean }>`SELECT public.app_org_is_residential(${route.organizationId}::uuid) AS residential`.execute(trx);
      return r.rows[0]?.residential === true;
    });
  } catch (error) {
    if (isTenantAccessDenied(error)) { res.status(403).json(TENANT_ACCESS_DENIED_BODY); return; }
    if (error instanceof InvalidTenantContextError) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
    unavailable(res, "modality", error); return;
  }
  const blocked = route.kind === "residential" ? !residential : residential;
  if (blocked) { res.status(403).json({ error: "MODALITY_NOT_AVAILABLE" }); return; }
  next();
}

function unavailable(res: Response, stage: "session" | "modality", error: unknown): void {
  // Solo la etapa y el código de PostgreSQL: nunca el mensaje, ids ni datos de la petición.
  const code = (error as { code?: unknown } | null)?.code;
  console.error("RESIDENTIAL_GATE_UNAVAILABLE", { stage, code: typeof code === "string" ? code : "UNKNOWN" });
  res.status(503).json({ error: "MODALITY_CHECK_UNAVAILABLE" });
}
