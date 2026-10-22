import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("credential review result notifications", () => {
  it("notifies only the caregiver who owns the reviewed credential", () => {
    const migration = read("migrations/081_credential_review_result_notifications.sql");
    expect(migration).toContain("NOT app_is_org_manager()");
    expect(migration).toContain("owm.organization_id = v_organization_id");
    expect(migration).toContain("w.user_id INTO v_worker_user_id");
    expect(migration).toContain("'CREDENTIAL_REVIEW_APPROVED'");
    expect(migration).toContain("'CREDENTIAL_REVIEW_REJECTED'");
    expect(migration).not.toContain("app_is_superadmin()");
  });

  it("uses a narrow security-definer helper rather than broad notification RLS", () => {
    const migration = read("migrations/081_credential_review_result_notifications.sql");
    expect(migration).toContain("SECURITY DEFINER SET search_path = public");
    expect(migration).toContain("REVOKE ALL ON FUNCTION app_notify_credential_review_result");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION app_notify_credential_review_result");
    expect(migration).not.toContain("DROP POLICY");
    expect(migration).not.toContain("CREATE POLICY");
  });

  it("sends the result after both review update and first review insert", () => {
    const service = read("src/modules/credentialing/credentialing.service.ts");
    const matches = service.match(/app_notify_credential_review_result/g) ?? [];
    expect(matches.length).toBe(2);
    expect(service).toContain("organizationReviewSchema");
    expect(service).toContain("notes are required when rejecting a document");
  });

  it("exposes caregiver-safe notification summaries", () => {
    const notifications = read("src/modules/notifications/notifications.service.ts");
    expect(notifications).toContain('case "CREDENTIAL_REVIEW_APPROVED"');
    expect(notifications).toContain('case "CREDENTIAL_REVIEW_REJECTED"');
    expect(notifications).toContain("Credencial aprobada");
    expect(notifications).toContain("Credencial rechazada");
  });
});
