import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("migrations/125_document_access_fix.sql");
// Comments mention the old setting name on purpose; check only executable SQL.
const sqlOnly = migration.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("migration 125: resident and establishment document access", () => {
  it("grants app_runtime exactly what the services use, never DELETE, and closes PUBLIC", () => {
    expect(sqlOnly).toMatch(/GRANT SELECT, INSERT ON resident_documents TO app_runtime;/);
    expect(sqlOnly).toMatch(/GRANT UPDATE \(archived_at, updated_at\) ON resident_documents TO app_runtime;/);
    expect(sqlOnly).toMatch(/GRANT SELECT, INSERT ON establishment_documents TO app_runtime;/);
    expect(sqlOnly).toMatch(/GRANT UPDATE \(archived_at, updated_at, review_status, reviewed_by_user_id, reviewed_at, review_reason\)\s+ON establishment_documents TO app_runtime;/);
    expect(sqlOnly).toMatch(/REVOKE ALL ON resident_documents FROM PUBLIC;/);
    expect(sqlOnly).toMatch(/REVOKE ALL ON establishment_documents FROM PUBLIC;/);
    expect(sqlOnly).not.toMatch(/GRANT[^;]*DELETE/i);
    expect(sqlOnly).not.toMatch(/GRANT ALL/i);
  });

  it("uses the GUC the backend sets (app.current_org_id), never app.current_organization_id", () => {
    expect(sqlOnly).not.toContain("current_organization_id");
    expect(sqlOnly).toContain("current_setting('app.current_org_id', true)");
    const tenantContext = read("src/context/tenantContext.ts");
    expect(tenantContext).toContain("set_config('app.current_org_id'");
    expect(tenantContext).not.toContain("app.current_organization_id");
  });

  it("qualifies the outer table in every EXISTS (no self-comparison inside the subquery)", () => {
    expect(sqlOnly).toContain("cr.id = resident_documents.care_recipient_id");
    expect(sqlOnly).toContain("cr.organization_id = resident_documents.organization_id");
    expect(sqlOnly).toContain("cr.location_id = resident_documents.establishment_id");
    expect(sqlOnly).toContain("l.organization_id = establishment_documents.organization_id");
    expect(sqlOnly).not.toMatch(/cr\.organization_id\s*=\s*organization_id/);
    expect(sqlOnly).not.toMatch(/cr\.location_id\s*=\s*establishment_id/);
  });

  it("recreates every 066/067 policy idempotently, keeps platform_phi_deny and forces RLS", () => {
    for (const [table, policy] of [
      ["resident_documents", "resident_documents_establishment_read"],
      ["resident_documents", "resident_documents_establishment_insert"],
      ["resident_documents", "resident_documents_establishment_update"],
      ["resident_documents", "platform_phi_deny"],
      ["establishment_documents", "establishment_documents_read"],
      ["establishment_documents", "establishment_documents_insert"],
      ["establishment_documents", "establishment_documents_update"],
      ["establishment_documents", "establishment_documents_platform_review_read"],
      ["establishment_documents", "establishment_documents_platform_review_update"],
    ]) {
      expect(sqlOnly).toContain(`DROP POLICY IF EXISTS ${policy} ON ${table};`);
      expect(sqlOnly).toMatch(new RegExp(`CREATE POLICY ${policy} ON ${table}\\b`));
    }
    expect(sqlOnly).toMatch(/CREATE POLICY platform_phi_deny ON resident_documents AS RESTRICTIVE FOR ALL TO app_runtime\s+USING \(NOT app_is_superadmin\(\)\) WITH CHECK \(NOT app_is_superadmin\(\)\)/);
    expect(sqlOnly).toContain("ALTER TABLE resident_documents FORCE ROW LEVEL SECURITY;");
    expect(sqlOnly).toContain("ALTER TABLE establishment_documents FORCE ROW LEVEL SECURITY;");
    expect(sqlOnly).toContain("DROP TRIGGER IF EXISTS establishment_documents_update_guard ON establishment_documents;");
  });

  it("ships a rollback that restores 066/067 verbatim, revokes the grants and warns it re-breaks the feature", () => {
    expect(existsSync(new URL("../ops/125_document_access_fix.rollback.sql", import.meta.url))).toBe(true);
    const rollback = read("ops/125_document_access_fix.rollback.sql");
    expect(rollback).toMatch(/RE-BREAKS the feature/);
    expect(rollback).toContain("REVOKE ALL ON resident_documents FROM app_runtime;");
    expect(rollback).toContain("REVOKE ALL ON establishment_documents FROM app_runtime;");
    expect(rollback).toContain("DELETE FROM schema_migrations WHERE filename = '125_document_access_fix.sql';");
    // Policies come back exactly as 066/067 wrote them.
    const m066 = read("migrations/066_resident_documents.sql");
    const m067 = read("migrations/067_establishment_documents.sql");
    for (const source of [m066, m067]) {
      for (const stmt of source.match(/CREATE POLICY[\s\S]*?\);/g) ?? []) expect(rollback).toContain(stmt);
    }
    expect(rollback).not.toMatch(/DROP POLICY IF EXISTS platform_phi_deny/);
  });

  it("removes the just-uploaded object when the row is not written, logging no key or file name", () => {
    for (const path of ["src/modules/residentDocuments/residentDocuments.service.ts", "src/modules/establishmentDocuments/establishmentDocuments.service.ts"]) {
      const service = read(path);
      expect(service).toContain("deletePrivateObject");
      expect(service).toMatch(/catch\(err\)\{if\(uploadedKey\)await removeUploadedObject\(uploadedKey\);throw err;\}/);
      expect(service).toMatch(/logInternalError\("[a-z-]+-upload-cleanup",\{name:/);
    }
  });

  it("keeps the orphan audit strictly read-only", () => {
    const audit = read("scripts/auditDocumentOrphans.ts");
    expect(audit).not.toMatch(/DeleteObject|PutObject|CopyObject|deletePrivateObject|DELETE FROM|UPDATE |INSERT INTO/);
    expect(audit).toContain("BEGIN TRANSACTION READ ONLY");
    expect(audit).toContain("AUDIT_READ_ONLY_CONFIRM");
  });
});
