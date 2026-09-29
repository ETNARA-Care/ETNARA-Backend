import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { analyzeInitialCredentialDocument } from "../src/modules/credentialing/documentAnalysis.js";

const read = (path: string) => readFileSync(path, "utf8");

describe("Phase 11.1 smart initial document validation", () => {
  it("never presents metadata-only analysis as verified", () => {
    const result = analyzeInitialCredentialDocument({
      selectedCredentialTypeCode: "CPR",
      originalFilename: "credential.jpg",
      contentType: "image/jpeg",
      sizeBytes: 2048,
      documentId: "00000000-0000-0000-0000-000000000001",
      fileId: "00000000-0000-0000-0000-000000000002",
      documentVersion: 1,
    });

    expect(result.assessment).toBe("uncertain");
    expect(result.detectedDocumentType).toBeNull();
    expect(result.summary).toContain("Requiere revisión humana");
    expect(JSON.stringify(result)).not.toContain("verified");
    expect(JSON.stringify(result)).not.toContain("approved");
  });

  it("flags objective file metadata inconsistencies", () => {
    const result = analyzeInitialCredentialDocument({
      selectedCredentialTypeCode: "CPR",
      originalFilename: "not-a-document.txt",
      contentType: "image/jpeg",
      sizeBytes: 32,
      documentId: "00000000-0000-0000-0000-000000000001",
      fileId: "00000000-0000-0000-0000-000000000002",
      documentVersion: 2,
    });

    expect(result.assessment).toBe("inconsistent");
    expect(result.flags).toContain("FILE_EXTENSION_CONTENT_TYPE_MISMATCH");
    expect(result.flags).toContain("FILE_TOO_SMALL_FOR_RELIABLE_ANALYSIS");
  });

  it("stores analysis per immutable file version under manager-only tenant RLS", () => {
    const migration = read("migrations/066_document_analysis_results.sql");
    expect(migration).toContain("CREATE TABLE document_analysis_results");
    expect(migration).toContain("UNIQUE (organization_id, credential_id, file_id)");
    expect(migration).toContain("document_analysis_manager_read");
    expect(migration).toContain("document_analysis_manager_insert");
    expect(migration).toContain("app_is_org_manager()");
    expect(migration).not.toContain("UPDATE ON document_analysis_results");
    expect(migration).not.toContain("DELETE ON document_analysis_results");
  });

  it("documents the human decision boundary", () => {
    const contract = read("docs/PHASE_11_1_SMART_DOCUMENT_VALIDATION.md");
    expect(contract).toContain("Analysis is advisory");
    expect(contract).toContain("never approves or rejects a credential");
    expect(contract).toContain("human manager");
    expect(contract).toContain("pet/photo image");
  });
});
