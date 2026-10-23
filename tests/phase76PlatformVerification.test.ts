import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Credential privacy boundary", () => {
  it("keeps historical platform-verification migrations immutable while removing runtime platform inspection", () => {
    const migration = read("migrations/055_platform_credential_verification_queue.sql");
    const service = read("src/modules/credentialing/credentialing.service.ts");
    const routes = read("src/modules/credentialing/credentialing.routes.ts");

    expect(migration).toContain("ADD COLUMN IF NOT EXISTS file_id uuid");
    expect(migration).toContain("credential_id, file_id, verified_at DESC");
    expect(service).not.toContain("createPlatformVerification");
    expect(service).not.toContain("createPlatformCredentialDocumentDownload");
    expect(service).not.toContain("listPlatformCredentialVerificationQueue");
    expect(routes).not.toContain("/platform/credentials/verification-queue");
    expect(routes).not.toContain("/platform/credentials/:credentialId/documents/:fileId/download-url");
  });

  it("keeps organization review tenant-scoped and auditable", () => {
    const service = read("src/modules/credentialing/credentialing.service.ts");
    const routes = read("src/modules/credentialing/credentialing.routes.ts");

    expect(service).toContain("organization_document_version_reviews");
    expect(service).toContain("organization_credential_reviews");
    expect(service).toContain("notes are required when rejecting a document");
    expect(routes).toContain("/organizations/:organizationId/workers/:membershipId/credentials/:credentialId/review");
  });

  it("does not let platform authority substitute for an organization membership", () => {
    const context = read("src/context/tenantContext.ts");
    expect(context).toContain("set_config('app.is_superadmin', 'false'");
    expect(context).toContain("FROM organization_memberships");
    expect(context).toContain("status = 'active'");
  });

  it("still resolves platform authority server-side for legitimate non-PHI platform functions", () => {
    const context = read("src/context/tenantContext.ts");
    expect(context).toContain("FROM platform_admins");
    expect(context).toContain("revoked_at IS NULL");
    expect(context).toContain("withPlatformContext");
  });
});
