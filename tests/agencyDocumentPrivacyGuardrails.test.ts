import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("agency document privacy regression guardrails", () => {
  it("does not grant platform access in document services", () => {
    for (const path of [
      "src/modules/establishmentDocuments/establishmentDocuments.service.ts",
      "src/modules/residentDocuments/residentDocuments.service.ts",
    ]) {
      expect(read(path)).not.toContain("app_is_superadmin()");
    }
  });
  it("fails closed on all central document operations", () => {
    const source = read("src/modules/establishmentDocuments/platformEstablishmentDocuments.service.ts");
    expect(source).not.toContain("createPrivateDownloadUrl");
    expect(source).not.toContain("SELECT ");
    expect(source).not.toContain("UPDATE ");
    expect((source.match(/PLATFORM_PRIVATE_DOCUMENT_ACCESS_DENIED/g) ?? []).length).toBe(3);
  });
  it("does not download archived establishment documents", () => {
    const source = read("src/modules/establishmentDocuments/establishmentDocuments.service.ts");
    expect(source).toMatch(/WHERE id=\$\{d\} AND organization_id=\$\{o\} AND establishment_id=\$\{e\} AND archived_at IS NULL LIMIT 1/);
  });
  it("requires a restrictive database platform-denial policy", () => {
    const migration = read("migrations/082_agency_document_privacy.sql");
    expect(migration).toContain("AS RESTRICTIVE FOR ALL TO app_runtime");
    expect(migration).toContain("NOT app_is_superadmin()");
    expect(migration).toContain("app.current_org_id");
  });
});
