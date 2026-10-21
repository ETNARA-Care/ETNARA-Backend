import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("credential review queue and notifications", () => {
  it("keeps the agency review queue manager-only and tenant-scoped", () => {
    const service = read("src/modules/credentialing/credentialing.service.ts");
    const start = service.indexOf("export async function listPendingOrganizationCredentialReviews");
    expect(start).toBeGreaterThan(-1);
    const section = service.slice(start, service.indexOf("// ===================== Platform Verification", start));

    expect(section).toContain("assertCredentialManager(trx)");
    expect(section).toContain("owm.organization_id = ${organizationId}");
    expect(section).toContain("ocr.organization_id = ${organizationId}");
    expect(section).toContain("COALESCE(ocr.review_status, 'pending') = 'pending'");
    expect(section).not.toContain("app_is_superadmin()");
  });

  it("returns only current active private document metadata needed for agency review", () => {
    const service = read("src/modules/credentialing/credentialing.service.ts");
    expect(service).toMatch(/JOIN stored_files sf ON sf\.id = d\.file_id AND sf\.status = 'active'/);
    expect(service).toMatch(/JOIN document_versions dv ON dv\.document_id = d\.id AND dv\.file_id = d\.file_id/);
    expect(service).toContain("originalFilename");
    expect(service).toContain("submittedAt");
  });

  it("notifies tenant managers after a caregiver completes a credential upload", () => {
    const service = read("src/modules/credentialing/credentialing.service.ts");
    const migration = read("migrations/080_credential_review_queue_notifications.sql");

    expect(service).toMatch(/UPDATE organization_credential_reviews[\s\S]*review_status = 'pending'[\s\S]*app_notify_credential_review_managers/);
    expect(migration).toContain("SECURITY DEFINER SET search_path = public");
    expect(migration).toContain("r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')");
    expect(migration).toContain("w.user_id = v_current_user_id");
    expect(migration).toContain("'CREDENTIAL_REVIEW_PENDING'");
    expect(migration).not.toContain("app_is_superadmin()");
  });

  it("exposes a manager review-queue route and notification summary", () => {
    const routes = read("src/modules/credentialing/credentialing.routes.ts");
    const notifications = read("src/modules/notifications/notifications.service.ts");

    expect(routes).toContain("/organizations/:organizationId/credentials/review-queue");
    expect(routes).toContain("listPendingOrganizationCredentialReviews");
    expect(notifications).toContain('case "CREDENTIAL_REVIEW_PENDING"');
    expect(notifications).toContain("Credencial pendiente de revisión");
  });
});
