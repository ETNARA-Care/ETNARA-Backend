import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../migrations/070_repair_orphan_credential_documents.sql", import.meta.url),
  "utf8",
);

describe("credential document orphan repair", () => {
  it("repairs only completed professional files tied to the exact worker and credential", () => {
    expect(migration).toContain("sf.scope_type = 'PLATFORM_PROFESSIONAL'");
    expect(migration).toContain("sf.status = 'active'");
    expect(migration).toContain("sf.owner_worker_id = c.worker_id");
    expect(migration).toContain("c.worker_id::text || '/' || c.id::text");
    expect(migration).toContain("WHERE c.document_id IS NULL");
  });

  it("creates the canonical document/version relationship used by the platform queue", () => {
    expect(migration).toContain("INSERT INTO documents");
    expect(migration).toContain("INSERT INTO document_versions");
    expect(migration).toContain("SET document_id = repaired_document_id");
  });
});
