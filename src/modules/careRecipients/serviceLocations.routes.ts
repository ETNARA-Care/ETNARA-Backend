import { Router, type Request, type Response } from "express";
import { z, type ZodTypeAny } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { MembershipNotActiveError, InvalidTenantContextError } from "../../context/errors.js";
import { OrganizationAccessDeniedError, InvalidOrganizationIdError } from "../organizationContext/organizationContext.service.js";
import { LocationWriteForbiddenError, RecipientNotFoundError } from "./careRecipients.service.js";
import {
  LocationConflictError, LocationNotFoundError,
  createLocationSchema, updateLocationSchema, reassignShiftsSchema, changeRequestSchema, resolveChangeRequestSchema,
  familyLocationPermissionSchema,
  listServiceLocations, createServiceLocation, updateServiceLocation, setPrimaryServiceLocation, verifyServiceLocation,
  archiveServiceLocation, reassignShiftLocations, listServiceLocationHistory, listShiftLocationOptions, getShiftServiceLocation,
  getFamilyServiceLocation, createLocationChangeRequest, listMyLocationChangeRequests, listLocationChangeRequests,
  resolveLocationChangeRequest, listFamilyLocationPermissions, setFamilyLocationPermission,
} from "./serviceLocations.service.js";

const router = Router();
const uuid = z.string().uuid();

/** Bounded diagnostics only: never the body, never an address. */
function fail(res: Response, error: unknown): void {
  if (error instanceof MembershipNotActiveError || error instanceof OrganizationAccessDeniedError) { res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" }); return; }
  if (error instanceof InvalidTenantContextError || error instanceof InvalidOrganizationIdError) { res.status(400).json({ error: "INVALID_ID" }); return; }
  if (error instanceof LocationWriteForbiddenError) { res.status(403).json({ error: "LOCATION_WRITE_FORBIDDEN" }); return; }
  if (error instanceof RecipientNotFoundError || error instanceof LocationNotFoundError) { res.status(404).json({ error: "NOT_FOUND" }); return; }
  if (error instanceof LocationConflictError) { res.status(409).json({ error: error.reason }); return; }
  const code = (error as { code?: string })?.code;
  if (code === "23505") { res.status(409).json({ error: "CONFLICT" }); return; }
  if (code === "23514" || code === "23503") { res.status(409).json({ error: "INVALID_STATE" }); return; }
  console.error("SERVICE_LOCATION_ERROR", { code });
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

function ids(req: Request, res: Response, ...keys: string[]): string[] | null {
  const out: string[] = [];
  for (const k of keys) {
    const p = uuid.safeParse(req.params[k]);
    if (!p.success) { res.status(400).json({ error: "INVALID_ID" }); return null; }
    out.push(p.data);
  }
  return out;
}
function body<S extends ZodTypeAny>(schema: S, req: Request, res: Response): z.infer<S> | null {
  const p = schema.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: "INVALID_PAYLOAD" }); return null; }
  return p.data;
}
type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const wrap = (fn: Handler) => async (req: AuthenticatedRequest, res: Response) => { try { await fn(req, res); } catch (e) { fail(res, e); } };

const R = "/organizations/:organizationId/care-recipients/:recipientId";

// ------------------------------------------------------------------ managers
router.get(`${R}/service-locations`, requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "organizationId", "recipientId"); if (!p) return;
  res.json(await listServiceLocations(req.auth!.userId, p[0], p[1]));
}));
router.post(`${R}/service-locations`, requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "organizationId", "recipientId"); if (!p) return;
  const b = body(createLocationSchema, req, res); if (!b) return;
  res.status(201).json(await createServiceLocation(req.auth!.userId, p[0], p[1], b));
}));
router.get(`${R}/service-locations/history`, requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "organizationId", "recipientId"); if (!p) return;
  res.json(await listServiceLocationHistory(req.auth!.userId, p[0], p[1]));
}));
router.post(`${R}/service-locations/reassign-shifts`, requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "organizationId", "recipientId"); if (!p) return;
  const b = body(reassignShiftsSchema, req, res); if (!b) return;
  res.json(await reassignShiftLocations(req.auth!.userId, p[0], p[1], b));
}));
router.patch(`${R}/service-locations/:locationId`, requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "organizationId", "recipientId", "locationId"); if (!p) return;
  const b = body(updateLocationSchema, req, res); if (!b) return;
  res.json(await updateServiceLocation(req.auth!.userId, p[0], p[1], p[2], b));
}));
router.post(`${R}/service-locations/:locationId/primary`, requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "organizationId", "recipientId", "locationId"); if (!p) return;
  res.json(await setPrimaryServiceLocation(req.auth!.userId, p[0], p[1], p[2]));
}));
router.post(`${R}/service-locations/:locationId/verify`, requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "organizationId", "recipientId", "locationId"); if (!p) return;
  res.json(await verifyServiceLocation(req.auth!.userId, p[0], p[1], p[2]));
}));
router.post(`${R}/service-locations/:locationId/archive`, requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "organizationId", "recipientId", "locationId"); if (!p) return;
  res.json(await archiveServiceLocation(req.auth!.userId, p[0], p[1], p[2]));
}));
router.get(`${R}/service-location-options`, requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "organizationId", "recipientId"); if (!p) return;
  res.json({ options: await listShiftLocationOptions(req.auth!.userId, p[0], p[1]) });
}));
router.get(`${R}/location-change-requests`, requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "organizationId", "recipientId"); if (!p) return;
  res.json({ requests: await listLocationChangeRequests(req.auth!.userId, p[0], p[1]) });
}));
router.post(`${R}/location-change-requests/:requestId/resolve`, requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "organizationId", "recipientId", "requestId"); if (!p) return;
  const b = body(resolveChangeRequestSchema, req, res); if (!b) return;
  res.json(await resolveLocationChangeRequest(req.auth!.userId, p[0], p[1], p[2], b));
}));
router.get(`${R}/family-location-permissions`, requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "organizationId", "recipientId"); if (!p) return;
  res.json({ relatives: await listFamilyLocationPermissions(req.auth!.userId, p[0], p[1]) });
}));
router.put(`${R}/family-location-permissions/:relationshipId`, requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "organizationId", "recipientId", "relationshipId"); if (!p) return;
  const b = body(familyLocationPermissionSchema, req, res); if (!b) return;
  res.json(await setFamilyLocationPermission(req.auth!.userId, p[0], p[1], p[2], b.canViewServiceLocation));
}));

// ------------------------------------------------------------------ shift (manager or assigned worker)
router.get("/organizations/:organizationId/shifts/:shiftId/service-location", requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "organizationId", "shiftId"); if (!p) return;
  res.json(await getShiftServiceLocation(req.auth!.userId, p[0], p[1]));
}));

// ------------------------------------------------------------------ family
router.get("/me/care-recipients/:recipientId/service-location", requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "recipientId"); if (!p) return;
  res.json(await getFamilyServiceLocation(req.auth!.userId, p[0]));
}));
router.get("/me/care-recipients/:recipientId/location-change-requests", requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "recipientId"); if (!p) return;
  res.json({ requests: await listMyLocationChangeRequests(req.auth!.userId, p[0]) });
}));
router.post("/me/care-recipients/:recipientId/location-change-requests", requireAuth, wrap(async (req, res) => {
  const p = ids(req, res, "recipientId"); if (!p) return;
  const b = body(changeRequestSchema, req, res); if (!b) return;
  res.status(201).json({ request: await createLocationChangeRequest(req.auth!.userId, p[0], b) });
}));

export default router;
