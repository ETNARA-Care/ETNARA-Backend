import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classifyProximity, distanceMeters, ARRIVAL_RADIUS_M } from "../src/modules/verification/verification.proximity.js";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const strip = (s: string) => s.replace(/--[^\n]*/g, "");
const m100 = strip(read("migrations/100_service_locations.sql"));
const m101 = strip(read("migrations/101_arrival_verification.sql"));
const m102 = strip(read("migrations/102_smartmatch_filled_cancellation.sql"));
const arrival = read("src/modules/verification/verification.arrival.ts");
const verification = read("src/modules/verification/verification.service.ts");

// Static guardrails + pure logic. Behavior: scripts/verifyGate6ServiceLocations.ts (70 HTTP + RLS checks).
describe("Gate 6: service locations", () => {
  it("extends care_recipient_locations (084) instead of a parallel module", () => {
    expect(m100).toMatch(/ALTER TABLE care_recipient_locations ADD COLUMN IF NOT EXISTS id uuid/);
    expect(m100).not.toMatch(/CREATE TABLE IF NOT EXISTS care_recipient_locations\b/);
    expect(m100).toMatch(/care_recipient_locations_one_primary[\s\S]*WHERE is_primary AND archived_at IS NULL/);
    expect(m100).toContain("care_recipient_locations_establishment_no_copy");
  });
  it("workers read only the address of a shift they are assigned to now; family only with permission", () => {
    expect(m100).toMatch(/app_worker_can_read_service_location\(id, care_recipient_id, is_primary, archived_at\)/);
    expect(m100).toMatch(/AND public\.app_worker_has_shift_assignment\(s\.id\)/);
    expect(m100).toMatch(/can_view_service_location boolean NOT NULL DEFAULT false/);
    expect(m100).toContain("FAMILY_LOCATION_PERMISSION_MANAGER_ONLY");
  });
  it("every new table is FORCE RLS with the platform PHI deny", () => {
    for (const t of ["care_recipient_location_events", "care_recipient_location_access_log", "care_recipient_location_change_requests", "shift_service_location_changes"]) {
      expect(m100).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      expect(m100).toMatch(new RegExp(`CREATE POLICY platform_phi_deny ON ${t}\\s+AS RESTRICTIVE`));
    }
    for (const t of ["worker_location_consents", "shift_arrivals"]) {
      expect(m101).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      expect(m101).toMatch(new RegExp(`CREATE POLICY platform_phi_deny ON ${t}\\s+AS RESTRICTIVE`));
    }
  });
  it("notifications never carry the address and do not widen the notifications INSERT policy", () => {
    expect(m100 + m101).not.toMatch(/CREATE POLICY [a-z_]+ ON notifications/);
    expect(m101).toMatch(/'SHIFT_LATE_ARRIVAL'[\s\S]*NULL::uuid/);
  });
});

describe("Gate 6: arrival and proximity", () => {
  it("never stores coordinates: no columns, check-in ignores them", () => {
    const table = m101.slice(m101.indexOf("CREATE TABLE IF NOT EXISTS shift_arrivals"), m101.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS shift_arrivals_client_event"));
    expect(table).not.toMatch(/latitude|longitude|_lat\b|_lng\b/);
    expect(verification).toContain("'check_in', ${userId}, ${input.actorContext ?? null}, null, null,");
    expect(arrival).toContain("if (hasReading && !consent) throw new LocationConsentRequiredError();");
  });
  it("classifies one reading with a 200 m radius and rounds to 10 m", () => {
    expect(ARRIVAL_RADIUS_M).toBe(200);
    expect(classifyProximity(199, 0)).toEqual({ proximity: "NEAR", distanceM: 200 });
    expect(classifyProximity(250, 60).proximity).toBe("NEAR");
    expect(classifyProximity(350, 5000).proximity).toBe("FAR");
    const d = distanceMeters({ lat: 18.2341, lng: -66.0485 }, { lat: 18.11, lng: -66.166 });
    expect(d).toBeGreaterThan(18_000);
    expect(d).toBeLessThan(19_000);
  });
  it("no consent / no GPS / far is recorded and reviewed, never blocking", () => {
    expect(m101).toContain("CHECK (needs_review = (proximity IN ('FAR','NO_CONSENT','UNAVAILABLE')))");
    expect(verification).not.toMatch(/shift_arrivals[\s\S]{0,200}throw/);
  });
});

describe("Gate 6: cancelling a FILLED opportunity", () => {
  it("needs a reason, is blocked by an active linked shift and never reopens", () => {
    expect(m102).toContain("(OLD.status = 'FILLED'    AND NEW.status = 'CANCELLED')");
    expect(m102).toContain("SMARTMATCH_CANCELLATION_REASON_REQUIRED");
    expect(m102).toContain("SMARTMATCH_LINKED_SHIFT_ACTIVE");
    expect(m102).not.toMatch(/OLD\.status = 'FILLED'\s+AND NEW\.status IN \([^)]*PUBLISHED/);
    expect(m102).not.toMatch(/UPDATE (public\.)?shifts/);
  });
});

describe("Gate 6 fixes: address verified vs GPS confirmed (migration 103)", () => {
  const m103 = strip(read("migrations/103_service_location_gps_confirmation.sql"));
  const service = read("src/modules/careRecipients/serviceLocations.service.ts");
  it("GPS confirmation is its own state, needs coordinates, and records who/when", () => {
    expect(m103).toContain("gps_confirmed_at timestamptz NULL");
    expect(m103).toContain("CHECK (gps_confirmed_at IS NULL OR (latitude IS NOT NULL AND longitude IS NOT NULL))");
    expect(m103).toContain("CHECK ((gps_confirmed_at IS NULL) = (gps_confirmed_by_user_id IS NULL))");
    expect(m103).toMatch(/'GPS_CONFIRMED','GPS_CHANGED'/);
  });
  it("moving the marker clears only the GPS confirmation; editing the text clears only the verification", () => {
    expect(m103).toMatch(/\(NEW\.latitude, NEW\.longitude\) IS DISTINCT FROM \(OLD\.latitude, OLD\.longitude\)[\s\S]*NEW\.gps_confirmed_at := NULL/);
    expect(m103).toMatch(/\(NEW\.address_line, NEW\.municipality, NEW\.postal_code, NEW\.establishment_id\)[\s\S]*NEW\.verified_at := NULL/);
  });
  it("confirmation is explicit and caregivers only receive confirmed coordinates", () => {
    expect(service).toMatch(/confirm: z\.literal\(true\)/);
    expect(service).toContain("latitude: v.gpsConfirmedAt ? v.latitude : null");
    expect(read("src/modules/verification/verification.arrival.ts")).toContain("AND gps_confirmed_at IS NOT NULL");
  });
});

describe("Gate 6 close: family relationship write authority (migration 104)", () => {
  const m104 = strip(read("migrations/104_family_relationship_write_authority.sql"));
  const family = read("src/modules/family/family.service.ts");
  it("replaces the FOR ALL policy: reads unchanged, writes only for managers", () => {
    expect(m104).toContain("DROP POLICY IF EXISTS family_relationships_own_or_staff ON family_relationships");
    expect(m104).toMatch(/CREATE POLICY family_relationships_read ON family_relationships\s+FOR SELECT/);
    expect(m104).toMatch(/family_relationships_manager_update ON family_relationships\s+FOR UPDATE\s+USING [^;]*app_is_org_manager\(\)\)\s+WITH CHECK [^;]*app_is_org_manager\(\)\);/);
    expect(m104).toMatch(/family_relationships_manager_delete ON family_relationships\s+FOR DELETE/);
    expect(m104).not.toMatch(/CREATE POLICY family_relationships_\w+ ON family_relationships\s+(AS PERMISSIVE\s+)?FOR ALL/);
  });
  it("a relative self-inserts only from their own valid invitation with default permissions", () => {
    expect(m104).toContain("AND can_participate_in_verification = false");
    expect(m104).toContain("AND can_view_service_location = false");
    expect(m104).toContain("AND is_primary_contact = false");
    expect(m104).toMatch(/app_family_invitation_allows_self_insert\(invitation_id, organization_id, care_recipient_id,/);
    expect(m104).toContain("AND i.status::text = 'pending'");
    expect(m104).toContain("AND i.expires_at > now()");
    expect(m104).toContain("FAMILY_RELATIONSHIP_SUBJECT_IMMUTABLE");
  });
  it("the HTTP revoke route requires an agency manager", () => {
    expect(family).toMatch(/revokeFamilyRelationship[\s\S]*SELECT app_is_org_manager\(\) AS ok[\s\S]*throw new FamilyManagerOnlyError\(\)/);
  });
});

describe("Gate 6 close: a new place invalidates the GPS point; approvals never move shifts silently (105)", () => {
  const m105 = strip(read("migrations/105_service_location_street_change_clears_gps.sql"));
  const service = read("src/modules/careRecipients/serviceLocations.service.ts");
  it("street / municipality / establishment change clears the GPS confirmation; ZIP alone does not", () => {
    expect(m105).toMatch(/\(NEW\.address_line, NEW\.municipality, NEW\.establishment_id\)\s+IS DISTINCT FROM \(OLD\.address_line, OLD\.municipality, OLD\.establishment_id\)[\s\S]*NEW\.gps_confirmed_at := NULL/);
    expect(m105).not.toMatch(/\(NEW\.address_line, NEW\.municipality, NEW\.postal_code, NEW\.establishment_id\)[^;]*\n[^;]*NEW\.gps_confirmed_at := NULL/);
  });
  it("approving a correction used by upcoming shifts needs explicit confirmation and notifies caregivers", () => {
    expect(service).toContain("confirmUpcomingShifts: z.literal(true).optional()");
    expect(service).toContain('throw new LocationConflictError("UPCOMING_SHIFTS_NEED_CONFIRMATION")');
    expect(service).toMatch(/affectedShiftIds\.length > 0\) await sql`SELECT app_notify_shift_location_changed/);
  });
});
