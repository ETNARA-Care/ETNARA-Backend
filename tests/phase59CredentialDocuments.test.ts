import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Phase 5.9 private credential documents", () => {
  it("uses short-lived private S3 URLs without storing binary content in PostgreSQL", () => {
    const storage = read("src/modules/storage/objectStorage.ts");
    const service = read("src/modules/credentialing/credentialing.service.ts");

    expect(storage).toContain("PutObjectCommand");
    expect(storage).toContain("GetObjectCommand");
    expect(storage).toContain("expiresIn: 300");
    expect(service).toContain("INSERT INTO stored_files");
    expect(service).not.toMatch(/bytea|base64/i);
  });

  it("supports authenticated backend-proxied uploads when browser CORS blocks the bucket", () => {
    const storage = read("src/modules/storage/objectStorage.ts");
    const service = read("src/modules/credentialing/credentialing.service.ts");
    const routes = read("src/modules/credentialing/credentialing.routes.ts");

    expect(storage).toContain("uploadPrivateObject");
    expect(service).toContain("uploadCredentialDocumentContent");
    expect(service).toContain("Number(file.size_bytes) !== body.byteLength");
    expect(routes).toContain("documents/:fileId/content");
    expect(routes).toContain("requireAuth");
    expect(routes).toContain("express.raw");
    expect(routes).toContain("Unexpected credential storage failure");
    expect(routes).not.toMatch(/request body|originalFilename|storageKey.*console/i);
  });

  it("keeps document versions and resets review after replacement", () => {
    const service = read("src/modules/credentialing/credentialing.service.ts");
    const routes = read("src/modules/credentialing/credentialing.routes.ts");

    expect(service).toContain("INSERT INTO document_versions");
    expect(service).toContain("COALESCE(MAX(version), 0) + 1");
    expect(service).toContain("SET review_status = 'pending', notes = NULL, reviewed_at = NULL");
    expect(service).toContain("throw new CredentialDocumentRequiredError()");
    expect(service).toContain("notes are required when rejecting a document");
    expect(service).toContain("INSERT INTO organization_document_version_reviews");
    expect(service).toContain("await assertCredentialManager(trx)");
    expect(routes).toContain("documents/:fileId/download-url");
  });

  it("creates one actionable expiration notice for organization managers", () => {
    const migration = read("migrations/048_credential_expiry_notifications.sql");
    const credentialing = read("src/modules/credentialing/credentialing.service.ts");
    const notifications = read("src/modules/notifications/notifications.service.ts");

    expect(migration).toContain("CREDENTIAL_EXPIRING");
    expect(migration).toContain("CREDENTIAL_EXPIRED");
    expect(migration).toContain("ON CONFLICT DO NOTHING");
    expect(migration).toContain("app_notification_credential_membership_id");
    expect(credentialing).toContain("app_notify_credential_expiry_managers");
    expect(notifications).toContain("workerMembershipId");
  });
});
