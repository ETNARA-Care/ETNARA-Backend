import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../../security/tenantAccessDenied.js";
import { ResidentialError, residentialDbErrorCode, residentialDbErrorStatus } from "./residentialErrors.js";
import {
  AssignmentError, assignmentEstablishments, assignResidents, coverageAlerts, dayBoards, myResidents, previewSubstitution, redistribute,
  resolveCoverageAlert, shiftBoard, shiftHistory, substitute,
} from "./residentAssignments.service.js";
import { assignResidentsSchema, LOCAL_DATE, redistributeSchema, substitutionPreviewSchema, substitutionSchema } from "./residentAssignments.schemas.js";

/**
 * 176 · Hogares F3:
 *   /organizations/:id/residential/assignments/*   → HOGAR_ASIGNACIONES (orgFeatureGate; apagado por defecto).
 *   /organizations/:id/residential/substitutions/* → exige HOGAR_CALENDARIO y HOGAR_ASIGNACIONES; el servicio responde 403
 *     si falta cualquiera (plan §6 F3), por eso no tiene regla propia en orgFeatureRules.
 * residentialGate (170) cierra ambas a agencias e independientes. Sin caché.
 */
const router = Router();
const uuid = z.string().uuid();
const A = "/organizations/:organizationId/residential/assignments";
const S = "/organizations/:organizationId/residential/substitutions";

function fail(error: unknown, res: Response, operation: string) {
  if (isTenantAccessDenied(error)) return void res.status(403).json(TENANT_ACCESS_DENIED_BODY);
  if (error instanceof AssignmentError) return void res.status(error.status).json({ error: error.code, ...(error.details ? { details: error.details } : {}) });
  if (error instanceof ResidentialError) return void res.status(error.status).json({ error: error.code });
  const code = residentialDbErrorCode(error);
  if (code) return void res.status(residentialDbErrorStatus(code)).json({ error: code });
  if (error instanceof MembershipNotActiveError) return void res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" });
  if (error instanceof InvalidTenantContextError) return void res.status(400).json({ error: "INVALID_ID" });
  const e = error as { name?: string; code?: string };
  console.error("resident assignments route failed", { operation, name: e?.name ?? "Error", code: e?.code ?? "UNKNOWN" });
  res.status(500).json({ error: "INTERNAL_ERROR" });
}
type Handler = (userId: string, organizationId: string, params: Record<string, string>, body: unknown, query: Record<string, unknown>) => Promise<unknown>;
function route(method: "get" | "post", path: string, paramNames: string[], key: string, handler: Handler, status = 200) {
  router[method](path, requireAuth, async (req: AuthenticatedRequest, res) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    const org = uuid.safeParse(req.params.organizationId);
    if (!org.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
    const params: Record<string, string> = {};
    for (const p of paramNames) {
      const raw = String(req.params[p] ?? "");
      if (!uuid.safeParse(raw).success) return void res.status(400).json({ error: "INVALID_ID" });
      params[p] = raw;
    }
    try { res.status(status).json({ [key]: await handler(req.auth!.userId, org.data, params, req.body, req.query as Record<string, unknown>) }); }
    catch (error) { fail(error, res, `${method} ${path}`); }
  });
}
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new ResidentialError("INVALID_INPUT", 400);
  return r.data;
}
const date = (q: Record<string, unknown>) => {
  const d = typeof q.date === "string" ? q.date : "";
  if (!LOCAL_DATE.test(d)) throw new ResidentialError("INVALID_INPUT", 400);
  return d;
};

route("get", `${A}/me`, [], "residents", (u, o) => myResidents(u, o));
route("get", `${A}/establishments`, [], "establishments", (u, o) => assignmentEstablishments(u, o));
route("get", `${A}/establishments/:locationId/day`, ["locationId"], "boards", (u, o, p, _b, q) => dayBoards(u, o, p.locationId, date(q)));
route("get", `${A}/shifts/:shiftId`, ["shiftId"], "board", (u, o, p) => shiftBoard(u, o, p.shiftId));
route("post", `${A}/shifts/:shiftId/residents`, ["shiftId"], "assignment", (u, o, p, b) => assignResidents(u, o, p.shiftId, parse(assignResidentsSchema, b)), 201);
route("post", `${A}/shifts/:shiftId/redistribute`, ["shiftId"], "redistribution", (u, o, p, b) => redistribute(u, o, p.shiftId, parse(redistributeSchema, b)));
route("get", `${A}/shifts/:shiftId/history`, ["shiftId"], "history", (u, o, p) => shiftHistory(u, o, p.shiftId));
route("get", `${A}/coverage-alerts`, [], "alerts", (u, o, _p, _b, q) => coverageAlerts(u, o, q.state !== "all"));
route("post", `${A}/coverage-alerts/:alertId/resolve`, ["alertId"], "alert", (u, o, p) => resolveCoverageAlert(u, o, p.alertId));
route("post", `${S}/shifts/:shiftId/preview`, ["shiftId"], "preview", (u, o, p, b) => previewSubstitution(u, o, p.shiftId, parse(substitutionPreviewSchema, b)));
route("post", `${S}/shifts/:shiftId`, ["shiftId"], "substitution", (u, o, p, b) => substitute(u, o, p.shiftId, parse(substitutionSchema, b)), 201);

export default router;
