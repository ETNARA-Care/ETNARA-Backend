import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const migration = read("migrations/154_operational_pending_resolution.sql");
const sqlOnly = migration.replace(/--.*$/gm, "");
const rollback = read("ops/154_operational_pending_resolution.rollback.sql");
const operations = read("src/modules/operations/operations.service.ts");
const closures = read("src/modules/scheduling/shiftClosures.service.ts");
const incidents = read("src/modules/incidents/incidents.service.ts");
const drafts = read("src/modules/billing/drafts.service.ts");
const ci = read(".github/workflows/etnara-ci.yml");
const guard107 = read("migrations/107_security_audit_hardening.sql");

// Decisión 11-nov-2026: las alertas de «Requiere atención» solo desaparecen cuando el problema se
// resuelve de verdad; cerrar nunca es borrar; un turno no cubierto nunca cuenta como servicio.
describe("154 operations center pending resolution", () => {
  it("is additive: no existing row rewritten or deleted, no existing table dropped", () => {
    expect(sqlOnly).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sqlOnly).not.toMatch(/\bUPDATE\s+(shifts|incidents|assignments|verification_events|timesheets|audit_log)\s+SET\b/i);
    expect(sqlOnly).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(sqlOnly).not.toMatch(/\bALTER\s+TYPE\b/i);
    expect(sqlOnly).toMatch(/INSERT INTO operational_pending_activation \(singleton\) VALUES \(true\) ON CONFLICT \(singleton\) DO NOTHING;/);
  });

  it("closures: immutable, one per shift, written only by the audited definer function", () => {
    expect(sqlOnly).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS shift_attention_closures_one_active\s+ON shift_attention_closures \(shift_id\) WHERE rectified_at IS NULL;/);
    expect(sqlOnly).toMatch(/CREATE TRIGGER shift_attention_closures_guard BEFORE UPDATE OR DELETE ON shift_attention_closures/);
    expect(sqlOnly).toMatch(/GRANT SELECT ON shift_attention_closures TO app_runtime;/);
    expect(sqlOnly).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON shift_attention_closures/);
    for (const code of ["SHIFT_CLOSURE_NOT_ENDED", "SHIFT_CLOSURE_HAS_CHECK_IN", "SHIFT_CLOSURE_NOT_CLOSABLE", "SHIFT_CLOSURE_NOTE_REQUIRED", "SHIFT_CLOSURE_REASON_INVALID"]) {
      expect(sqlOnly).toContain(code);
    }
    expect(sqlOnly).toMatch(/'SHIFT_CLOSED_WITHOUT_SERVICE', 'shift'/);
    expect(sqlOnly).toMatch(/CREATE POLICY platform_phi_deny ON shift_attention_closures AS RESTRICTIVE/);
    // A closure never creates evidence of service.
    expect(closures).not.toMatch(/closeShiftWithoutService[\s\S]{0,800}INSERT INTO (verification_events|timesheets)/);
  });

  it("rectification: the original closure is never deleted or edited; only who/when/why is added once, by an admin", () => {
    expect(sqlOnly).toMatch(/IF TG_OP = 'DELETE' THEN\s+RAISE EXCEPTION 'SHIFT_CLOSURE_IMMUTABLE'/);
    expect(sqlOnly).toMatch(/IF OLD\.rectified_at IS NOT NULL[\s\S]*NEW\.note IS DISTINCT FROM OLD\.note[\s\S]*NEW\.rectified_at IS NULL THEN\s+RAISE EXCEPTION 'SHIFT_CLOSURE_IMMUTABLE'/);
    expect(sqlOnly).toMatch(/CREATE OR REPLACE FUNCTION app_rectify_shift_closure\(p_closure_id uuid, p_reason text\)/);
    expect(sqlOnly).toMatch(/NOT app_is_org_admin\(\) THEN\s+RAISE EXCEPTION 'SHIFT_CLOSURE_RECTIFY_FORBIDDEN'/);
    expect(sqlOnly).toMatch(/'SHIFT_CLOSURE_RECTIFIED', 'shift'/);
    expect(sqlOnly).not.toMatch(/GRANT[^;]*UPDATE[^;]*ON shift_attention_closures/);
    // Every consumer ignores rectified closures.
    expect(operations).toMatch(/c\.shift_id = s\.id AND c\.rectified_at IS NULL/);
    expect(drafts).toMatch(/sc\.rectified_at IS NULL\) AS closed_without_service/);
    expect(closures).toMatch(/rectifyShiftClosure/);
    expect(closures).not.toMatch(/DELETE FROM shift_attention_closures/);
  });

  it("evidence of service: the 107 guard is kept verbatim plus the check-in rule", () => {
    expect(sqlOnly).toMatch(/IF NEW\.status IN \('in_progress', 'completed'\) AND NOT public\.app_shift_has_check_in\(OLD\.id\) THEN\s+RAISE EXCEPTION 'SHIFT_STATUS_REQUIRES_CHECK_IN'/);
    for (const code of ["SHIFT_STATUS_CANCELLED_IS_FINAL", "SHIFT_STATUS_COMPLETED_IS_FINAL", "SHIFT_FIELDS_LOCKED", "SHIFT_SCHEDULE_LOCKED"]) {
      expect(sqlOnly).toContain(code);
    }
    const start = guard107.indexOf("CREATE OR REPLACE FUNCTION app_shift_update_guard()");
    const body107 = guard107.slice(start, guard107.indexOf("$$;", start) + 3);
    expect(rollback).toContain(body107);
  });

  it("omitted check-in correction: labelled overrides at the real time, reason, pending hours, audited", () => {
    expect(closures).toMatch(/SUPERVISOR_OVERRIDE/);
    expect(closures).toMatch(/'omitted_visit_correction', clock_timestamp\(\)/);
    expect(closures).toMatch(/INSERT INTO verification_overrides/);
    expect(closures).toMatch(/NO_ACCEPTED_ASSIGNMENT/);
    expect(closures).toMatch(/SHIFT_CLOSED_WITHOUT_SERVICE/);
    expect(closures).not.toMatch(/approved_minutes|status = 'approved'/);
    expect(sqlOnly).toMatch(/CREATE TRIGGER verification_overrides_audit AFTER INSERT ON verification_overrides/);
  });

  it("incidents: attributed, final, immutable story, never deleted; serious need follow-up and an authorized closer", () => {
    expect(sqlOnly).toMatch(/CREATE TRIGGER incidents_guard BEFORE INSERT OR UPDATE OR DELETE ON incidents/);
    for (const code of ["INCIDENT_NOT_DELETABLE", "INCIDENT_RESOLVED_IS_FINAL", "INCIDENT_RECORD_IMMUTABLE", "INCIDENT_SERIOUS_CLOSER_REQUIRED",
      "INCIDENT_SERIOUS_FOLLOW_UP_REQUIRED", "INCIDENT_RESOLUTION_TOO_SHORT", "INCIDENT_RESOLUTION_UNATTRIBUTED", "INCIDENT_STATUS_FORBIDDEN"]) {
      expect(sqlOnly).toContain(code);
    }
    expect(sqlOnly).toMatch(/r\.code = 'ORGANIZATION_ADMIN'\s+OR \(r\.code = 'SUPERVISOR' AND EXISTS \(\s+SELECT 1 FROM public\.incident_closure_authorizers g/);
    expect(sqlOnly).toMatch(/CREATE TRIGGER incidents_status_audit AFTER UPDATE OF status ON incidents/);
    expect(incidents).toMatch(/resolved_by_user_id = \$\{resolving \? userId : null\}/);
    expect(incidents).not.toMatch(/DELETE FROM incidents/);
  });

  it("operations center: closures leave the list; activation cutoff instead of silent expiry", () => {
    expect(operations).toMatch(/NOT EXISTS \(SELECT 1 FROM shift_attention_closures c WHERE c\.shift_id = s\.id AND c\.rectified_at IS NULL\)/);
    expect(operations).toMatch(/s\.scheduled_end >= \(SELECT activated_at FROM operational_pending_activation\)/);
    expect(operations).toMatch(/s\.scheduled_end > now\(\) - interval '7 days'/);
    expect(operations).toMatch(/app_incident_is_serious\(i\.severity\) AS serious/);
  });

  it("billing never bills a shift closed without service automatically", () => {
    expect(drafts).toMatch(/if \(row\.closed_without_service\) exceptions\.push\("SHIFT_CLOSED_WITHOUT_SERVICE"\);/);
  });

  it("rollback refuses when 154 already holds data; CI runs the verification and the rollback", () => {
    expect(rollback).toMatch(/ROLLBACK_154_REFUSED_DATA_PRESENT/);
    expect(ci).toContain("npx tsx scripts/verifyMigrationRollback.ts 154");
    expect(ci.match(/verifyOperationalPendingResolution\.ts/g)?.length).toBe(2);
  });
});
