import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const service = readFileSync(
  new URL("../src/modules/credentialing/credentialing.service.ts", import.meta.url),
  "utf8",
);

describe("E.5 organization credential review isolation", () => {
  it("keeps organization decisions tenant-local and removes platform employee-document review", () => {
    const orgStart = service.indexOf("export async function createOrUpdateOrganizationReview");
    expect(orgStart).toBeGreaterThan(-1);
    const orgSection = service.slice(orgStart);

    expect(orgSection).toContain("organization_document_version_reviews");
    expect(orgSection).toContain("organization_credential_reviews");
    expect(orgSection).not.toMatch(/UPDATE documents[\s\S]*reviewStatus/);

    expect(service).not.toContain("export async function createPlatformVerification");
    expect(service).not.toContain("export async function createPlatformCredentialDocumentDownload");
    expect(service).not.toContain("export async function listPlatformCredentialVerificationQueue");
  });
});
