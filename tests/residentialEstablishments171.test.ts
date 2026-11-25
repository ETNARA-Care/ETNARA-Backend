import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { residentialRouteFor } from "../src/middleware/residentialRules.js";
import { residentialDbErrorCode, residentialDbErrorStatus } from "../src/modules/residential/residentialErrors.js";
import { createRoomSchema, createUnitSchema, geofenceSchema, placementSchema, updateRoomSchema } from "../src/modules/residential/residentialEstablishments.schemas.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const mig = read("migrations/171_residential_establishments_rooms.sql");
const rollback = read("ops/171_residential_establishments_rooms.rollback.sql");
const service = read("src/modules/residential/residentialEstablishments.service.ts");
const app = read("src/app.ts");
const doc = read("docs/RESIDENTIAL_TECHNICAL_ROOM.md");
const agents = read("AGENTS.md");
const ID = "11111111-2222-4333-8444-555555555555";

describe("171: hogares F1 (establecimientos y habitaciones)", () => {
  it("no modifica la tabla shifts", () => {
    expect(mig).not.toMatch(/ALTER TABLE\s+shifts|UPDATE\s+(public\.)?shifts|ON\s+(public\.)?shifts\b|DROP\s+\w+\s+.*shifts/i);
    expect(rollback).not.toMatch(/ALTER TABLE\s+shifts|UPDATE\s+(public\.)?shifts|ON\s+(public\.)?shifts\b/i);
  });
  it("no enciende interruptores ni toca organizaciones", () => {
    expect(mig).not.toMatch(/organization_features|UPDATE\s+(public\.)?organizations/i);
  });
  it("la habitación técnica: registro, «sin residentes» para cualquiera y protección fuera del procedimiento", () => {
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS establishment_technical_rooms/);
    const guard = mig.slice(mig.indexOf("FUNCTION public.app_residential_recipient_room_guard"), mig.indexOf("REVOKE ALL ON FUNCTION public.app_residential_recipient_room_guard"));
    expect(guard.indexOf("RESIDENTIAL_TECHNICAL_ROOM_NO_RESIDENTS")).toBeLessThan(guard.indexOf("app_org_is_residential"));
    expect(mig).toMatch(/current_user::text <> 'app_runtime'\s+AND COALESCE\(current_setting\('app\.residential_procedure', true\), ''\) = 'on'/);
    expect(mig).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON units/);
    expect(mig).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON rooms/);
  });
  it("escritura en units y rooms solo para administración de hogares, y sin DELETE", () => {
    for (const t of ["units", "rooms"]) {
      expect(mig).toMatch(new RegExp(`CREATE POLICY ${t}_residential_manager_insert ON ${t} FOR INSERT WITH CHECK \\(\\s*organization_id = NULLIF\\(current_setting\\('app\\.current_org_id', true\\), ''\\)::uuid\\s+AND app_is_org_manager\\(\\) AND app_org_is_residential\\(organization_id\\)\\)`));
      expect(mig).toMatch(new RegExp(`DROP POLICY IF EXISTS ${t}_membership_required ON ${t};`));
    }
    expect(mig).toMatch(/REVOKE DELETE ON units, rooms FROM app_runtime;/);
    expect(rollback).toMatch(/GRANT DELETE ON units, rooms TO app_runtime;/);
  });
  it("historiales solo de anexos, sin escritura desde la aplicación", () => {
    for (const t of ["establishment_settings_events", "care_recipient_room_events", "establishment_closures", "establishment_technical_rooms", "establishment_general_units"])
      expect(mig).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON ${t}\\s+FOR EACH ROW EXECUTE FUNCTION public\\.app_residential_append_only\\(\\)`));
    expect(mig).not.toMatch(/GRANT [^;]*INSERT[^;]*ON [^;]*(establishment_settings_events|care_recipient_room_events|establishment_closures)/);
  });
  it("el cierre rechaza turnos vigentes o futuros, asignaciones y residentes activos", () => {
    const fn = mig.slice(mig.indexOf("FUNCTION public.app_residential_close_establishment"), mig.indexOf("REVOKE ALL ON FUNCTION public.app_residential_close_establishment"));
    for (const code of ["RESIDENTIAL_CLOSURE_FUTURE_SHIFTS", "RESIDENTIAL_CLOSURE_ACTIVE_ASSIGNMENTS", "RESIDENTIAL_CLOSURE_ACTIVE_RESIDENTS", "RESIDENTIAL_MANAGER_REQUIRED"]) expect(fn).toContain(code);
    expect(fn).not.toMatch(/\bDELETE\b/);
    expect(fn.indexOf("set_config('app.residential_procedure', 'on', true)")).toBeLessThan(fn.indexOf("set_config('app.residential_procedure', 'off', true)"));
  });
  it("el cierre archiva solo los vínculos del personal con ese establecimiento y deja constancia de cuáles", () => {
    const fn = mig.slice(mig.indexOf("FUNCTION public.app_residential_close_establishment"), mig.indexOf("REVOKE ALL ON FUNCTION public.app_residential_close_establishment"));
    for (const t of ["establishment_worker_assignments", "establishment_admin_assignments"])
      expect(fn).toMatch(new RegExp(`UPDATE public\\.${t} SET archived_at = now\\(\\)\\s+WHERE location_id = p_location_id AND organization_id = v_org AND archived_at IS NULL RETURNING id`));
    expect(fn).not.toMatch(/organization_memberships|organization_worker_memberships|users|credentials|user_roles/);
    expect(fn).toMatch(/archived_worker_link_ids, archived_admin_link_ids/);
  });
  it("traslado: rechazado con turnos vigentes o futuros del residente (sin asignaciones colgadas)", () => {
    expect(mig).toMatch(/RESIDENTIAL_TRANSFER_ACTIVE_SHIFTS/);
    expect(mig).toMatch(/NEW\.location_id IS DISTINCT FROM OLD\.location_id[\s\S]{0,200}s\.care_recipient_id = NEW\.id/);
  });
  it("contrato de F3: si aparece shift_resident_assignments, su migración debe cerrar las asignaciones al trasladar", () => {
    const files = readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => /^\d{3}_.*\.sql$/.test(f));
    for (const f of files) {
      const text = read(`migrations/${f}`);
      if (/CREATE TABLE[^;]*shift_resident_assignments/i.test(text)) {
        expect(text, f).toMatch(/ON\s+(public\.)?care_recipients/i);
        expect(text, f).toMatch(/location_id/);
      }
    }
  });
  it("la ruta genérica de turnos no acepta la habitación técnica", () => {
    expect(read("src/modules/scheduling/scheduling.service.ts")).toContain("AND NOT app_is_technical_room(id)");
  });
  it("la reversión se niega con datos de personas", () => {
    expect(rollback).toMatch(/ROLLBACK_171_REFUSED/);
    for (const t of ["room_profiles", "establishment_settings_events", "care_recipient_room_events", "establishment_closures"]) expect(rollback).toContain(`EXISTS (SELECT 1 FROM ${t})`);
  });
  it("el servicio excluye las piezas técnicas en cada consulta de unidades y habitaciones", () => {
    const unitQueries = service.match(/FROM units u[^`]*/g) ?? [];
    const roomQueries = service.match(/FROM rooms r[^`]*/g) ?? [];
    expect(unitQueries.length).toBeGreaterThan(0);
    for (const q of unitQueries) expect(q).toMatch(/NOT_TECH_UNIT|NOT_TECH_ROOM|WHERE r\.id = \$\{roomId\}|WHERE r\.id = \$\{input\.roomId\}/);
    for (const q of roomQueries) expect(q).toMatch(/NOT_TECH_ROOM|incluye la habitación técnica: sus turnos también bloquean el cierre|WHERE r\.id = \$\{roomId\}|WHERE r\.id = \$\{input\.roomId\}/);
  });
  it("las rutas de F1 están bajo /residential (residentialGate) y registradas en la app", () => {
    for (const p of ["/establishments", `/establishments/${ID}/rooms`, `/units/${ID}`, `/rooms/${ID}`, `/residents/${ID}/placement`, `/establishments/${ID}/close`])
      expect(residentialRouteFor(`/organizations/${ID}${"/residential"}${p}`)?.kind).toBe("residential");
    expect(app).toContain("app.use(residentialRoutes);app.use(residentialEstablishmentRoutes);");
  });
  it("validación de entradas: nombres reservados, camas 1–20, radio 50–300 m, motivo y centro completo", () => {
    expect(createUnitSchema.safeParse({ name: "__etnara_technical__" }).success).toBe(false);
    expect(createRoomSchema.safeParse({ name: "101", bedCapacity: 0 }).success).toBe(false);
    expect(createRoomSchema.safeParse({ name: "101", bedCapacity: 25 }).success).toBe(true); // sin tope de negocio
    expect(mig).toMatch(/bed_capacity\s+integer NULL CHECK \(bed_capacity >= 1\)/);
    expect(updateRoomSchema.safeParse({ bedCapacity: null }).success).toBe(true);
    expect(geofenceSchema.safeParse({ radiusMeters: 49, reason: "abc" }).success).toBe(false);
    expect(geofenceSchema.safeParse({ radiusMeters: 301, reason: "abc" }).success).toBe(false);
    expect(geofenceSchema.safeParse({ radiusMeters: 100 }).success).toBe(false);
    expect(geofenceSchema.safeParse({ radiusMeters: 100, latitude: 18.4, reason: "abc" }).success).toBe(false);
    expect(geofenceSchema.safeParse({ radiusMeters: 100, latitude: 18.4, longitude: -66.1, reason: "abc" }).success).toBe(true);
    expect(placementSchema.safeParse({ roomId: null }).success).toBe(true);
  });
  it("errores de la base: códigos RESIDENTIAL_* a 409 (404/403 cuando corresponde); el resto no se expone", () => {
    expect(residentialDbErrorCode({ code: "P0001", message: "RESIDENTIAL_NAME_TAKEN" })).toBe("RESIDENTIAL_NAME_TAKEN");
    expect(residentialDbErrorCode({ code: "P0001", message: "otra cosa" })).toBeNull();
    expect(residentialDbErrorCode({ code: "23505", message: "RESIDENTIAL_NAME_TAKEN" })).toBeNull();
    expect(residentialDbErrorStatus("RESIDENTIAL_NOT_FOUND")).toBe(404);
    expect(residentialDbErrorStatus("RESIDENTIAL_MANAGER_REQUIRED")).toBe(403);
    expect(residentialDbErrorStatus("RESIDENTIAL_CLOSURE_FUTURE_SHIFTS")).toBe(409);
  });
  it("la convención está documentada para personas y agentes", () => {
    expect(doc).toMatch(/no es una habitación/i);
    expect(agents).toContain("docs/RESIDENTIAL_TECHNICAL_ROOM.md");
  });
});
