import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const m107 = read("migrations/107_security_audit_hardening.sql").replace(/--[^\n]*/g, "");

describe("Security audit (migration 107 + code)", () => {
  it("users: reads unchanged, writes only on one's own row, no e-mail/creation through the API role", () => {
    expect(m107).toContain("DROP POLICY IF EXISTS users_self_or_shared_org ON users");
    expect(m107).toMatch(/CREATE POLICY users_update_self ON users\s+FOR UPDATE/);
    expect(m107).toContain("REVOKE INSERT, DELETE ON users FROM app_runtime");
    expect(m107).toContain("GRANT UPDATE (password_hash, updated_at) ON users TO app_runtime");
  });
  it("shifts: caregivers read and change status only; cancelled is final; started journeys lock the schedule", () => {
    expect(m107).toContain("DROP POLICY IF EXISTS shifts_worker_assigned_only ON shifts");
    expect(m107).toContain("SHIFT_STATUS_CANCELLED_IS_FINAL");
    expect(m107).toContain("SHIFT_FIELDS_LOCKED");
    expect(m107).toContain("SHIFT_SCHEDULE_LOCKED");
    expect(read("src/modules/scheduling/scheduling.service.ts")).toMatch(/updateShift[\s\S]*?app_is_org_manager\(\) AS is_manager[\s\S]*?ShiftUpdateForbiddenError/);
  });
  it("family relationships: scoped reads, agency-only inserts", () => {
    expect(m107).toMatch(/family_relationships_read[\s\S]*app_user_authorized_for_recipient/);
    expect(m107).toMatch(/family_relationships_insert[\s\S]*?WITH CHECK \(organization_id = [^;]*app_is_org_manager\(\)\);/);
  });
  it("Tower: restrictive deny on notifications (own only) and the four SmartMatch tables", () => {
    expect(m107).toMatch(/CREATE POLICY platform_phi_deny ON notifications\s+AS RESTRICTIVE/);
    expect(m107).toContain("'smartmatch_opportunities', 'smartmatch_applications', 'smartmatch_application_events', 'smartmatch_location_preferences'");
  });
  it("cross-agency jobs refuse a user session; arrivals have a window; history is append-only", () => {
    expect(m107.match(/PERFORM public\.app_assert_background_job\(\);/g)?.length).toBe(2);
    expect(m107).toContain("NEW.occurred_at < s.scheduled_start - interval '2 hours' OR NEW.occurred_at > s.scheduled_end");
    expect(m107).toContain("care_recipient_location_events_append_only");
    expect(m107).toContain("shift_service_location_changes_append_only");
  });
  it("upcoming shifts are pinned to their address; new write routes are rate-limited", () => {
    expect(m107).toContain("CREATE TRIGGER care_recipient_locations_pin_shifts");
    expect(read("src/app.ts")).toContain("app.use(featureWriteLimit);");
  });
});
