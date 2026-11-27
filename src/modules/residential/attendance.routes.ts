import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../../security/tenantAccessDenied.js";
import { ResidentialError, residentialDbErrorCode, residentialDbErrorStatus } from "./residentialErrors.js";
import {
  acknowledgeAlert, attendanceEstablishments, AttendanceError, decideCorrection, getAttendanceCodes, getAttendancePolicy, listAlerts,
  listCorrections, listPunches, manualPunch, myAttendance, myCorrections, printAttendanceCode, punch, punchHistory, requestCorrection,
  reviewPunches, revokeAttendanceCode, setGeoConsent, updateAttendancePolicy, weekAttendance,
} from "./attendance.service.js";
import {
  consentSchema, correctionSchema, decideCorrectionSchema, listPunchesSchema, manualPunchSchema, policySchema, printSchema, punchSchema,
  reviewSchema, revokeSchema, WEEK_START,
} from "./attendance.schemas.js";

/**
 * 173–175 · Hogares F4: /organizations/:id/residential/attendance/*. residentialGate (170) las cierra a agencias e
 * independientes; orgFeatureGate exige HOGAR_PONCHES (apagado por defecto). Las rutas /me son de quien poncha (para sí);
 * el resto, de la administración del hogar. Todas sin caché.
 */
const router = Router();
const uuid = z.string().uuid();
const BASE = "/organizations/:organizationId/residential/attendance";

function fail(error: unknown, res: Response, operation: string) {
  if (isTenantAccessDenied(error)) return void res.status(403).json(TENANT_ACCESS_DENIED_BODY);
  if (error instanceof AttendanceError) return void res.status(error.status).json({ error: error.code, ...(error.details ? { details: error.details } : {}) });
  if (error instanceof ResidentialError) return void res.status(error.status).json({ error: error.code });
  // Último recurso: el mismo client_event_id reenviado para OTRO turno (cliente defectuoso) choca con el índice único;
  // es un conflicto del cliente, no un fallo del servidor. Nunca se crea un segundo ponche.
  const pg = error as { code?: string; constraint?: string };
  if (pg?.code === "23505" && pg.constraint === "attendance_punches_client_event_uidx") return void res.status(409).json({ error: "ATTENDANCE_DUPLICATE_EVENT" });
  const code = residentialDbErrorCode(error);
  if (code) return void res.status(residentialDbErrorStatus(code)).json({ error: code });
  if (error instanceof MembershipNotActiveError) return void res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" });
  if (error instanceof InvalidTenantContextError) return void res.status(400).json({ error: "INVALID_ID" });
  const e = error as { name?: string; code?: string };
  // Sin datos de personas, códigos, ubicaciones ni SQL en el registro.
  console.error("attendance route failed", { operation, name: e?.name ?? "Error", code: e?.code ?? "UNKNOWN" });
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

type Handler = (userId: string, organizationId: string, params: Record<string, string>, body: unknown, query: Record<string, unknown>) => Promise<unknown>;
function route(method: "get" | "post" | "put", path: string, paramNames: string[], key: string, handler: Handler, status = 200) {
  router[method](`${BASE}${path}`, requireAuth, async (req: AuthenticatedRequest, res) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    const org = uuid.safeParse(req.params.organizationId);
    if (!org.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
    const params: Record<string, string> = {};
    for (const p of paramNames) {
      const raw = String(req.params[p] ?? "");
      const ok = p === "weekStart" ? WEEK_START.test(raw) : uuid.safeParse(raw).success;
      if (!ok) return void res.status(400).json({ error: "INVALID_ID" });
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

// Quien poncha (para sí).
route("get", "/me", [], "attendance", (u, o) => myAttendance(u, o));
router.post(`${BASE}/me/punch`, requireAuth, async (req: AuthenticatedRequest, res) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  const org = uuid.safeParse(req.params.organizationId);
  if (!org.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
  try {
    const result = await punch(req.auth!.userId, org.data, parse(punchSchema, req.body));
    if (result.blocked) return void res.status(429).json({ error: "ATTENDANCE_TOO_MANY_ATTEMPTS" });
    res.status(result.duplicate ? 200 : 201).json({ punch: result.punch, duplicate: result.duplicate });
  } catch (error) { fail(error, res, "post /me/punch"); }
});
route("put", "/me/consent", [], "consent", (u, o, _p, b) => setGeoConsent(u, o, parse(consentSchema, b)));
route("post", "/me/corrections", [], "correction", (u, o, _p, b) => requestCorrection(u, o, parse(correctionSchema, b)), 201);
route("get", "/me/corrections", [], "corrections", (u, o) => myCorrections(u, o));

// Administración del hogar.
route("get", "/establishments", [], "establishments", (u, o) => attendanceEstablishments(u, o));
route("get", "/establishments/:locationId/codes", ["locationId"], "codes", (u, o, p) => getAttendanceCodes(u, o, p.locationId));
route("post", "/establishments/:locationId/codes/print", ["locationId"], "print", (u, o, p, b) => printAttendanceCode(u, o, p.locationId, parse(printSchema, b)));
route("post", "/establishments/:locationId/codes/revoke", ["locationId"], "revocation", (u, o, p, b) => revokeAttendanceCode(u, o, p.locationId, parse(revokeSchema, b)));
route("get", "/establishments/:locationId/policy", ["locationId"], "policy", (u, o, p) => getAttendancePolicy(u, o, p.locationId));
route("put", "/establishments/:locationId/policy", ["locationId"], "policy", (u, o, p, b) => updateAttendancePolicy(u, o, p.locationId, parse(policySchema, b)));
route("get", "/establishments/:locationId/weeks/:weekStart", ["locationId", "weekStart"], "week", (u, o, p) => weekAttendance(u, o, p.locationId, p.weekStart));
route("get", "/punches", [], "result", (u, o, _p, _b, q) => listPunches(u, o, parse(listPunchesSchema, q)));
route("get", "/punches/:punchId", ["punchId"], "history", (u, o, p) => punchHistory(u, o, p.punchId));
route("post", "/punches/review", [], "review", (u, o, _p, b) => reviewPunches(u, o, parse(reviewSchema, b)));
route("post", "/punches/manual", [], "punch", (u, o, _p, b) => manualPunch(u, o, parse(manualPunchSchema, b)), 201);
route("get", "/corrections", [], "corrections", (u, o, _p, _b, q) => listCorrections(u, o, q.status === "all" ? "all" : "pending"));
route("post", "/corrections/:correctionId/decision", ["correctionId"], "correction", (u, o, p, b) => decideCorrection(u, o, p.correctionId, parse(decideCorrectionSchema, b)));
route("get", "/alerts", [], "alerts", (u, o, _p, _b, q) => listAlerts(u, o, q.state !== "all"));
route("post", "/alerts/:alertId/acknowledge", ["alertId"], "alert", (u, o, p) => acknowledgeAlert(u, o, p.alertId));

export default router;
