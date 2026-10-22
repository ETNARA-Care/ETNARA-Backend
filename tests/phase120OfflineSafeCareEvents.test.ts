import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const service = read("src/modules/careEvents/careEvents.service.ts");
const routes = read("src/modules/careEvents/careEvents.routes.ts");
const migration080 = read("migrations/083_care_event_client_ids.sql");
const migration081 = read("migrations/081_fix_shift_assignment_rls_recursion.sql");
const ci = read(".github/workflows/etnara-ci.yml");

describe("Phase 12.0 offline-safe care events", () => {
  it("adds an optional client id with a tenant- and worker-scoped partial unique index", () => {
    expect(migration080).toContain("ADD COLUMN IF NOT EXISTS client_event_id uuid NULL");
    expect(migration080).toContain("(organization_id, organization_worker_membership_id, client_event_id)");
    expect(migration080).toContain("WHERE client_event_id IS NOT NULL");
    expect(migration080).not.toMatch(/DROP|POLICY|DISABLE ROW LEVEL SECURITY/i);
  });

  it("accepts clientEventId and occurredAt as optional validated fields", () => {
    expect(service).toContain("clientEventId: z.string().uuid().optional()");
    expect(service).toContain("occurredAt: z.string().datetime({ offset: true }).optional()");
  });

  it("answers a replay before the active-visit guard and before inserting", () => {
    const replayIndex = service.indexOf("findByClientEventId(trx, organizationId, membership.id, input.clientEventId)");
    const guardIndex = service.indexOf("const checkInAt = await assertActiveVisit");
    const insertIndex = service.indexOf("INSERT INTO care_events");
    expect(replayIndex).toBeGreaterThan(-1);
    expect(replayIndex).toBeLessThan(guardIndex);
    expect(guardIndex).toBeLessThan(insertIndex);
  });

  it("stays safe under concurrent retries and never notifies twice", () => {
    expect(service).toContain("ON CONFLICT (organization_id, organization_worker_membership_id, client_event_id)");
    expect(service).toContain("DO NOTHING");
    const conflictReturn = service.indexOf("return { event: replayOrConflict(existing, shiftId, input), replayed: true };", service.indexOf("DO NOTHING"));
    const notificationInsert = service.indexOf("INSERT INTO notifications");
    expect(conflictReturn).toBeGreaterThan(-1);
    expect(conflictReturn).toBeLessThan(notificationInsert);
  });

  it("bounds occurredAt to the active visit and a small clock skew", () => {
    expect(service).toContain("if (occurred < new Date(checkInAt).getTime()) throw new OccurredAtOutOfRangeError();");
    expect(service).toContain("if (occurred > Date.now() + MAX_CLOCK_SKEW_MS) throw new OccurredAtOutOfRangeError();");
    expect(service).toContain("COALESCE(${occurredAt}::timestamptz, now())");
  });

  it("rejects reusing a client id for a different record", () => {
    expect(service).toContain("existing.shift_id !== shiftId");
    expect(service).toContain("existing.care_recipient_id !== input.careRecipientId");
    expect(service).toContain("existing.type_code !== input.typeCode");
  });

  it("maps outcomes to explicit HTTP statuses", () => {
    expect(routes).toContain("res.status(replayed ? 200 : 201).json({ event, replayed })");
    expect(routes).toContain('res.status(400).json({ error: "OCCURRED_AT_OUT_OF_RANGE" })');
    expect(routes).toContain('res.status(409).json({ error: "CLIENT_EVENT_ID_CONFLICT" })');
  });

  it("fixes the shift-assignment RLS recursion with a narrow SECURITY DEFINER helper", () => {
    expect(migration081).toContain("SECURITY DEFINER");
    expect(migration081).toContain("SET search_path = pg_catalog, public");
    expect(migration081).toContain("NULLIF(current_setting('app.current_org_id', true), '')::uuid");
    expect(migration081).toContain("REVOKE ALL ON FUNCTION public.app_worker_has_shift_assignment(uuid) FROM PUBLIC");
    expect(migration081).not.toMatch(/BYPASSRLS|DISABLE ROW LEVEL SECURITY|DROP POLICY/i);
  });

  it("runs the PostgreSQL verification in CI", () => {
    expect(ci).toContain("scripts/verifyCareEventIdempotency.ts");
  });
});
