import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../../security/tenantAccessDenied.js";
import { occupancyFor } from "./residentialEstablishments.service.js";
import { attendancePanelSection } from "./attendance.service.js";
import { assignmentsPanelSection } from "./residentAssignments.service.js";

/**
 * 170 · Panel base del hogar (F0). Solo lectura, solo administración del hogar (ORGANIZATION_ADMIN o
 * SUPERVISOR, app_is_org_manager). residentialGate ya cerró la ruta a agencias e independientes.
 * Devuelve recuentos administrativos (nunca nombres ni datos clínicos), el estado de los interruptores de hogar
 * (todos apagados por defecto) y el aviso del plan de $200 por encima de 10 residentes activos (D8; solo aviso).
 */
export const RESIDENTIAL_PLAN_RESIDENT_LIMIT = 10;
const HOGAR_FEATURES = ["HOGAR_CALENDARIO", "HOGAR_ASIGNACIONES", "HOGAR_PONCHES", "DEMO_ENVIRONMENT"] as const;

export class ResidentialManagerRequiredError extends Error { constructor() { super("RESIDENTIAL_MANAGER_REQUIRED"); } }

export async function getResidentialOverview(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const manager = await sql<{ allowed: boolean }>`SELECT app_is_org_manager() AS allowed`.execute(trx);
    if (!manager.rows[0]?.allowed) throw new ResidentialManagerRequiredError();
    const counts = await sql<{ establishments: number; residents: number }>`
      SELECT (SELECT count(*)::int FROM locations WHERE organization_id = ${organizationId} AND archived_at IS NULL) AS establishments,
             (SELECT count(*)::int FROM care_recipients WHERE organization_id = ${organizationId} AND status = 'active') AS residents`.execute(trx);
    const features = await sql<{ feature_code: string; enabled: boolean }>`
      SELECT feature_code, enabled FROM organization_features
      WHERE organization_id = ${organizationId} AND feature_code IN ('HOGAR_CALENDARIO', 'HOGAR_ASIGNACIONES', 'HOGAR_PONCHES', 'DEMO_ENVIRONMENT')`.execute(trx);
    const enabled = new Map(features.rows.map((f) => [f.feature_code, f.enabled === true]));
    const residents = counts.rows[0]?.residents ?? 0;
    // 177 (F5): panel completo. Ocupación siempre; asistencia solo con HOGAR_PONCHES y asignaciones solo con
    // HOGAR_ASIGNACIONES (null si están apagados). Solo administración; sin datos clínicos ni ubicaciones.
    const locs = (await sql<{ id: string; name: string }>`SELECT l.id, l.name FROM locations l WHERE l.organization_id = ${organizationId} AND l.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM establishment_technical_rooms t WHERE t.location_id = l.id) ORDER BY l.name, l.id`.execute(trx)).rows;
    const occ = await occupancyFor(trx, organizationId, locs.map((l) => l.id));
    const sum = (k: "rooms" | "bedsRegistered" | "bedsOccupied" | "bedsAvailable" | "activeResidents" | "residentsWithoutRoom") => [...occ.values()].reduce((n, o) => n + o[k], 0);
    const beds = sum("bedsRegistered");
    const occupancy = {
      rooms: sum("rooms"), bedsRegistered: beds, bedsOccupied: sum("bedsOccupied"), bedsAvailable: sum("bedsAvailable"),
      activeResidents: sum("activeResidents"), residentsWithoutRoom: sum("residentsWithoutRoom"),
      occupancyPercent: beds > 0 ? Math.round((sum("bedsOccupied") / beds) * 100) : null,
      capacityConfigured: [...occ.values()].some((o) => o.capacityConfigured), overCapacity: [...occ.values()].some((o) => o.overCapacity),
      establishments: locs.map((l) => ({ id: l.id, name: l.name, ...(occ.get(l.id) ?? null) })),
    };
    const panel = {
      occupancy,
      attendance: enabled.get("HOGAR_PONCHES") ? await attendancePanelSection(trx, organizationId) : null,
      assignments: enabled.get("HOGAR_ASIGNACIONES") ? await assignmentsPanelSection(trx, organizationId) : null,
    };
    return {
      panel,
      establishments: counts.rows[0]?.establishments ?? 0,
      activeResidents: residents,
      planResidentLimit: RESIDENTIAL_PLAN_RESIDENT_LIMIT,
      overPlanLimit: residents > RESIDENTIAL_PLAN_RESIDENT_LIMIT,
      features: HOGAR_FEATURES.map((code) => ({ code, enabled: enabled.get(code) ?? false })),
    };
  });
}

const router = Router();
const uuid = z.string().uuid();
router.get("/organizations/:organizationId/residential/overview", requireAuth, async (req: AuthenticatedRequest, res) => {
  const org = uuid.safeParse(req.params.organizationId);
  if (!org.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  try { res.json({ overview: await getResidentialOverview(req.auth!.userId, org.data) }); }
  catch (error) {
    if (isTenantAccessDenied(error)) return void res.status(403).json(TENANT_ACCESS_DENIED_BODY);
    if (error instanceof ResidentialManagerRequiredError || error instanceof MembershipNotActiveError) return void res.status(403).json({ error: "RESIDENTIAL_MANAGER_REQUIRED" });
    if (error instanceof InvalidTenantContextError) return void res.status(400).json({ error: "INVALID_ID" });
    console.error("Unexpected residential overview failure", error instanceof Error ? { name: error.name } : {});
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
export default router;
