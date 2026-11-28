import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../../security/tenantAccessDenied.js";
import { ResidentialError, residentialDbErrorCode, residentialDbErrorStatus } from "./residentialErrors.js";
import {
  closeResidentialEstablishment, createResidentialRoom, createResidentialUnit, getResidentialEstablishment, listResidentialEstablishments,
  placeResidentialResident, residentialClosureCheck, residentialGeofenceHistory, residentialResidentHistory, updateResidentialGeofence,
  updateResidentialRoom, updateResidentialUnit,
} from "./residentialEstablishments.service.js";
import { closeSchema, createRoomSchema, createUnitSchema, geofenceSchema, placementSchema, updateRoomSchema, updateUnitSchema } from "./residentialEstablishments.schemas.js";

/**
 * 171 · Hogares F1: rutas /organizations/:id/residential/*. residentialGate (170) ya las cerró a agencias e
 * independientes; el servicio exige administración del hogar. Ninguna respuesta incluye las piezas técnicas.
 */
const router = Router();
const uuid = z.string().uuid();
const BASE = "/organizations/:organizationId/residential";

function fail(error: unknown, res: Response, operation: string) {
  if (isTenantAccessDenied(error)) return void res.status(403).json(TENANT_ACCESS_DENIED_BODY);
  if (error instanceof ResidentialError) return void res.status(error.status).json({ error: error.code });
  const code = residentialDbErrorCode(error);
  if (code) return void res.status(residentialDbErrorStatus(code)).json({ error: code });
  if (error instanceof MembershipNotActiveError) return void res.status(403).json({ error: "RESIDENTIAL_MANAGER_REQUIRED" });
  if (error instanceof InvalidTenantContextError) return void res.status(400).json({ error: "INVALID_ID" });
  console.error("Unexpected residential operation failure", { operation, name: error instanceof Error ? error.name : "UnknownError" });
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

type Handler = (userId: string, organizationId: string, params: Record<string, string>, body: unknown) => Promise<unknown>;
function route(method: "get" | "post" | "patch" | "put", path: string, paramNames: string[], key: string, handler: Handler, status = 200) {
  router[method](`${BASE}${path}`, requireAuth, async (req: AuthenticatedRequest, res) => {
    const org = uuid.safeParse(req.params.organizationId);
    const params: Record<string, string> = {};
    for (const p of paramNames) {
      const v = uuid.safeParse(req.params[p]);
      if (!v.success) return void res.status(400).json({ error: "INVALID_ID" });
      params[p] = v.data;
    }
    if (!org.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    try { res.status(status).json({ [key]: await handler(req.auth!.userId, org.data, params, req.body) }); }
    catch (error) { fail(error, res, `${method} ${path}`); }
  });
}
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new ResidentialError("INVALID_INPUT", 400);
  return r.data;
}

route("get", "/establishments", [], "establishments", (u, o) => listResidentialEstablishments(u, o));
route("get", "/establishments/:establishmentId", ["establishmentId"], "establishment", (u, o, p) => getResidentialEstablishment(u, o, p.establishmentId));
route("post", "/establishments/:establishmentId/units", ["establishmentId"], "unit", (u, o, p, b) => createResidentialUnit(u, o, p.establishmentId, parse(createUnitSchema, b)), 201);
route("patch", "/units/:unitId", ["unitId"], "unit", (u, o, p, b) => updateResidentialUnit(u, o, p.unitId, parse(updateUnitSchema, b)));
route("post", "/establishments/:establishmentId/rooms", ["establishmentId"], "room", (u, o, p, b) => createResidentialRoom(u, o, p.establishmentId, parse(createRoomSchema, b)), 201);
route("patch", "/rooms/:roomId", ["roomId"], "room", (u, o, p, b) => updateResidentialRoom(u, o, p.roomId, parse(updateRoomSchema, b)));
route("put", "/residents/:recipientId/placement", ["recipientId"], "placement", (u, o, p, b) => placeResidentialResident(u, o, p.recipientId, parse(placementSchema, b)));
route("get", "/residents/:recipientId/placement-history", ["recipientId"], "history", (u, o, p) => residentialResidentHistory(u, o, p.recipientId));
route("put", "/establishments/:establishmentId/geofence", ["establishmentId"], "geofence", (u, o, p, b) => updateResidentialGeofence(u, o, p.establishmentId, parse(geofenceSchema, b)));
route("get", "/establishments/:establishmentId/geofence-history", ["establishmentId"], "history", (u, o, p) => residentialGeofenceHistory(u, o, p.establishmentId));
route("get", "/establishments/:establishmentId/closure-check", ["establishmentId"], "closure", (u, o, p) => residentialClosureCheck(u, o, p.establishmentId));
route("post", "/establishments/:establishmentId/close", ["establishmentId"], "closure", (u, o, p, b) => closeResidentialEstablishment(u, o, p.establishmentId, parse(closeSchema, b)));

export default router;
