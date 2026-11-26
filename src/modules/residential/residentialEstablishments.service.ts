import { sql, type Transaction } from "kysely";
import type { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { ResidentialError, RESIDENTIAL_MANAGER_REQUIRED, RESIDENTIAL_NOT_FOUND } from "./residentialErrors.js";
import type { closeSchema, createRoomSchema, createUnitSchema, geofenceSchema, placementSchema, updateRoomSchema, updateUnitSchema } from "./residentialEstablishments.schemas.js";

/**
 * 171 · Hogares F1: establecimientos, unidades, habitaciones, camas, ubicación de residentes, geocerca y cierre.
 *
 * Solo hogares (residentialGate) y solo administración del hogar (app_is_org_manager). Las reglas de integridad
 * viven en la base de datos (171); aquí se validan entradas y se arman respuestas.
 *
 * Convención de la habitación técnica (docs/RESIDENTIAL_TECHNICAL_ROOM.md): la unidad y la habitación técnicas
 * NUNCA salen en una respuesta ni cuentan en ningún total. Todas las consultas las excluyen con
 * establishment_technical_rooms.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Trx = Transaction<any>;



async function requireManager(trx: Trx): Promise<void> {
  const r = await sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`.execute(trx);
  if (!r.rows[0]?.ok) throw new ResidentialError(RESIDENTIAL_MANAGER_REQUIRED, 403);
}
const manage = <T>(userId: string, organizationId: string, fn: (trx: Trx) => Promise<T>) =>
  withTenantContext({ userId, organizationId }, async (trx) => { await requireManager(trx); return fn(trx); });
const notFound = () => new ResidentialError(RESIDENTIAL_NOT_FOUND, 404);
const setReason = (trx: Trx, text: string | null | undefined) =>
  sql`SELECT set_config('app.residential_change_reason', ${text ?? ""}, true)`.execute(trx);

// Fragmentos que excluyen las piezas técnicas.
const NOT_TECH_UNIT = sql`NOT EXISTS (SELECT 1 FROM establishment_technical_rooms t WHERE t.unit_id = u.id)`;
const NOT_TECH_ROOM = sql`NOT EXISTS (SELECT 1 FROM establishment_technical_rooms t WHERE t.room_id = r.id)`;

export type Occupancy = {
  rooms: number; bedsRegistered: number; bedsOccupied: number; bedsAvailable: number;
  activeResidents: number; residentsWithoutRoom: number; occupancyPercent: number | null;
  capacityConfigured: boolean; overCapacity: boolean;
};

export async function occupancyFor(trx: Trx, organizationId: string, locationIds: string[]): Promise<Map<string, Occupancy>> {
  const out = new Map<string, Occupancy>();
  if (locationIds.length === 0) return out;
  const rows = await sql<{ location_id: string; rooms: number; beds: number | null; beds_occupied: number; configured: number; over: number; active: number; without_room: number }>`
    WITH loc AS (SELECT unnest(${locationIds}::uuid[]) AS id),
    rm AS (
      SELECT u.location_id, r.id, rp.bed_capacity,
             (SELECT count(*)::int FROM care_recipients cr WHERE cr.room_id = r.id AND cr.status = 'active') AS occupants
      FROM rooms r JOIN units u ON u.id = r.unit_id AND u.organization_id = r.organization_id
      LEFT JOIN room_profiles rp ON rp.room_id = r.id
      WHERE r.organization_id = ${organizationId} AND r.archived_at IS NULL AND u.archived_at IS NULL
        AND u.location_id IN (SELECT id FROM loc) AND ${NOT_TECH_ROOM}
    )
    SELECT loc.id AS location_id,
      (SELECT count(*)::int FROM rm WHERE rm.location_id = loc.id) AS rooms,
      (SELECT sum(bed_capacity)::int FROM rm WHERE rm.location_id = loc.id) AS beds,
      (SELECT COALESCE(sum(occupants), 0)::int FROM rm WHERE rm.location_id = loc.id AND bed_capacity IS NOT NULL) AS beds_occupied,
      (SELECT count(*)::int FROM rm WHERE rm.location_id = loc.id AND bed_capacity IS NOT NULL) AS configured,
      (SELECT count(*)::int FROM rm WHERE rm.location_id = loc.id AND bed_capacity IS NOT NULL AND occupants > bed_capacity) AS over,
      (SELECT count(*)::int FROM care_recipients cr WHERE cr.organization_id = ${organizationId} AND cr.location_id = loc.id AND cr.status = 'active') AS active,
      (SELECT count(*)::int FROM care_recipients cr WHERE cr.organization_id = ${organizationId} AND cr.location_id = loc.id AND cr.status = 'active' AND cr.room_id IS NULL) AS without_room
    FROM loc`.execute(trx);
  for (const r of rows.rows) {
    const beds = r.beds ?? 0;
    out.set(r.location_id, {
      rooms: r.rooms, bedsRegistered: beds, bedsOccupied: r.beds_occupied, bedsAvailable: Math.max(beds - r.beds_occupied, 0),
      activeResidents: r.active, residentsWithoutRoom: r.without_room,
      occupancyPercent: beds > 0 ? Math.round((r.beds_occupied / beds) * 100) : null,
      capacityConfigured: r.configured > 0, overCapacity: r.over > 0 || r.beds_occupied > beds && beds > 0,
    });
  }
  return out;
}

export function listResidentialEstablishments(userId: string, organizationId: string) {
  return manage(userId, organizationId, async (trx) => {
    const locs = await sql<{ id: string; name: string; address: string | null; archived_at: string | null; geofence_radius_m: number | null; has_center: boolean }>`
      SELECT l.id, l.name, l.address, l.archived_at, s.geofence_radius_m, (s.geofence_latitude IS NOT NULL) AS has_center
      FROM locations l LEFT JOIN establishment_settings s ON s.location_id = l.id
      WHERE l.organization_id = ${organizationId} ORDER BY l.archived_at NULLS FIRST, l.name`.execute(trx);
    const occ = await occupancyFor(trx, organizationId, locs.rows.map((l) => l.id));
    return locs.rows.map((l) => ({
      id: l.id, name: l.name, address: l.address, status: l.archived_at ? "closed" : "active",
      geofence: { radiusMeters: l.geofence_radius_m ?? 100, centerConfigured: l.has_center === true },
      occupancy: occ.get(l.id)!,
    }));
  });
}

async function establishmentRow(trx: Trx, organizationId: string, establishmentId: string) {
  const r = await sql<{ id: string; name: string; address: string | null; archived_at: string | null }>`
    SELECT id, name, address, archived_at FROM locations WHERE id = ${establishmentId} AND organization_id = ${organizationId}`.execute(trx);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

export function getResidentialEstablishment(userId: string, organizationId: string, establishmentId: string) {
  return manage(userId, organizationId, async (trx) => {
    const est = await establishmentRow(trx, organizationId, establishmentId);
    const settings = (await sql<{ geofence_radius_m: number; geofence_latitude: string | null; geofence_longitude: string | null; updated_at: string }>`
      SELECT geofence_radius_m, geofence_latitude, geofence_longitude, updated_at FROM establishment_settings WHERE location_id = ${establishmentId}`.execute(trx)).rows[0];
    const units = await sql<{ id: string; name: string; archived_at: string | null; is_general: boolean }>`
      SELECT u.id, u.name, u.archived_at, EXISTS (SELECT 1 FROM establishment_general_units g WHERE g.unit_id = u.id) AS is_general
      FROM units u WHERE u.organization_id = ${organizationId} AND u.location_id = ${establishmentId} AND ${NOT_TECH_UNIT}
      ORDER BY is_general DESC, u.archived_at NULLS FIRST, u.name`.execute(trx);
    const rooms = await sql<{ id: string; unit_id: string; name: string; archived_at: string | null; bed_capacity: number | null }>`
      SELECT r.id, r.unit_id, r.name, r.archived_at, rp.bed_capacity
      FROM rooms r JOIN units u ON u.id = r.unit_id AND u.organization_id = r.organization_id
      LEFT JOIN room_profiles rp ON rp.room_id = r.id
      WHERE r.organization_id = ${organizationId} AND u.location_id = ${establishmentId} AND ${NOT_TECH_ROOM}
      ORDER BY r.archived_at NULLS FIRST, r.name`.execute(trx);
    const residents = await sql<{ id: string; first_name: string; last_name: string; preferred_name: string | null; room_id: string | null }>`
      SELECT id, first_name, last_name, preferred_name, room_id FROM care_recipients
      WHERE organization_id = ${organizationId} AND location_id = ${establishmentId} AND status = 'active'
      ORDER BY last_name, first_name`.execute(trx);
    const person = (p: (typeof residents.rows)[number]) => ({ id: p.id, displayName: `${p.preferred_name || p.first_name} ${p.last_name}`.trim() });
    const occ = (await occupancyFor(trx, organizationId, [establishmentId])).get(establishmentId)!;
    return {
      establishment: { id: est.id, name: est.name, address: est.address, status: est.archived_at ? "closed" : "active" },
      geofence: settings ? {
        radiusMeters: settings.geofence_radius_m,
        latitude: settings.geofence_latitude === null ? null : Number(settings.geofence_latitude),
        longitude: settings.geofence_longitude === null ? null : Number(settings.geofence_longitude),
        updatedAt: settings.updated_at,
      } : null,
      occupancy: occ,
      units: units.rows.map((u) => ({
        id: u.id, name: u.name, isGeneral: u.is_general, status: u.archived_at ? "archived" : "active",
        rooms: rooms.rows.filter((r) => r.unit_id === u.id).map((r) => {
          const occupants = residents.rows.filter((p) => p.room_id === r.id).map(person);
          return {
            id: r.id, name: r.name, status: r.archived_at ? "archived" : "active", bedCapacity: r.bed_capacity,
            occupants, overCapacity: r.bed_capacity !== null && occupants.length > r.bed_capacity,
          };
        }),
      })),
      residentsWithoutRoom: residents.rows.filter((p) => p.room_id === null).map(person),
    };
  });
}

async function unitRow(trx: Trx, organizationId: string, unitId: string) {
  const r = await sql<{ id: string; location_id: string }>`
    SELECT u.id, u.location_id FROM units u WHERE u.id = ${unitId} AND u.organization_id = ${organizationId} AND ${NOT_TECH_UNIT}`.execute(trx);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

export function createResidentialUnit(userId: string, organizationId: string, establishmentId: string, input: z.infer<typeof createUnitSchema>) {
  return manage(userId, organizationId, async (trx) => {
    await establishmentRow(trx, organizationId, establishmentId);
    const r = await sql<{ id: string; name: string }>`
      INSERT INTO units (location_id, organization_id, name) VALUES (${establishmentId}, ${organizationId}, ${input.name}) RETURNING id, name`.execute(trx);
    return { id: r.rows[0].id, name: r.rows[0].name, isGeneral: false, status: "active", rooms: [] };
  });
}

export function updateResidentialUnit(userId: string, organizationId: string, unitId: string, input: z.infer<typeof updateUnitSchema>) {
  return manage(userId, organizationId, async (trx) => {
    await unitRow(trx, organizationId, unitId);
    const sets = [sql`updated_at = now()`];
    if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
    if (input.archived !== undefined) sets.push(input.archived ? sql`archived_at = now()` : sql`archived_at = NULL`);
    const r = await sql<{ id: string; name: string; archived_at: string | null }>`
      UPDATE units SET ${sql.join(sets)} WHERE id = ${unitId} AND organization_id = ${organizationId} RETURNING id, name, archived_at`.execute(trx);
    return { id: r.rows[0].id, name: r.rows[0].name, status: r.rows[0].archived_at ? "archived" : "active" };
  });
}

async function roomRow(trx: Trx, organizationId: string, roomId: string) {
  const r = await sql<{ id: string; unit_id: string; location_id: string }>`
    SELECT r.id, r.unit_id, u.location_id FROM rooms r JOIN units u ON u.id = r.unit_id AND u.organization_id = r.organization_id
    WHERE r.id = ${roomId} AND r.organization_id = ${organizationId} AND ${NOT_TECH_ROOM}`.execute(trx);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

async function setBedCapacity(trx: Trx, organizationId: string, roomId: string, capacity: number | null) {
  await sql`INSERT INTO room_profiles (room_id, organization_id, bed_capacity) VALUES (${roomId}, ${organizationId}, ${capacity})
            ON CONFLICT (room_id) DO UPDATE SET bed_capacity = EXCLUDED.bed_capacity`.execute(trx);
}

export function createResidentialRoom(userId: string, organizationId: string, establishmentId: string, input: z.infer<typeof createRoomSchema>) {
  return manage(userId, organizationId, async (trx) => {
    await establishmentRow(trx, organizationId, establishmentId);
    let unitId = input.unitId;
    if (unitId) {
      const unit = await unitRow(trx, organizationId, unitId);
      if (unit.location_id !== establishmentId) throw notFound();
    } else {
      const g = await sql<{ unit_id: string }>`SELECT unit_id FROM establishment_general_units WHERE location_id = ${establishmentId}`.execute(trx);
      if (!g.rows[0]) throw notFound();
      unitId = g.rows[0].unit_id;
    }
    const r = await sql<{ id: string; name: string }>`
      INSERT INTO rooms (unit_id, organization_id, name) VALUES (${unitId}, ${organizationId}, ${input.name}) RETURNING id, name`.execute(trx);
    if (input.bedCapacity !== undefined && input.bedCapacity !== null) await setBedCapacity(trx, organizationId, r.rows[0].id, input.bedCapacity);
    return { id: r.rows[0].id, unitId, name: r.rows[0].name, status: "active", bedCapacity: input.bedCapacity ?? null, occupants: [], overCapacity: false };
  });
}

export function updateResidentialRoom(userId: string, organizationId: string, roomId: string, input: z.infer<typeof updateRoomSchema>) {
  return manage(userId, organizationId, async (trx) => {
    const room = await roomRow(trx, organizationId, roomId);
    if (input.unitId !== undefined && input.unitId !== room.unit_id) await unitRow(trx, organizationId, input.unitId);
    if (input.name !== undefined || input.unitId !== undefined || input.archived !== undefined) {
      const sets = [sql`updated_at = now()`];
      if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
      if (input.unitId !== undefined) sets.push(sql`unit_id = ${input.unitId}`);
      if (input.archived !== undefined) sets.push(input.archived ? sql`archived_at = now()` : sql`archived_at = NULL`);
      await sql`UPDATE rooms SET ${sql.join(sets)} WHERE id = ${roomId} AND organization_id = ${organizationId}`.execute(trx);
    }
    if (input.bedCapacity !== undefined) await setBedCapacity(trx, organizationId, roomId, input.bedCapacity);
    const r = await sql<{ id: string; unit_id: string; name: string; archived_at: string | null; bed_capacity: number | null; occupants: number }>`
      SELECT r.id, r.unit_id, r.name, r.archived_at, rp.bed_capacity,
             (SELECT count(*)::int FROM care_recipients cr WHERE cr.room_id = r.id AND cr.status = 'active') AS occupants
      FROM rooms r LEFT JOIN room_profiles rp ON rp.room_id = r.id WHERE r.id = ${roomId}`.execute(trx);
    const x = r.rows[0];
    return { id: x.id, unitId: x.unit_id, name: x.name, status: x.archived_at ? "archived" : "active", bedCapacity: x.bed_capacity,
      overCapacity: x.bed_capacity !== null && x.occupants > x.bed_capacity };
  });
}

/** Ubicar, mover o trasladar a un residente. Superar las camas advierte, nunca bloquea (D8). */
export function placeResidentialResident(userId: string, organizationId: string, recipientId: string, input: z.infer<typeof placementSchema>) {
  return manage(userId, organizationId, async (trx) => {
    const cur = await sql<{ id: string; location_id: string | null; room_id: string | null; status: string }>`
      SELECT id, location_id, room_id, status FROM care_recipients WHERE id = ${recipientId} AND organization_id = ${organizationId}`.execute(trx);
    if (!cur.rows[0] || cur.rows[0].status !== "active") throw notFound();
    let locationId: string | null = cur.rows[0].location_id;
    if (input.roomId) {
      const room = await roomRow(trx, organizationId, input.roomId);
      if (input.establishmentId && input.establishmentId !== room.location_id) throw new ResidentialError("RESIDENTIAL_ROOM_LOCATION_MISMATCH", 409);
      locationId = room.location_id;
    } else if (input.establishmentId) {
      await establishmentRow(trx, organizationId, input.establishmentId);
      locationId = input.establishmentId;
    }
    if (locationId === null) throw new ResidentialError("RESIDENTIAL_ESTABLISHMENT_REQUIRED", 409);
    const closed = await sql<{ closed: boolean }>`SELECT archived_at IS NOT NULL AS closed FROM locations WHERE id = ${locationId}`.execute(trx);
    if (closed.rows[0]?.closed) throw new ResidentialError("RESIDENTIAL_ESTABLISHMENT_CLOSED", 409);
    await setReason(trx, input.reason ?? null);
    await sql`UPDATE care_recipients SET location_id = ${locationId}, room_id = ${input.roomId}, updated_at = now()
              WHERE id = ${recipientId} AND organization_id = ${organizationId}`.execute(trx);
    await setReason(trx, null);
    let overCapacity = false;
    if (input.roomId) {
      const c = await sql<{ over: boolean }>`
        SELECT COALESCE(rp.bed_capacity < (SELECT count(*) FROM care_recipients cr WHERE cr.room_id = ${input.roomId} AND cr.status = 'active'), false) AS over
        FROM rooms r LEFT JOIN room_profiles rp ON rp.room_id = r.id WHERE r.id = ${input.roomId}`.execute(trx);
      overCapacity = c.rows[0]?.over === true;
    }
    return { residentId: recipientId, establishmentId: locationId, roomId: input.roomId, overCapacity };
  });
}

export function residentialResidentHistory(userId: string, organizationId: string, recipientId: string) {
  return manage(userId, organizationId, async (trx) => {
    const exists = await sql`SELECT 1 FROM care_recipients WHERE id = ${recipientId} AND organization_id = ${organizationId}`.execute(trx);
    if (!exists.rows[0]) throw notFound();
    // Nombres resueltos en el momento de la consulta (archivadas incluidas). Nunca la habitación técnica: no puede
    // tener residentes (guarda de la 171).
    const r = await sql<{ occurred_at: string; reason: string | null; from_location: string | null; to_location: string | null; from_room: string | null; to_room: string | null; actor: string | null }>`
      SELECT e.occurred_at, e.reason, fl.name AS from_location, tl.name AS to_location, fr.name AS from_room, tr.name AS to_room, u.email AS actor
      FROM care_recipient_room_events e
      LEFT JOIN locations fl ON fl.id = e.from_location_id LEFT JOIN locations tl ON tl.id = e.to_location_id
      LEFT JOIN rooms fr ON fr.id = e.from_room_id LEFT JOIN rooms tr ON tr.id = e.to_room_id
      LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.organization_id = ${organizationId} AND e.care_recipient_id = ${recipientId}
      ORDER BY e.occurred_at DESC LIMIT 200`.execute(trx);
    return r.rows.map((x) => ({ occurredAt: x.occurred_at, reason: x.reason, fromEstablishment: x.from_location, toEstablishment: x.to_location,
      fromRoom: x.from_room, toRoom: x.to_room, actorEmail: x.actor }));
  });
}

export function updateResidentialGeofence(userId: string, organizationId: string, establishmentId: string, input: z.infer<typeof geofenceSchema>) {
  return manage(userId, organizationId, async (trx) => {
    await establishmentRow(trx, organizationId, establishmentId);
    await setReason(trx, input.reason);
    const sets = [sql`geofence_radius_m = ${input.radiusMeters}`];
    if (input.latitude !== undefined) sets.push(sql`geofence_latitude = ${input.latitude === null ? null : input.latitude.toFixed(6)}::numeric`, sql`geofence_longitude = ${input.longitude === null || input.longitude === undefined ? null : input.longitude.toFixed(6)}::numeric`);
    const r = await sql<{ geofence_radius_m: number; geofence_latitude: string | null; geofence_longitude: string | null }>`
      UPDATE establishment_settings SET ${sql.join(sets)} WHERE location_id = ${establishmentId} AND organization_id = ${organizationId}
      RETURNING geofence_radius_m, geofence_latitude, geofence_longitude`.execute(trx);
    await setReason(trx, null);
    if (!r.rows[0]) throw notFound();
    const x = r.rows[0];
    return { radiusMeters: x.geofence_radius_m, latitude: x.geofence_latitude === null ? null : Number(x.geofence_latitude), longitude: x.geofence_longitude === null ? null : Number(x.geofence_longitude) };
  });
}

export function residentialGeofenceHistory(userId: string, organizationId: string, establishmentId: string) {
  return manage(userId, organizationId, async (trx) => {
    await establishmentRow(trx, organizationId, establishmentId);
    const r = await sql<{ occurred_at: string; reason: string; old_radius_m: number | null; new_radius_m: number; center_changed: boolean; actor: string | null }>`
      SELECT e.occurred_at, e.reason, e.old_radius_m, e.new_radius_m,
             (e.old_latitude IS DISTINCT FROM e.new_latitude OR e.old_longitude IS DISTINCT FROM e.new_longitude) AS center_changed, u.email AS actor
      FROM establishment_settings_events e LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.organization_id = ${organizationId} AND e.location_id = ${establishmentId} ORDER BY e.occurred_at DESC LIMIT 200`.execute(trx);
    return r.rows.map((x) => ({ occurredAt: x.occurred_at, reason: x.reason, oldRadiusMeters: x.old_radius_m, newRadiusMeters: x.new_radius_m, centerChanged: x.center_changed, actorEmail: x.actor }));
  });
}

/** Qué impide hoy cerrar el establecimiento (misma regla que el procedimiento de la base de datos). */
export function residentialClosureCheck(userId: string, organizationId: string, establishmentId: string) {
  return manage(userId, organizationId, async (trx) => {
    const est = await establishmentRow(trx, organizationId, establishmentId);
    const c = await sql<{ shifts: number; assignments: number; residents: number }>`
      WITH est_rooms AS (SELECT r.id FROM rooms r /* incluye la habitación técnica: sus turnos también bloquean el cierre; solo se cuentan turnos */ JOIN units u ON u.id = r.unit_id WHERE u.location_id = ${establishmentId}),
      est_shifts AS (
        SELECT s.id FROM shifts s WHERE s.organization_id = ${organizationId} AND s.status NOT IN ('cancelled', 'completed') AND s.scheduled_end > now()
          AND (s.room_id IN (SELECT id FROM est_rooms) OR s.care_recipient_id IN (SELECT id FROM care_recipients WHERE location_id = ${establishmentId})))
      SELECT (SELECT count(*)::int FROM est_shifts) AS shifts,
             (SELECT count(*)::int FROM assignments a WHERE a.shift_id IN (SELECT id FROM est_shifts) AND a.response_status IN ('pending', 'accepted')) AS assignments,
             (SELECT count(*)::int FROM care_recipients WHERE organization_id = ${organizationId} AND location_id = ${establishmentId} AND status = 'active') AS residents`.execute(trx);
    const x = c.rows[0];
    return { status: est.archived_at ? "closed" : "active", futureShifts: x.shifts, activeAssignments: x.assignments, activeResidents: x.residents,
      canClose: !est.archived_at && x.shifts === 0 && x.assignments === 0 && x.residents === 0 };
  });
}

export function closeResidentialEstablishment(userId: string, organizationId: string, establishmentId: string, input: z.infer<typeof closeSchema>) {
  return manage(userId, organizationId, async (trx) => {
    await establishmentRow(trx, organizationId, establishmentId);
    const r = await sql<{ result: { closed: boolean; roomsArchived: number; unitsArchived: number; staffLinksArchived: number } }>`
      SELECT app_residential_close_establishment(${establishmentId}::uuid, ${input.reason}) AS result`.execute(trx);
    return r.rows[0].result;
  });
}
