import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../../security/tenantAccessDenied.js";
import { ResidentialError, residentialDbErrorCode, residentialDbErrorStatus } from "./residentialErrors.js";
import {
  applyScheduleTemplate, copyScheduleWeek, createScheduleEntry, createScheduleTemplate, getMyScheduleWeek, getScheduleWeek, listScheduleEstablishments,
  listSchedulePublications, listScheduleTemplates, publishScheduleWeek, removeScheduleEntry, ResidentialScheduleError,
  updateScheduleEntry, updateScheduleTemplate,
} from "./residentialSchedule.service.js";
import {
  applyTemplateSchema, copyWeekSchema, createEntrySchema, createTemplateSchema, updateEntrySchema, updateTemplateSchema, WEEK_START,
} from "./residentialSchedule.schemas.js";

/**
 * 172 · Hogares F2: /organizations/:id/residential/schedule/*. residentialGate (170) las cierra a agencias e
 * independientes; orgFeatureGate exige HOGAR_CALENDARIO (apagado por defecto); el servicio exige administración del hogar.
 */
const router = Router();
const uuid = z.string().uuid();
const BASE = "/organizations/:organizationId/residential/schedule";

function fail(error: unknown, res: Response, operation: string) {
  if (isTenantAccessDenied(error)) return void res.status(403).json(TENANT_ACCESS_DENIED_BODY);
  if (error instanceof ResidentialScheduleError) return void res.status(error.status).json({ error: error.code, ...(error.details ? { details: error.details } : {}) });
  if (error instanceof ResidentialError) return void res.status(error.status).json({ error: error.code });
  const code = residentialDbErrorCode(error);
  if (code) return void res.status(residentialDbErrorStatus(code)).json({ error: code });
  if (error instanceof MembershipNotActiveError) return void res.status(403).json({ error: "RESIDENTIAL_MANAGER_REQUIRED" });
  if (error instanceof InvalidTenantContextError) return void res.status(400).json({ error: "INVALID_ID" });
  console.error("Unexpected residential schedule failure", { operation, name: error instanceof Error ? error.name : "UnknownError" });
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

type Handler = (userId: string, organizationId: string, params: Record<string, string>, body: unknown) => Promise<unknown>;
function route(method: "get" | "post" | "patch" | "delete", path: string, paramNames: string[], key: string, handler: Handler, status = 200) {
  router[method](`${BASE}${path}`, requireAuth, async (req: AuthenticatedRequest, res) => {
    const org = uuid.safeParse(req.params.organizationId);
    if (!org.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
    const params: Record<string, string> = {};
    for (const p of paramNames) {
      const raw = String(req.params[p] ?? "");
      const ok = p === "weekStart" ? WEEK_START.test(raw) : uuid.safeParse(raw).success;
      if (!ok) return void res.status(400).json({ error: p === "weekStart" ? "RESIDENTIAL_SCHEDULE_WEEK_START_INVALID" : "INVALID_ID" });
      params[p] = raw;
    }
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
const WEEK = "/establishments/:locationId/weeks/:weekStart";

// 27-nov (decisión de Rafa): «Mi horario» del cuidador. Sus propios turnos de la semana; nunca borradores ni compañeros.
route("get", "/me/weeks/:weekStart", ["weekStart"], "schedule", (u, o, p) => getMyScheduleWeek(u, o, p.weekStart));
const W = ["locationId", "weekStart"];

route("get", "/establishments", [], "establishments", (u, o) => listScheduleEstablishments(u, o));
route("get", WEEK, W, "schedule", (u, o, p) => getScheduleWeek(u, o, p.locationId, p.weekStart));
route("post", `${WEEK}/entries`, W, "entry", (u, o, p, b) => createScheduleEntry(u, o, p.locationId, p.weekStart, parse(createEntrySchema, b)), 201);
route("patch", "/entries/:entryId", ["entryId"], "entry", (u, o, p, b) => updateScheduleEntry(u, o, p.entryId, parse(updateEntrySchema, b)));
route("delete", "/entries/:entryId", ["entryId"], "entry", (u, o, p) => removeScheduleEntry(u, o, p.entryId));
route("post", `${WEEK}/copy`, W, "copy", (u, o, p, b) => copyScheduleWeek(u, o, p.locationId, p.weekStart, parse(copyWeekSchema, b)));
route("post", `${WEEK}/apply-template`, W, "applied", (u, o, p, b) => applyScheduleTemplate(u, o, p.locationId, p.weekStart, parse(applyTemplateSchema, b)));
route("post", `${WEEK}/publish`, W, "publication", (u, o, p) => publishScheduleWeek(u, o, p.locationId, p.weekStart));
route("get", `${WEEK}/publications`, W, "publications", (u, o, p) => listSchedulePublications(u, o, p.locationId, p.weekStart));
route("get", "/establishments/:locationId/templates", ["locationId"], "templates", (u, o, p) => listScheduleTemplates(u, o, p.locationId));
route("post", "/establishments/:locationId/templates", ["locationId"], "template", (u, o, p, b) => createScheduleTemplate(u, o, p.locationId, parse(createTemplateSchema, b)), 201);
route("patch", "/templates/:templateId", ["templateId"], "template", (u, o, p, b) => updateScheduleTemplate(u, o, p.templateId, parse(updateTemplateSchema, b)));

export default router;
