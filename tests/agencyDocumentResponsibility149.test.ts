import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const migration = read("migrations/149_agency_document_responsibility.sql");
const sqlOnly = migration.replace(/--.*$/gm, "");
const rollback = read("ops/149_agency_document_responsibility.rollback.sql");
const service = read("src/modules/credentialing/credentialing.service.ts");

// Decisión 5-nov-2026: la agencia es responsable de su documentación; ETNARA Central no revisa,
// aprueba ni certifica; nadie decide sobre su propia credencial.
describe("149 agency document responsibility", () => {
  it("E: Central loses review/read policies, gets the restrictive deny, review columns become history", () => {
    expect(sqlOnly).toContain("DROP POLICY IF EXISTS establishment_documents_platform_review_read ON establishment_documents;");
    expect(sqlOnly).toContain("DROP POLICY IF EXISTS establishment_documents_platform_review_update ON establishment_documents;");
    expect(sqlOnly).not.toMatch(/CREATE POLICY establishment_documents_platform_review/);
    expect(sqlOnly).toMatch(/CREATE POLICY platform_phi_deny ON establishment_documents AS RESTRICTIVE FOR ALL TO app_runtime\s+USING \(NOT app_is_superadmin\(\)\) WITH CHECK \(NOT app_is_superadmin\(\)\);/);
    expect(sqlOnly).toContain("REVOKE UPDATE ON establishment_documents FROM app_runtime;");
    expect(sqlOnly).toContain("GRANT UPDATE (archived_at, updated_at) ON establishment_documents TO app_runtime;");
    expect(sqlOnly).toContain("ESTABLISHMENT_DOCUMENT_REVIEW_IS_HISTORICAL");
    // No data is rewritten.
    expect(sqlOnly).not.toMatch(/\bUPDATE\s+(establishment_documents|credentials|organization_credential_reviews)\s+SET\b/i);
    expect(sqlOnly).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("B1: only a manager who is not the owner writes credential data; evidence attachment stays open", () => {
    expect(sqlOnly).toMatch(/CREATE TRIGGER credentials_write_guard\s+BEFORE INSERT OR UPDATE OR DELETE ON credentials/);
    expect(sqlOnly).toContain("CREDENTIAL_SELF_MANAGEMENT_FORBIDDEN");
    expect(sqlOnly).toContain("CREDENTIAL_MANAGER_REQUIRED");
    expect(sqlOnly).toMatch(/v_evidence_only := NEW\.worker_id = OLD\.worker_id[\s\S]*NEW\.expires_at IS NOT DISTINCT FROM OLD\.expires_at[\s\S]*NEW\.status = OLD\.status/);
    expect(sqlOnly).toMatch(/IF current_user <> 'app_runtime' AND session_user <> 'app_runtime' THEN/);
    expect(service).toMatch(/await assertWorkerLinkedToOrg\(trx, organizationId, workerId\);\s*await assertCredentialDataManager\(trx, workerId\);\s*const credentialTypeId/);
    expect(service).toMatch(/await assertWorkerLinkedToOrg\(trx, organizationId, workerId\);\s*await assertCredentialDataManager\(trx, workerId\);\s*\/\/ worker_id is deliberately NEVER/);
  });

  it("B2: nobody approves or rejects her own credential, in the service and in the database", () => {
    expect(service).toMatch(/if \(await actorOwnsWorker\(trx, membershipRow\.rows\[0\]\.worker_id\)\) throw new CredentialSelfReviewForbiddenError\(\);/);
    expect(service).toMatch(/AND w\.user_id IS DISTINCT FROM NULLIF\(current_setting\('app\.current_user_id', true\), ''\)::uuid/);
    expect(sqlOnly).toMatch(/CREATE TRIGGER organization_credential_reviews_self_guard\s+BEFORE INSERT OR UPDATE ON organization_credential_reviews/);
    expect(sqlOnly).toMatch(/CREATE TRIGGER organization_document_version_reviews_self_guard\s+BEFORE INSERT ON organization_document_version_reviews/);
    expect(sqlOnly).toMatch(/IF NEW\.review_status::text NOT IN \('approved', 'rejected'\) THEN\s+RETURN NEW;/);
  });

  it("E2: Central reads/writes no credential, review or platform-verification row; the residual summary route queries nothing", () => {
    expect(sqlOnly).toMatch(/FOREACH t IN ARRAY ARRAY\['credentials', 'credential_platform_verifications',\s*'organization_credential_reviews', 'organization_document_version_reviews'\]/);
    expect(sqlOnly).toMatch(/CREATE POLICY platform_phi_deny ON %I AS RESTRICTIVE FOR ALL TO app_runtime\s+USING \(NOT app_is_superadmin\(\)\) WITH CHECK \(NOT app_is_superadmin\(\)\)/);
    const summary = read("src/modules/platformOrganizations/platformOrganizationCredentials.service.ts").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(summary).toContain("withPlatformContext");
    expect(summary).not.toMatch(/\bsql\b|SELECT |FROM /);
    expect(summary).toMatch(/return null;/);
    for (const t of ["credentials", "credential_platform_verifications", "organization_credential_reviews", "organization_document_version_reviews"]) expect(rollback).toContain(`DROP POLICY IF EXISTS platform_phi_deny ON ${t};`);
  });

  it("ships a data-preserving rollback that restores 125", () => {
    for (const piece of ["DROP TRIGGER IF EXISTS credentials_write_guard ON credentials;", "DROP POLICY IF EXISTS platform_phi_deny ON establishment_documents;",
      "CREATE POLICY establishment_documents_platform_review_read", "CREATE POLICY establishment_documents_platform_review_update",
      "ESTABLISHMENT_DOCUMENT_REVIEW_IS_PLATFORM_ONLY", "DELETE FROM schema_migrations WHERE filename = '149_agency_document_responsibility.sql';"]) {
      expect(rollback).toContain(piece);
    }
    expect(rollback.replace(/--.*$/gm, "")).not.toMatch(/\bUPDATE\s+(establishment_documents|credentials|organization_credential_reviews)\s+SET\b/i);
  });
});
