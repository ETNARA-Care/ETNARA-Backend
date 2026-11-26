import { Router, type Response } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../../security/tenantAccessDenied.js";
import { ResidentialError, RESIDENTIAL_MANAGER_REQUIRED, residentialDbErrorCode, residentialDbErrorStatus } from "./residentialErrors.js";
import { attendanceReportIn } from "./attendance.service.js";
import { assignmentsReportIn } from "./residentAssignments.service.js";
import { reportRange } from "./reportRange.js";

/**
 * 177 (hogares F5): informes administrativos del hogar. Cada informe se ejecuta en el contexto de su organización
 * (withTenantContext, RLS) y solo para la administración (app_is_org_manager). Las rutas viven bajo los prefijos de su
 * módulo, así que orgFeatureGate exige HOGAR_PONCHES (asistencia) o HOGAR_ASIGNACIONES (asignaciones), y
 * residentialGate las cierra a agencias e independientes. Rango libre de 1 a 31 días locales. Sin caché.
 */
const router = Router();
const uuid = z.string().uuid();

function fail(error: unknown, res: Response, operation: string) {
  if (isTenantAccessDenied(error)) return void res.status(403).json(TENANT_ACCESS_DENIED_BODY);
  if (error instanceof ResidentialError) return void res.status(error.status).json({ error: error.code });
  const code = residentialDbErrorCode(error);
  if (code) return void res.status(residentialDbErrorStatus(code)).json({ error: code });
  if (error instanceof MembershipNotActiveError) return void res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" });
  if (error instanceof InvalidTenantContextError) return void res.status(400).json({ error: "INVALID_ID" });
  const e = error as { name?: string; code?: string };
  console.error("residential report failed", { operation, name: e?.name ?? "Error", code: e?.code ?? "UNKNOWN" });
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

type Run = (trx: Parameters<Parameters<typeof withTenantContext>[1]>[0], organizationId: string, locationId: string, range: ReturnType<typeof reportRange>) => Promise<unknown>;
function report(path: string, run: Run) {
  router.get(path, requireAuth, async (req: AuthenticatedRequest, res) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    const org = uuid.safeParse(req.params.organizationId), loc = uuid.safeParse(req.params.locationId);
    if (!org.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
    if (!loc.success) return void res.status(400).json({ error: "INVALID_ID" });
    try {
      const range = reportRange(req.query.from, req.query.to);
      const data = await withTenantContext({ userId: req.auth!.userId, organizationId: org.data }, async (trx) => {
        const manager = await sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`.execute(trx);
        if (!manager.rows[0]?.ok) throw new ResidentialError(RESIDENTIAL_MANAGER_REQUIRED, 403);
        return run(trx, org.data, loc.data, range);
      });
      res.json({ report: data });
    } catch (error) { fail(error, res, `get ${path}`); }
  });
}

report("/organizations/:organizationId/residential/attendance/establishments/:locationId/report", (trx, o, l, r) => attendanceReportIn(trx, o, l, r));
report("/organizations/:organizationId/residential/assignments/establishments/:locationId/report", (trx, o, l, r) => assignmentsReportIn(trx, o, l, r));

export default router;
