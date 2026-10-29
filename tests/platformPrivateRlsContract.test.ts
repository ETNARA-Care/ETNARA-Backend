import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");

describe("platform administration private-record isolation contract", () => {
  it("does not grant platform superadmins unrestricted recipient SELECT access", () => {
    const sql = migration("018_rls_hardening.sql");
    const policy = sql.match(/CREATE POLICY care_recipients_admin_supervisor_full_tenant ON care_recipients[\s\S]*?;/)?.[0] ?? "";
    expect(policy).not.toMatch(/OR\s+app_is_superadmin\s*\(\s*\)/i);
  });
  it("does not grant platform superadmins private care-event access", () => {
    const sql = migration("018_rls_hardening.sql");
    const policy = sql.match(/CREATE POLICY care_events_admin_supervisor_full_tenant ON care_events[\s\S]*?;/)?.[0] ?? "";
    expect(policy).not.toMatch(/OR\s+app_is_superadmin\s*\(\s*\)/i);
  });
  it("does not allow superadmin access to resident document policies", () => {
    const sql = migration("066_resident_documents.sql");
    expect(sql).not.toMatch(/app_is_superadmin\s*\(\s*\)/i);
  });
});
