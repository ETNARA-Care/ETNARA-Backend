import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("tenant document download boundaries", () => {
  it("never permits platform authority through resident-document tenant routes", () => {
    const service = read("src/modules/residentDocuments/residentDocuments.service.ts");
    expect(service).toContain("withTenantContext");
    expect(service).toContain("app_is_org_manager()");
    expect(service).toContain("app_is_establishment_admin");
    expect(service).not.toContain("app_is_superadmin()");
    expect(service).toContain("care_recipient_id=${recipientId}");
    expect(service).toContain("organization_id=${organizationId}");
    expect(service).toContain("establishment_id=${establishmentId}");
  });

  it("keeps establishment tenant routes membership-scoped with no platform bypass", () => {
    const service = read("src/modules/establishmentDocuments/establishmentDocuments.service.ts");
    const routes = read("src/modules/establishmentDocuments/establishmentDocuments.routes.ts");

    expect(service).toContain("withTenantContext");
    expect(service).toContain("app_is_org_manager()");
    expect(service).toContain("app_is_establishment_admin");
    expect(service).not.toContain("app_is_superadmin()");
    expect(routes).not.toContain("/documents/:documentId/review");
    expect(routes).not.toContain("reviewEstablishmentDocument");
  });

  it("140: ETNARA Central has no standing access to establishment documents (fail-closed)", () => {
    const service = read("src/modules/establishmentDocuments/platformEstablishmentDocuments.service.ts");
    const routes = read("src/modules/establishmentDocuments/platformEstablishmentDocuments.routes.ts");
    const code = service.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // Still a verified platform admin first (others keep their 403)...
    expect(code).toContain("withPlatformContext");
    // ...but no query, no signed URL and no review write.
    expect(code).not.toMatch(/\bsql\b|SELECT |UPDATE |FROM establishment_documents|createPrivateDownloadUrl/);
    expect(code).toContain("throw new PlatformDocumentAccessClosedError()");
    expect((code.match(/throw new PlatformDocumentAccessClosedError\(\)/g) ?? []).length).toBe(2);
    expect(code).toMatch(/listPlatformEstablishmentDocumentQueue[\s\S]*?return \[\];/);
    expect(routes).toContain("PLATFORM_PRIVATE_DOCUMENT_ACCESS_DENIED");

    const migration = read("migrations/140_platform_establishment_document_closure.sql");
    expect(migration).toMatch(/DROP POLICY IF EXISTS establishment_documents_platform_review_read ON establishment_documents;/);
    expect(migration).toMatch(/DROP POLICY IF EXISTS establishment_documents_platform_review_update ON establishment_documents;/);
    expect(migration).toMatch(/CREATE POLICY platform_phi_deny ON establishment_documents AS RESTRICTIVE FOR ALL TO app_runtime\s+USING \(NOT app_is_superadmin\(\)\) WITH CHECK \(NOT app_is_superadmin\(\)\);/);
  });

  it("issues short-lived signed downloads only after authorization in each service", () => {
    const storage = read("src/modules/storage/objectStorage.ts");
    expect(storage).toContain("expiresIn: 300");
    expect(storage).toContain("GetObjectCommand");
    expect(storage).toContain("ResponseContentDisposition");
  });
});
