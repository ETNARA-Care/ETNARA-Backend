import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Phase 7.6.1 platform credential verification", () => {
  it("binds every new verification to the current immutable file version", () => {
    const migration = read("migrations/055_platform_credential_verification_queue.sql");
    const service = read("src/modules/credentialing/credentialing.service.ts");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS file_id uuid");
    expect(migration).toContain("dv.created_at <= cpv.verified_at");
    expect(migration).toContain("credential_id, file_id, verified_at DESC");
    expect(service).toContain("credential_id, file_id, verified_by_user_id");
    expect(service).toContain("WHERE credential_id = ${credentialId} AND file_id = ${credential.file_id}");
    expect(service).toContain("throw new CredentialDocumentRequiredError()");
  });

  it("uses independent platform authority for queue, decisions, and downloads", () => {
    const service = read("src/modules/credentialing/credentialing.service.ts");
    const routes = read("src/modules/credentialing/credentialing.routes.ts");
    expect(service.match(/withPlatformContext\(/g)?.length).toBeGreaterThanOrEqual(4);
    expect(routes).toContain('"/platform/credentials/verification-queue"');
    expect(routes).toContain('"/platform/credentials/:credentialId/documents/:fileId/download-url"');
    expect(routes).toContain('error: "PLATFORM_ACCESS_DENIED"');
  });

  it("makes rejection auditable and lets the latest current-file decision control eligibility", () => {
    const service = read("src/modules/credentialing/credentialing.service.ts");
    const eligibility = read("src/modules/eligibility/eligibility.service.ts");
    expect(service).toContain("notes are required when rejecting a credential");
    expect(service).toContain("ORDER BY verified_at DESC LIMIT 1");
    expect(service).toContain("UPDATE documents");
    expect(eligibility).toContain("cpv.file_id = d.file_id");
    expect(eligibility).toContain('reason = "PLATFORM_VERIFICATION_REJECTED"');
  });

  it("exposes platform authority from a server-side lookup, never an organization role", () => {
    const context = read("src/context/tenantContext.ts");
    const organizationContext = read("src/modules/organizationContext/organizationContext.service.ts");
    expect(context).toContain("FROM platform_admins");
    expect(context).toContain("revoked_at IS NULL");
    expect(organizationContext).toContain("platformAdmin: boolean");
    expect(organizationContext).toContain("isActivePlatformAdmin(userId)");
  });
});
