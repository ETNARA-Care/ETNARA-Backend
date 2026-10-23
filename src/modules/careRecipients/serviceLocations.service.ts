import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext, withUserContext } from "../../context/tenantContext.js";
import { isPuertoRicoMunicipality } from "../smartmatch/smartmatch.privacy.js";
import { LocationWriteForbiddenError, RecipientNotFoundError } from "./careRecipients.service.js";

/**
 * Gate 6: official service location of the person receiving care (migration 100,
 * on top of care_recipient_locations from 084). PostgreSQL RLS decides who reads
 * each address; these functions add explicit answers and the audited actions.
 * Never log or return addresses outside these responses.
 */

type Trx = Parameters<Parameters<typeof withTenantContext>[1]>[0];

export class LocationNotFoundError extends Error { constructor() { super("LOCATION_NOT_FOUND"); } }
export class LocationConflictError extends Error { constructor(public readonly reason: string) { super("LOCATION_CONFLICT"); } }

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().max(max).transform((v) => (v.length ? v : null)).nullable().optional();
const postalCode = z.string().trim().regex(/^\d{5}(-\d{4})?$/).nullable().optional();
const municipality = z.string().trim().refine(isPuertoRicoMunicipality, "MUNICIPALITY").nullable().optional();

const locationFields = {
  label: z.string().trim().min(1).max(40).optional(),
  addressLine: text(200),
  municipality,
  postalCode,
  accessNotes: text(500),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  establishmentId: uuid.nullable().optional(),
};
const pair = (d: { latitude?: number | null; longitude?: number | null }) => (d.latitude == null) === (d.longitude == null);
const noCopy = (d: { establishmentId?: string | null; addressLine?: string | null; municipality?: string | null; postalCode?: string | null }) =>
  !d.establishmentId || (!d.addressLine && !d.municipality && !d.postalCode);

export const createLocationSchema = z.object({ ...locationFields, makePrimary: z.boolean().optional() }).strict()
  .refine(pair, { message: "COORDINATES_PAIR" })
  .refine(noCopy, { message: "ESTABLISHMENT_NO_COPY" })
  .refine((d) => Boolean(d.establishmentId || d.addressLine || d.latitude != null), { message: "EMPTY_LOCATION" });
export const updateLocationSchema = z.object(locationFields).strict()
  .refine(pair, { message: "COORDINATES_PAIR" })
  .refine(noCopy, { message: "ESTABLISHMENT_NO_COPY" });
export const reassignShiftsSchema = z.object({ shiftIds: z.array(uuid).min(1).max(200), toLocationId: uuid }).strict();
export const changeRequestSchema = z.object({
  addressLine: text(200), municipality, postalCode, accessNotes: text(500), message: text(500),
}).strict().refine((d) => Boolean(d.addressLine || d.municipality || d.postalCode || d.accessNotes || d.message), { message: "EMPTY_REQUEST" });
export const resolveChangeRequestSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: text(300),
  apply: z.object({ addressLine: text(200), municipality, postalCode, accessNotes: text(500) }).strict().optional(),
  /** Required when upcoming shifts use the address and the approval changes where the service is. */
  confirmUpcomingShifts: z.literal(true).optional(),
}).strict();
/** Gate 6 fix: explicit confirmation of the exact map point (never implied by a search). */
export const confirmGpsSchema = z.object({
  latitude: z.number().min(17.5).max(18.7),
  longitude: z.number().min(-68.0).max(-65.1),
  confirm: z.literal(true),
}).strict();
export const familyLocationPermissionSchema = z.object({ canViewServiceLocation: z.boolean() }).strict();

export type CreateLocationInput = z.infer<typeof createLocationSchema>;
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

interface LocationRow {
  id: string; care_recipient_id: string; label: string; is_primary: boolean;
  address_line: string | null; municipality: string | null; postal_code: string | null; access_notes: string | null;
  latitude: string | number | null; longitude: string | number | null; establishment_id: string | null;
  verified_at: string | null; gps_confirmed_at: string | null; archived_at: string | null; updated_at: string; created_at: string;
}
const columns = sql`id, care_recipient_id, label, is_primary, address_line, municipality, postal_code, access_notes,
  latitude, longitude, establishment_id, verified_at, gps_confirmed_at, archived_at, updated_at, created_at`;

async function view(trx: Trx, row: LocationRow) {
  let establishment: { id: string; name: string; address: string | null } | null = null;
  if (row.establishment_id) {
    const e = await sql<{ name: string; address: string | null }>`SELECT * FROM app_establishment_address(${row.establishment_id}::uuid)`.execute(trx);
    if (e.rows[0]) establishment = { id: row.establishment_id, name: e.rows[0].name, address: e.rows[0].address };
  }
  return {
    id: row.id, label: row.label, isPrimary: row.is_primary,
    addressLine: row.address_line, municipality: row.municipality, postalCode: row.postal_code,
    accessNotes: row.access_notes,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    establishment, verifiedAt: row.verified_at, gpsConfirmedAt: row.gps_confirmed_at, archivedAt: row.archived_at,
    updatedAt: row.updated_at, createdAt: row.created_at,
  };
}

async function requireManager(trx: Trx) {
  const r = await sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`.execute(trx);
  if (!r.rows[0]?.ok) throw new LocationWriteForbiddenError();
}
async function requireRecipient(trx: Trx, organizationId: string, recipientId: string) {
  const r = await sql<{ id: string }>`SELECT id FROM care_recipients WHERE id = ${recipientId} AND organization_id = ${organizationId}`.execute(trx);
  if (!r.rows[0]) throw new RecipientNotFoundError();
}
async function lockedLocation(trx: Trx, organizationId: string, recipientId: string, locationId: string) {
  const r = await sql<LocationRow>`
    SELECT ${columns} FROM care_recipient_locations
    WHERE id = ${locationId} AND organization_id = ${organizationId} AND care_recipient_id = ${recipientId}
    FOR UPDATE`.execute(trx);
  if (!r.rows[0]) throw new LocationNotFoundError();
  return r.rows[0];
}

/** Upcoming shifts (not started, not cancelled) and the address each one uses. */
async function upcomingShifts(trx: Trx, organizationId: string, recipientId: string) {
  return (await sql<{ id: string; scheduled_start: string; scheduled_end: string; status: string; effective_location_id: string | null }>`
    SELECT s.id, s.scheduled_start, s.scheduled_end, s.status::text AS status,
           COALESCE(s.service_location_id, (SELECT l.id FROM care_recipient_locations l
             WHERE l.care_recipient_id = s.care_recipient_id AND l.organization_id = s.organization_id
               AND l.is_primary AND l.archived_at IS NULL)) AS effective_location_id
    FROM shifts s
    WHERE s.organization_id = ${organizationId} AND s.care_recipient_id = ${recipientId}
      AND s.status IN ('unassigned', 'confirmed') AND s.scheduled_end > now()
    ORDER BY s.scheduled_start`.execute(trx)).rows;
}

// ------------------------------------------------------------------ managers

export async function listServiceLocations(userId: string, organizationId: string, recipientId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    await requireRecipient(trx, organizationId, recipientId);
    const rows = (await sql<LocationRow>`
      SELECT ${columns} FROM care_recipient_locations
      WHERE care_recipient_id = ${recipientId} AND organization_id = ${organizationId}
      ORDER BY archived_at NULLS FIRST, is_primary DESC, created_at`.execute(trx)).rows;
    const shifts = await upcomingShifts(trx, organizationId, recipientId);
    const establishment = (await sql<{ location_id: string | null }>`
      SELECT location_id FROM care_recipients WHERE id = ${recipientId} AND organization_id = ${organizationId}`.execute(trx)).rows[0]?.location_id ?? null;
    const establishmentInfo = establishment
      ? (await sql<{ name: string; address: string | null }>`SELECT * FROM app_establishment_address(${establishment}::uuid)`.execute(trx)).rows[0] ?? null
      : null;
    const out = [];
    for (const row of rows) {
      out.push({ ...(await view(trx, row)), upcomingShiftCount: shifts.filter((s) => s.effective_location_id === row.id).length });
    }
    return {
      locations: out,
      upcomingShifts: shifts.map((s) => ({ id: s.id, scheduledStart: s.scheduled_start, scheduledEnd: s.scheduled_end, status: s.status, locationId: s.effective_location_id })),
      // Residential homes: the person's establishment, offered for reuse (not copied).
      establishment: establishment && establishmentInfo ? { id: establishment, ...establishmentInfo } : null,
    };
  });
}

export async function createServiceLocation(userId: string, organizationId: string, recipientId: string, input: CreateLocationInput) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    await requireRecipient(trx, organizationId, recipientId);
    // Serialize primary changes for this person.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${"crl:" + recipientId}, 0))`.execute(trx);
    const hasPrimary = (await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM care_recipient_locations
      WHERE care_recipient_id = ${recipientId} AND organization_id = ${organizationId} AND is_primary AND archived_at IS NULL`.execute(trx)).rows[0].n > 0;
    const primary = !hasPrimary || input.makePrimary === true;
    if (primary && hasPrimary) {
      await sql`UPDATE care_recipient_locations SET is_primary = false, updated_at = now(), updated_by_user_id = ${userId}
        WHERE care_recipient_id = ${recipientId} AND organization_id = ${organizationId} AND is_primary AND archived_at IS NULL`.execute(trx);
    }
    const row = (await sql<LocationRow>`
      INSERT INTO care_recipient_locations (care_recipient_id, organization_id, label, address_line, municipality, postal_code,
        access_notes, latitude, longitude, establishment_id, is_primary, updated_at, updated_by_user_id)
      VALUES (${recipientId}, ${organizationId}, ${input.label ?? (primary ? "Principal" : "Alterna")}, ${input.addressLine ?? null},
        ${input.municipality ?? null}, ${input.postalCode ?? null}, ${input.accessNotes ?? null}, ${input.latitude ?? null},
        ${input.longitude ?? null}, ${input.establishmentId ?? null}, ${primary}, now(), ${userId})
      RETURNING ${columns}`.execute(trx)).rows[0];
    const shifts = await upcomingShifts(trx, organizationId, recipientId);
    return {
      location: await view(trx, row),
      // A new primary does NOT move existing shifts: they keep their confirmed address
      // until the agency updates them explicitly (reassignShiftLocations).
      shiftsOnOtherAddresses: primary ? shifts.filter((s) => s.effective_location_id !== row.id).map((s) => s.id) : [],
    };
  });
}

export async function updateServiceLocation(userId: string, organizationId: string, recipientId: string, locationId: string, input: UpdateLocationInput) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    const current = await lockedLocation(trx, organizationId, recipientId, locationId);
    if (current.archived_at) throw new LocationConflictError("LOCATION_ARCHIVED");
    const pick = <K extends keyof UpdateLocationInput>(k: K, fallback: unknown) => (input[k] === undefined ? fallback : input[k]);
    const establishmentId = pick("establishmentId", current.establishment_id) as string | null;
    const next = {
      label: (input.label ?? current.label) as string,
      address_line: establishmentId ? null : pick("addressLine", current.address_line),
      municipality: establishmentId ? null : pick("municipality", current.municipality),
      postal_code: establishmentId ? null : pick("postalCode", current.postal_code),
      access_notes: pick("accessNotes", current.access_notes),
      latitude: pick("latitude", current.latitude),
      longitude: pick("longitude", current.longitude),
    };
    if ((next.latitude == null) !== (next.longitude == null)) throw new LocationConflictError("COORDINATES_PAIR");
    const row = (await sql<LocationRow>`
      UPDATE care_recipient_locations SET label = ${next.label}, address_line = ${next.address_line as string | null},
        municipality = ${next.municipality as string | null}, postal_code = ${next.postal_code as string | null},
        access_notes = ${next.access_notes as string | null}, latitude = ${next.latitude as number | null},
        longitude = ${next.longitude as number | null}, establishment_id = ${establishmentId},
        updated_at = now(), updated_by_user_id = ${userId}
      WHERE id = ${locationId} AND organization_id = ${organizationId}
      RETURNING ${columns}`.execute(trx)).rows[0];
    const shifts = await upcomingShifts(trx, organizationId, recipientId);
    const using = shifts.filter((s) => s.effective_location_id === locationId).map((s) => s.id);
    const placeChanged = (["address_line", "municipality", "postal_code", "establishment_id", "latitude", "longitude"] as const)
      .some((k) => String(row[k] ?? "") !== String(current[k] ?? ""));
    // The assigned caregivers learn that their shift's address changed (never the address itself).
    if (placeChanged && using.length > 0) await sql`SELECT app_notify_shift_location_changed(${using}::uuid[])`.execute(trx);
    return { location: await view(trx, row), upcomingShiftsUsingIt: using.length };
  });
}

export async function setPrimaryServiceLocation(userId: string, organizationId: string, recipientId: string, locationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${"crl:" + recipientId}, 0))`.execute(trx);
    const current = await lockedLocation(trx, organizationId, recipientId, locationId);
    if (current.archived_at) throw new LocationConflictError("LOCATION_ARCHIVED");
    if (!current.is_primary) {
      await sql`UPDATE care_recipient_locations SET is_primary = false, updated_at = now(), updated_by_user_id = ${userId}
        WHERE care_recipient_id = ${recipientId} AND organization_id = ${organizationId} AND is_primary AND archived_at IS NULL`.execute(trx);
      await sql`UPDATE care_recipient_locations SET is_primary = true, updated_at = now(), updated_by_user_id = ${userId}
        WHERE id = ${locationId} AND organization_id = ${organizationId}`.execute(trx);
    }
    const shifts = await upcomingShifts(trx, organizationId, recipientId);
    return { shiftsOnOtherAddresses: shifts.filter((s) => s.effective_location_id !== locationId).map((s) => s.id) };
  });
}

export async function verifyServiceLocation(userId: string, organizationId: string, recipientId: string, locationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    const current = await lockedLocation(trx, organizationId, recipientId, locationId);
    if (current.archived_at) throw new LocationConflictError("LOCATION_ARCHIVED");
    const row = (await sql<LocationRow>`
      UPDATE care_recipient_locations SET verified_at = now(), verified_by_user_id = ${userId}
      WHERE id = ${locationId} AND organization_id = ${organizationId} RETURNING ${columns}`.execute(trx)).rows[0];
    return { location: await view(trx, row) };
  });
}

/**
 * Managers confirm the exact point of the service (lat/lng within Puerto Rico).
 * Records who and when (history trigger: GPS_CONFIRMED). Moving the marker
 * later clears the confirmation (migration 103 trigger) until confirmed again.
 */
export async function confirmServiceLocationGps(userId: string, organizationId: string, recipientId: string, locationId: string,
  input: z.infer<typeof confirmGpsSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    const current = await lockedLocation(trx, organizationId, recipientId, locationId);
    if (current.archived_at) throw new LocationConflictError("LOCATION_ARCHIVED");
    const lat = Math.round(input.latitude * 1e6) / 1e6;
    const lng = Math.round(input.longitude * 1e6) / 1e6;
    const row = (await sql<LocationRow>`
      UPDATE care_recipient_locations SET latitude = ${lat}, longitude = ${lng},
        gps_confirmed_at = now(), gps_confirmed_by_user_id = ${userId}, updated_at = now(), updated_by_user_id = ${userId}
      WHERE id = ${locationId} AND organization_id = ${organizationId}
      RETURNING ${columns}`.execute(trx)).rows[0];
    return { location: await view(trx, row) };
  });
}

export async function archiveServiceLocation(userId: string, organizationId: string, recipientId: string, locationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    const current = await lockedLocation(trx, organizationId, recipientId, locationId);
    if (current.is_primary) throw new LocationConflictError("PRIMARY_CANNOT_BE_ARCHIVED");
    const inUse = (await upcomingShifts(trx, organizationId, recipientId)).filter((s) => s.effective_location_id === locationId);
    if (inUse.length) throw new LocationConflictError("LOCATION_IN_USE_BY_UPCOMING_SHIFTS");
    await sql`UPDATE care_recipient_locations SET archived_at = now(), updated_at = now(), updated_by_user_id = ${userId}
      WHERE id = ${locationId} AND organization_id = ${organizationId} AND archived_at IS NULL`.execute(trx);
    return { archived: true };
  });
}

/** Explicit, audited action (trigger in 100): move upcoming shifts to another address. */
export async function reassignShiftLocations(userId: string, organizationId: string, recipientId: string, input: z.infer<typeof reassignShiftsSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    const target = await lockedLocation(trx, organizationId, recipientId, input.toLocationId);
    if (target.archived_at) throw new LocationConflictError("LOCATION_ARCHIVED");
    const moved = (await sql<{ id: string }>`
      UPDATE shifts SET service_location_id = ${input.toLocationId}::uuid, updated_at = now()
      WHERE organization_id = ${organizationId} AND care_recipient_id = ${recipientId}
        AND id = ANY(${input.shiftIds}::uuid[]) AND status IN ('unassigned', 'confirmed') AND scheduled_end > now()
        AND service_location_id IS DISTINCT FROM ${input.toLocationId}::uuid
      RETURNING id`.execute(trx)).rows.map((r) => r.id);
    if (moved.length) {
      // Tell the assigned caregivers that the address of their shift changed (no address in the notice).
      await sql`SELECT app_notify_shift_location_changed(${moved}::uuid[])`.execute(trx);
    }
    return { movedShiftIds: moved };
  });
}

export async function listServiceLocationHistory(userId: string, organizationId: string, recipientId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    await requireRecipient(trx, organizationId, recipientId);
    const events = (await sql<{ id: string; location_id: string; event_type: string; occurred_at: string; actor_user_id: string | null; previous: unknown; current: unknown }>`
      SELECT id, location_id, event_type, occurred_at, actor_user_id, previous, current
      FROM care_recipient_location_events
      WHERE care_recipient_id = ${recipientId} AND organization_id = ${organizationId}
      ORDER BY occurred_at DESC LIMIT 100`.execute(trx)).rows;
    const access = (await sql<{ location_id: string; shift_id: string; user_id: string; accessed_on: string; first_access_at: string; display_name: string | null }>`
      SELECT log.location_id, log.shift_id, log.user_id, log.accessed_on::text, log.first_access_at,
             (SELECT w.display_name FROM workers w WHERE w.user_id = log.user_id LIMIT 1) AS display_name
      FROM care_recipient_location_access_log log
      JOIN care_recipient_locations l ON l.id = log.location_id AND l.organization_id = log.organization_id
      WHERE l.care_recipient_id = ${recipientId} AND log.organization_id = ${organizationId}
      ORDER BY log.first_access_at DESC LIMIT 100`.execute(trx)).rows;
    return { events, access };
  });
}

// ------------------------------------------------------------------ shifts

/** Location id the shift will use when created: the requested one, or the primary. */
export async function resolveShiftLocationInTransaction(trx: Trx, organizationId: string, recipientId: string, requested?: string | null) {
  if (requested) {
    const r = await sql<{ id: string }>`
      SELECT id FROM care_recipient_locations
      WHERE id = ${requested} AND organization_id = ${organizationId} AND care_recipient_id = ${recipientId} AND archived_at IS NULL`.execute(trx);
    if (!r.rows[0]) throw new LocationNotFoundError();
    return requested;
  }
  const primary = await sql<{ id: string }>`
    SELECT id FROM care_recipient_locations
    WHERE organization_id = ${organizationId} AND care_recipient_id = ${recipientId} AND is_primary AND archived_at IS NULL`.execute(trx);
  return primary.rows[0]?.id ?? null;
}

/** Managers: addresses selectable for a new shift of this person (no notes, no history). */
export async function listShiftLocationOptions(userId: string, organizationId: string, recipientId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    const rows = (await sql<LocationRow>`
      SELECT ${columns} FROM care_recipient_locations
      WHERE care_recipient_id = ${recipientId} AND organization_id = ${organizationId} AND archived_at IS NULL
      ORDER BY is_primary DESC, created_at`.execute(trx)).rows;
    const out = [];
    for (const row of rows) {
      const v = await view(trx, row);
      out.push({ id: v.id, label: v.label, isPrimary: v.isPrimary, verified: Boolean(v.verifiedAt), gpsConfirmed: Boolean(v.gpsConfirmedAt),
        summary: v.establishment ? `${v.establishment.name}${v.establishment.address ? ` · ${v.establishment.address}` : ""}`
          : [v.addressLine, v.municipality].filter(Boolean).join(", ") || "Ubicación marcada en el mapa" });
    }
    return out;
  });
}

/**
 * The confirmed address of one shift. Managers of the agency, or the worker
 * assigned to it right now (RLS). Each worker access is logged once per day.
 */
export async function getShiftServiceLocation(userId: string, organizationId: string, shiftId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const shift = (await sql<{ id: string; care_recipient_id: string | null; service_location_id: string | null }>`
      SELECT id, care_recipient_id, service_location_id FROM shifts WHERE id = ${shiftId} AND organization_id = ${organizationId}`.execute(trx)).rows[0];
    if (!shift || !shift.care_recipient_id) throw new LocationNotFoundError();
    const manager = (await sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`.execute(trx)).rows[0]?.ok;
    if (!manager) {
      const assigned = (await sql<{ ok: boolean }>`SELECT app_worker_has_shift_assignment(${shiftId}::uuid) AS ok`.execute(trx)).rows[0]?.ok;
      if (!assigned) throw new LocationNotFoundError();
    }
    const row = (await sql<LocationRow>`
      SELECT ${columns} FROM care_recipient_locations
      WHERE organization_id = ${organizationId} AND care_recipient_id = ${shift.care_recipient_id}
        AND ${shift.service_location_id ? sql`id = ${shift.service_location_id}` : sql`is_primary AND archived_at IS NULL`}`.execute(trx)).rows[0];
    if (!row) return { location: null };
    if (!manager) {
      await sql`
        INSERT INTO care_recipient_location_access_log (organization_id, location_id, shift_id, user_id)
        VALUES (${organizationId}, ${row.id}, ${shiftId}, ${userId})
        ON CONFLICT DO NOTHING`.execute(trx);
    }
    const v = await view(trx, row);
    return { location: { id: v.id, label: v.label, addressLine: v.addressLine, municipality: v.municipality, postalCode: v.postalCode,
      accessNotes: v.accessNotes,
      // Navigation uses ONLY a point the agency confirmed; otherwise the written
      // address (approximate). Unconfirmed coordinates are not handed out.
      latitude: v.gpsConfirmedAt ? v.latitude : null, longitude: v.gpsConfirmedAt ? v.longitude : null,
      gpsConfirmed: Boolean(v.gpsConfirmedAt), establishment: v.establishment, verified: Boolean(v.verifiedAt) } };
  });
}

// ------------------------------------------------------------------ family

async function familyRelationship(userId: string, recipientId: string) {
  const rel = await withUserContext(userId, async (trx) => (await sql<{ id: string; organization_id: string; can_view_service_location: boolean }>`
    SELECT id, organization_id, can_view_service_location FROM family_relationships
    WHERE user_id = ${userId} AND care_recipient_id = ${recipientId} AND status = 'active' LIMIT 1`.execute(trx)).rows[0]);
  if (!rel) throw new RecipientNotFoundError();
  return rel;
}

/** Family: the primary address only when the agency enabled it (RLS enforces it too). */
export async function getFamilyServiceLocation(userId: string, recipientId: string) {
  const rel = await familyRelationship(userId, recipientId);
  return withTenantContext({ userId, organizationId: rel.organization_id }, async (trx) => {
    const row = (await sql<LocationRow>`
      SELECT ${columns} FROM care_recipient_locations
      WHERE care_recipient_id = ${recipientId} AND organization_id = ${rel.organization_id} AND is_primary AND archived_at IS NULL`.execute(trx)).rows[0];
    if (!rel.can_view_service_location || !row) return { canView: rel.can_view_service_location, location: null };
    const v = await view(trx, row);
    // Minimal: no coordinates, no access notes, no history.
    return { canView: true, location: { label: v.label, addressLine: v.addressLine, municipality: v.municipality,
      postalCode: v.postalCode, establishment: v.establishment ? { name: v.establishment.name, address: v.establishment.address } : null,
      verified: Boolean(v.verifiedAt) } };
  });
}

export async function createLocationChangeRequest(userId: string, recipientId: string, input: z.infer<typeof changeRequestSchema>) {
  const rel = await familyRelationship(userId, recipientId);
  return withTenantContext({ userId, organizationId: rel.organization_id }, async (trx) => {
    try {
      const r = await sql<{ id: string; status: string; created_at: string }>`
        INSERT INTO care_recipient_location_change_requests (organization_id, care_recipient_id, family_relationship_id,
          requested_by_user_id, proposed_address_line, proposed_municipality, proposed_postal_code, proposed_access_notes, message)
        VALUES (${rel.organization_id}, ${recipientId}, ${rel.id}, ${userId}, ${input.addressLine ?? null}, ${input.municipality ?? null},
          ${input.postalCode ?? null}, ${input.accessNotes ?? null}, ${input.message ?? null})
        RETURNING id, status, created_at`.execute(trx);
      return r.rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new LocationConflictError("PENDING_REQUEST_EXISTS");
      throw e;
    }
  });
}

const requestColumns = sql`id, status, proposed_address_line, proposed_municipality, proposed_postal_code, proposed_access_notes,
  message, resolution_note, resolved_at, created_at`;

export async function listMyLocationChangeRequests(userId: string, recipientId: string) {
  const rel = await familyRelationship(userId, recipientId);
  return withTenantContext({ userId, organizationId: rel.organization_id }, async (trx) => (await sql`
    SELECT ${requestColumns} FROM care_recipient_location_change_requests
    WHERE care_recipient_id = ${recipientId} AND requested_by_user_id = ${userId}
    ORDER BY created_at DESC LIMIT 20`.execute(trx)).rows);
}

export async function listLocationChangeRequests(userId: string, organizationId: string, recipientId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    return (await sql`
      SELECT r.id, r.status, r.proposed_address_line, r.proposed_municipality, r.proposed_postal_code, r.proposed_access_notes,
             r.message, r.resolution_note, r.resolved_at, r.created_at, fr.relationship_type
      FROM care_recipient_location_change_requests r
      JOIN family_relationships fr ON fr.id = r.family_relationship_id
      WHERE r.care_recipient_id = ${recipientId} AND r.organization_id = ${organizationId}
      ORDER BY (r.status = 'PENDING') DESC, r.created_at DESC LIMIT 50`.execute(trx)).rows;
  });
}

/**
 * Managers decide. APPROVE applies the proposal (or the manager's edited values)
 * to the primary address in the same transaction (history via trigger); the
 * relative is notified by trigger. The family never writes the address.
 */
export async function resolveLocationChangeRequest(userId: string, organizationId: string, recipientId: string, requestId: string,
  input: z.infer<typeof resolveChangeRequestSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    const req = (await sql<{ id: string; status: string; proposed_address_line: string | null; proposed_municipality: string | null;
      proposed_postal_code: string | null; proposed_access_notes: string | null }>`
      SELECT id, status, proposed_address_line, proposed_municipality, proposed_postal_code, proposed_access_notes
      FROM care_recipient_location_change_requests
      WHERE id = ${requestId} AND organization_id = ${organizationId} AND care_recipient_id = ${recipientId}
      FOR UPDATE`.execute(trx)).rows[0];
    if (!req) throw new LocationNotFoundError();
    if (req.status !== "PENDING") throw new LocationConflictError("REQUEST_ALREADY_RESOLVED");
    let appliedLocationId: string | null = null;
    let affectedShiftIds: string[] = [];
    if (input.decision === "APPROVE") {
      const values = input.apply ?? {
        addressLine: req.proposed_address_line, municipality: req.proposed_municipality,
        postalCode: req.proposed_postal_code, accessNotes: req.proposed_access_notes,
      };
      const primary = (await sql<LocationRow>`
        SELECT ${columns} FROM care_recipient_locations
        WHERE care_recipient_id = ${recipientId} AND organization_id = ${organizationId} AND is_primary AND archived_at IS NULL
        FOR UPDATE`.execute(trx)).rows[0];
      if (primary) {
        const keepEst = primary.establishment_id && !values.addressLine;
        const nextPlace = {
          address_line: keepEst ? null : values.addressLine ?? primary.address_line,
          municipality: keepEst ? null : values.municipality ?? primary.municipality,
          postal_code: keepEst ? null : values.postalCode ?? primary.postal_code,
          establishment_id: keepEst ? primary.establishment_id : null,
        };
        const placeChanges = (["address_line", "municipality", "postal_code", "establishment_id"] as const)
          .some((k) => (nextPlace[k] ?? null) !== (primary[k] ?? null));
        // Upcoming shifts follow the official address: the agency must authorize it explicitly.
        const affected = placeChanges
          ? (await upcomingShifts(trx, organizationId, recipientId)).filter((s) => s.effective_location_id === primary.id).map((s) => s.id)
          : [];
        if (affected.length > 0 && input.confirmUpcomingShifts !== true) throw new LocationConflictError("UPCOMING_SHIFTS_NEED_CONFIRMATION");
        affectedShiftIds = affected;
        await sql`
          UPDATE care_recipient_locations SET
            address_line = ${keepEst ? null : values.addressLine ?? primary.address_line},
            municipality = ${keepEst ? null : values.municipality ?? primary.municipality},
            postal_code = ${keepEst ? null : values.postalCode ?? primary.postal_code},
            access_notes = ${values.accessNotes ?? primary.access_notes},
            establishment_id = ${keepEst ? primary.establishment_id : null},
            updated_at = now(), updated_by_user_id = ${userId}
          WHERE id = ${primary.id} AND organization_id = ${organizationId}`.execute(trx);
        appliedLocationId = primary.id;
      } else {
        appliedLocationId = (await sql<{ id: string }>`
          INSERT INTO care_recipient_locations (care_recipient_id, organization_id, label, address_line, municipality, postal_code,
            access_notes, is_primary, updated_at, updated_by_user_id)
          VALUES (${recipientId}, ${organizationId}, 'Principal', ${values.addressLine ?? null}, ${values.municipality ?? null},
            ${values.postalCode ?? null}, ${values.accessNotes ?? null}, true, now(), ${userId})
          RETURNING id`.execute(trx)).rows[0].id;
      }
    }
    await sql`
      UPDATE care_recipient_location_change_requests SET
        status = ${input.decision === "APPROVE" ? "APPROVED" : "REJECTED"}, resolution_note = ${input.note ?? null},
        resolved_by_user_id = ${userId}, resolved_at = now(), applied_location_id = ${appliedLocationId}
      WHERE id = ${requestId} AND organization_id = ${organizationId}`.execute(trx);
    // Tell the assigned caregivers their shift's address changed (never the address itself).
    if (affectedShiftIds.length > 0) await sql`SELECT app_notify_shift_location_changed(${affectedShiftIds}::uuid[])`.execute(trx);
    return { status: input.decision === "APPROVE" ? "APPROVED" : "REJECTED", appliedLocationId, upcomingShiftsUpdated: affectedShiftIds.length };
  });
}

/** Managers: relatives of this person and whether each may see the address. */
export async function listFamilyLocationPermissions(userId: string, organizationId: string, recipientId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    return (await sql<{ id: string; relationship_type: string; is_primary_contact: boolean; can_view_service_location: boolean }>`
      SELECT id, relationship_type, is_primary_contact, can_view_service_location
      FROM family_relationships
      WHERE care_recipient_id = ${recipientId} AND organization_id = ${organizationId} AND status = 'active'
      ORDER BY is_primary_contact DESC, created_at`.execute(trx)).rows;
  });
}

export async function setFamilyLocationPermission(userId: string, organizationId: string, recipientId: string, relationshipId: string, canView: boolean) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    const r = await sql<{ id: string }>`
      UPDATE family_relationships SET can_view_service_location = ${canView}
      WHERE id = ${relationshipId} AND care_recipient_id = ${recipientId} AND organization_id = ${organizationId} AND status = 'active'
      RETURNING id`.execute(trx);
    if (!r.rows[0]) throw new LocationNotFoundError();
    return { relationshipId, canViewServiceLocation: canView };
  });
}
