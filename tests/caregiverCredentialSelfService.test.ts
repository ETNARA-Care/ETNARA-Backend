import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const service = readFileSync(
  new URL("../src/modules/credentialing/credentialing.service.ts", import.meta.url),
  "utf8",
);

function section(start: string, end: string) {
  const startIndex = service.indexOf(start);
  expect(startIndex).toBeGreaterThan(-1);
  const endIndex = service.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return service.slice(startIndex, endIndex);
}

describe("caregiver credential self-service security contract", () => {
  it("derives the caregiver worker id from the authenticated user and organization", () => {
    const resolver = section(
      "async function resolveCurrentWorkerId",
      "async function assertCredentialBelongsToWorker",
    );
    expect(resolver).toContain("WHERE w.user_id = ${userId}");
    expect(resolver).toContain("owm.organization_id = ${organizationId}");
    expect(resolver).toContain("owm.status = 'active'");
  });

  it("allows the worker themselves or an organization manager through every upload step", () => {
    const initiate = section(
      "export async function initiateCredentialDocumentUpload",
      "export async function uploadCredentialDocumentContent",
    );
    const upload = section(
      "export async function uploadCredentialDocumentContent",
      "export async function completeCredentialDocumentUpload",
    );
    const complete = section(
      "export async function completeCredentialDocumentUpload",
      "export async function listCredentialDocumentVersions",
    );

    expect(initiate).toContain("assertCredentialUploadActor(trx, workerId)");
    expect(upload).toContain("assertCredentialUploadActor(trx, workerId)");
    expect(complete).toContain("assertCredentialUploadActor(trx, workerId)");
    expect(upload).not.toContain("assertCredentialManager(trx)");
  });

  it("resets an existing organization review to pending when a replacement is completed", () => {
    const complete = section(
      "export async function completeCredentialDocumentUpload",
      "export async function listCredentialDocumentVersions",
    );
    expect(complete).toMatch(
      /UPDATE organization_credential_reviews[\s\S]*review_status = 'pending'[\s\S]*notes = NULL[\s\S]*reviewed_at = NULL/,
    );
    expect(complete).toMatch(
      /WHERE credential_id = \$\{credentialId\} AND organization_id = \$\{organizationId\}/,
    );
  });

  it("requires a reason when the agency rejects a caregiver credential", () => {
    expect(service).toMatch(
      /reviewStatus === "rejected" && !input\.notes[\s\S]*notes are required when rejecting a document/,
    );
  });

  it("keeps agency review manager-only", () => {
    const review = service.slice(
      service.indexOf("export async function createOrUpdateOrganizationReview"),
    );
    expect(review).toContain("assertCredentialManager(trx)");
    expect(review).toContain("organization_id = ${organizationId}");
  });
});
