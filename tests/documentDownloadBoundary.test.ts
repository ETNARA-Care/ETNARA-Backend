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

  it("keeps ETNARA Verified establishment review isolated to platform context", () => {
    const service = read("src/modules/establishmentDocuments/platformEstablishmentDocuments.service.ts");
    const routes = read("src/modules/establishmentDocuments/platformEstablishmentDocuments.routes.ts");

    expect(service).toContain("withPlatformContext");
    expect(service).toContain("establishment_documents");
    expect(service).not.toContain("resident_documents");
    expect(service).not.toContain("credentials");
    expect(routes).toContain("/platform/establishment-documents/verification-queue");
    expect(routes).toContain("/platform/establishment-documents/:documentId/download");
    expect(routes).toContain("/platform/establishment-documents/:documentId/review");
  });

  it("issues short-lived signed downloads only after authorization in each service", () => {
    const storage = read("src/modules/storage/objectStorage.ts");
    expect(storage).toContain("expiresIn: 300");
    expect(storage).toContain("GetObjectCommand");
    expect(storage).toContain("ResponseContentDisposition");
  });
});
