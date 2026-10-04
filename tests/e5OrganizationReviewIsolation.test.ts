import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const service = readFileSync(
  new URL("../src/modules/credentialing/credentialing.service.ts", import.meta.url),
  "utf8",
);

describe("E.5 organization credential review isolation", () => {
  it("keeps organization decisions tenant-local and reserves global document status for platform verification", () => {
    const orgStart = service.indexOf("export async function createOrUpdateOrganizationReview");
    expect(orgStart).toBeGreaterThan(-1);
    const orgSection = service.slice(orgStart);

    expect(orgSection).toContain("organization_document_version_reviews");
    expect(orgSection).toContain("organization_credential_reviews");
    expect(orgSection).not.toMatch(/UPDATE documents[\s\S]*reviewStatus/);

    const platformStart = service.indexOf("export async function createPlatformVerification");
    const platformEnd = service.indexOf("export async function createPlatformCredentialDocumentDownload");
    const platformSection = service.slice(platformStart, platformEnd);
    expect(platformSection).toMatch(/UPDATE documents[\s\S]*SET status = \$\{input\.status\}/);
  });
});
