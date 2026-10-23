import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const m088 = read("migrations/088_production_security_hotfix.sql").replace(/--[^\n]*/g, "");

describe("Production security hotfix (migration 088 + code)", () => {
  it("only narrows access: no data statements", () => {
    expect(m088).not.toMatch(/\b(INSERT INTO|DELETE FROM|TRUNCATE|DROP TABLE|ALTER TABLE)\b/i);
    expect(m088).not.toMatch(/^\s*UPDATE\s+\w+\s+SET/im);
  });
  it("users: no writes on other people's rows; API role can only change password_hash", () => {
    expect(m088).toContain("DROP POLICY IF EXISTS users_self_or_shared_org ON users");
    expect(m088).toMatch(/CREATE POLICY users_update_self ON users\s+FOR UPDATE[\s\S]*?WITH CHECK/);
    expect(m088).toContain("REVOKE INSERT, DELETE ON users FROM app_runtime");
    expect(m088).toContain("GRANT UPDATE (password_hash, updated_at) ON users TO app_runtime");
  });
  it("shifts: caregivers read and change status only; cancelled is final", () => {
    expect(m088).toContain("DROP POLICY IF EXISTS shifts_worker_assigned_only ON shifts");
    expect(m088).toMatch(/CREATE POLICY shifts_worker_assigned_status ON shifts\s+FOR UPDATE[\s\S]*?WITH CHECK/);
    expect(m088).toContain("SHIFT_STATUS_CANCELLED_IS_FINAL");
    expect(m088).toContain("SHIFT_FIELDS_LOCKED");
    expect(read("src/modules/scheduling/scheduling.service.ts")).toMatch(/updateShift[\s\S]*?ShiftUpdateForbiddenError/);
  });
  it("family relationships: scoped reads, manager-only writes, immutable subject", () => {
    expect(m088).toContain("DROP POLICY IF EXISTS family_relationships_own_or_staff ON family_relationships");
    expect(m088).toMatch(/family_relationships_read[\s\S]*app_user_authorized_for_recipient/);
    expect(m088).toMatch(/family_relationships_insert[\s\S]*?WITH CHECK \(organization_id = [^;]*app_is_org_manager\(\)\);/);
    expect(m088).toContain("FAMILY_RELATIONSHIP_SUBJECT_IMMUTABLE");
    expect(read("src/modules/family/family.service.ts")).toMatch(/revokeFamilyRelationship[\s\S]*?FamilyManagerOnlyError/);
  });
  it("Tower: restrictive deny on notifications (own only)", () => {
    expect(m088).toMatch(/CREATE POLICY platform_phi_deny ON notifications\s+AS RESTRICTIVE/);
  });
  it("is independent of SmartMatch", () => {
    expect(m088).not.toMatch(/smartmatch|service_location|shift_journey/i);
  });
});
