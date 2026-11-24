import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const strip = (s: string) => s.replace(/--.*$/gm, "");
const m162 = strip(readFileSync("migrations/162_former_agency_document_access_download_audit.sql", "utf8"));
const rollback = strip(readFileSync("ops/162_former_agency_document_access_download_audit.rollback.sql", "utf8"));
const service = readFileSync("src/modules/credentialing/credentialing.service.ts", "utf8");
const download = service.slice(service.indexOf("export async function createCredentialDocumentDownload"), service.indexOf("export async function listMyCredentialSummaries"));
const list = service.slice(service.indexOf("export async function listCredentials"), service.indexOf("export async function", service.indexOf("export async function listCredentials") + 10));

describe("162 · former agency access and audited downloads", () => {
  it("drops only the credential, document and version exceptions; the profile one stays", () => {
    for (const t of ["credentials", "documents", "document_versions"]) expect(m162).toContain(`DROP POLICY IF EXISTS ${t}_manager_read_any_status ON ${t}`);
    expect(m162).not.toMatch(/DROP POLICY IF EXISTS workers_manager_read_any_status/);
    expect(m162).not.toMatch(/\bDELETE FROM\b|^\s*TRUNCATE\b/m);
    expect(m162).not.toMatch(/organization_credential_reviews/);
  });

  it("keeps the audit append-only and out of the runtime's direct reach", () => {
    expect(m162).toMatch(/REVOKE ALL ON credential_document_downloads FROM app_runtime/);
    expect(m162).toMatch(/GRANT SELECT ON credential_document_downloads TO app_runtime/);
    expect(m162).toMatch(/BEFORE UPDATE OR DELETE ON credential_document_downloads/);
    expect(m162).toMatch(/BEFORE TRUNCATE ON credential_document_downloads/);
    expect(m162).toMatch(/REVOKE ALL ON FUNCTION public\.app_issue_credential_document_download\(uuid, uuid, uuid\) FROM PUBLIC/);
  });

  it("issues the storage key only through the auditing database function", () => {
    expect(download).toContain("app_issue_credential_document_download");
    expect(download).not.toMatch(/SELECT\s+sf\.storage_key/);
    expect(list).toMatch(/if \(!active\) return \[\];/);
  });

  it("rollback restores the 137 exceptions and keeps the audit records", () => {
    for (const t of ["credentials", "documents", "document_versions"]) expect(rollback).toContain(`CREATE POLICY ${t}_manager_read_any_status`);
    expect(rollback).toContain("DROP FUNCTION IF EXISTS public.app_issue_credential_document_download");
    expect(rollback).not.toMatch(/^\s*DROP TABLE/m);
  });
});
