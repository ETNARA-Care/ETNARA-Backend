import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const strip = (s: string) => s.replace(/--[^\n]*/g, "");
const m106 = strip(read("migrations/106_shift_journey.sql"));
const journey = read("src/modules/verification/verification.journey.ts");
const family = read("src/modules/scheduling/scheduling.service.ts");

describe("Gate 7 «En Camino»: data model (migration 106)", () => {
  it("stores declarations only: no coordinates, no routes, no estimated times", () => {
    const table = /CREATE TABLE IF NOT EXISTS shift_journey_events \(([\s\S]*?)\n\);/.exec(m106)?.[1] ?? "";
    const columns = table.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((c) => /^[a-z_]+$/.test(c));
    expect(columns.length).toBeGreaterThan(8);
    for (const c of columns) expect(c).not.toMatch(/lat|lng|lon|route|position|eta|estimated/);
    expect(table).toContain("event_type IN ('EN_ROUTE', 'DELAY_REPORTED')");
    expect(table).toContain("declared_delay_minutes IN (10, 15, 30, 45, 60)");
    expect(table).toContain("delay_reason IN ('TRAFFIC', 'PREVIOUS_SERVICE', 'TRANSPORT', 'WEATHER', 'OTHER')");
  });
  it("is append-only, isolated per agency and closed to ETNARA central / Tower", () => {
    expect(m106).toContain("BEFORE UPDATE OR DELETE ON shift_journey_events");
    expect(m106).toContain("ALTER TABLE shift_journey_events FORCE ROW LEVEL SECURITY");
    expect(m106).toMatch(/CREATE POLICY platform_phi_deny ON shift_journey_events\s+AS RESTRICTIVE/);
    expect(m106).not.toMatch(/GRANT (UPDATE|DELETE)[^;]*ON shift_journey_events/);
  });
  it("the database enforces the window, the accepted assignment and «before arrival»", () => {
    expect(m106).toContain("s.scheduled_start - interval '2 hours'");
    expect(m106).toContain("s.scheduled_start + interval '1 hour'");
    expect(m106).toContain("a.response_status = 'accepted'");
    expect(m106).toContain("JOURNEY_ALREADY_ARRIVED");
    expect(m106).toContain("IF s.status <> 'confirmed'");
  });
  it("the state is derived, so «En camino» stops on arrival, start, finish or cancellation", () => {
    expect(m106).toMatch(/WHEN s\.status = 'cancelled' THEN 'CANCELLED'[\s\S]*WHEN arrived_at IS NOT NULL THEN 'ARRIVED'[\s\S]*WHEN en_route_at IS NOT NULL THEN 'EN_ROUTE'/);
    expect(m106).toMatch(/IF NOT is_manager AND NOT EXISTS[\s\S]*?arrival_needs_review := NULL;/);
  });
  it("family notices: deduplicated, only accepted assignments, never for a cancelled shift", () => {
    expect(m106).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_journey_once");
    expect(m106).toMatch(/app_notify_shift_family[\s\S]*s\.status <> 'cancelled'[\s\S]*fr\.can_receive_notifications[\s\S]*a\.response_status = 'accepted'/);
    for (const t of ["FAMILY_CAREGIVER_EN_ROUTE", "FAMILY_CAREGIVER_DELAYED", "FAMILY_CAREGIVER_ARRIVED"]) expect(m106).toContain(t);
    // start / finish reuse the existing SHIFT_STARTED / SHIFT_COMPLETED notices (no duplicates)
    expect(m106).not.toMatch(/FAMILY_SERVICE_(STARTED|COMPLETED)/);
  });
  it("agency alerts: preventive «sin salida» 30 min before, delay >= 30, both resolved by later events", () => {
    expect(m106).toContain("s.scheduled_start <= now() + interval '30 minutes'");
    expect(m106).toContain("IF NEW.declared_delay_minutes >= 30 THEN");
    expect(m106.match(/notification_type = 'SHIFT_NOT_EN_ROUTE' AND organization_id = NEW\.organization_id AND read_at IS NULL/g)?.length).toBe(3);
  });
});

describe("Gate 7 «En Camino»: API", () => {
  it("strict payloads: fixed minutes, reason categories, no free text", () => {
    expect(journey).toMatch(/delaySchema = z\.object\(\{[\s\S]*\}\)\.strict\(\)/);
    expect(journey).not.toMatch(/note: z\.|message: z\./);
  });
  it("the family view never includes the review flag", () => {
    expect(family).toContain("toJourney(st, false)");
    expect(journey).toContain("...(includeReview ? { arrivalNeedsReview: Boolean(r.arrival_needs_review) } : {})");
  });
});

describe("Gate 7: «Servicio finalizado» reaches the family (existing notice fixed)", () => {
  it("SHIFT_COMPLETED is sent before the shift becomes completed (076 hides completed shifts from the caregiver)", () => {
    const v = read("src/modules/verification/verification.service.ts");
    const notifyAt = v.indexOf('await notifyShiftStatus(trx, userId, organizationId, shiftId, "SHIFT_COMPLETED")');
    const completeAt = v.indexOf("UPDATE shifts SET status = 'completed'");
    expect(notifyAt).toBeGreaterThan(0);
    expect(notifyAt).toBeLessThan(completeAt);
  });
});
