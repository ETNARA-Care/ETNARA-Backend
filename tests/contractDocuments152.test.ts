import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { acceptanceStatement, contractsModuleEnabled } from "../src/modules/contracts/contracts.rules.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("migrations/152_contract_documents.sql");
const rollback = read("ops/152_contract_documents.rollback.sql");

describe("152 contract module (Etapa 1)", () => {
  afterEach(() => { delete process.env.CONTRACTS_MODULE; });

  it("is off unless CONTRACTS_MODULE=on (no blocking, no exposure by default)", () => {
    expect(contractsModuleEnabled()).toBe(false);
    process.env.CONTRACTS_MODULE = "true";
    expect(contractsModuleEnabled()).toBe(false);
    process.env.CONTRACTS_MODULE = "on";
    expect(contractsModuleEnabled()).toBe(true);
  });

  it("builds the acceptance statement on the server, naming the agency, version and hash", () => {
    const h = "a".repeat(64);
    const s = acceptanceStatement("Agencia Ficticia", "[PRUEBA] Acuerdo", "1.0", h, { fullName: " Ana Prueba Ficticia ", title: "Presidenta" });
    expect(s).toContain("Yo, Ana Prueba Ficticia, Presidenta de «Agencia Ficticia»");
    expect(s).toContain("versión 1.0");
    expect(s).toContain(h);
  });

  it("keeps the evidence immutable and computed by the database", () => {
    expect(migration).toMatch(/CONTRACT_ACCEPTANCE_IMMUTABLE/);
    expect(migration).toMatch(/NEW\.content_sha256 := public\.app_contract_sha256\(NEW\.body\)/);
    expect(migration).toMatch(/BEFORE TRUNCATE/);
    // The app may not write the snapshot columns of the evidence.
    expect(migration).toMatch(/GRANT INSERT \(organization_id, document_version_id, content_sha256, accepted_by_user_id, signer_full_name, signer_title, acceptance_statement, ip_address, user_agent, verification_challenge_id\)/);
    expect(migration).not.toMatch(/GRANT (UPDATE|DELETE)[^;]*organization_contract_acceptances/);
  });

  it("ties every acceptance to a consumed e-mail code of the same person (Etapa 2)", () => {
    expect(migration).toMatch(/verification_challenge_id uuid NOT NULL UNIQUE REFERENCES contract_signature_challenges\(id\)/);
    expect(migration).toMatch(/CONTRACT_IDENTITY_NOT_VERIFIED/);
    expect(migration).toMatch(/NEW\.email := v_login/);
    expect(migration).toMatch(/interval '10 minutes'/);
  });

  it("never lets ETNARA Central accept for an agency", () => {
    expect(migration).toMatch(/organization_contract_acceptances_admin_insert[\s\S]*WITH CHECK \(NOT app_is_superadmin\(\)/);
  });

  it("has a rollback that unregisters the migration and refuses when official evidence exists", () => {
    expect(rollback).toMatch(/DELETE FROM schema_migrations WHERE filename = '152_contract_documents\.sql'/);
    expect(rollback.indexOf("CONTRACT_ROLLBACK_REFUSED_OFFICIAL_EVIDENCE")).toBeLessThan(rollback.indexOf("DROP TABLE"));
  });

  it("records the authorized representative (name, title, fixed authority declaration)", () => {
    expect(migration).toMatch(/signer_full_name\s+text NOT NULL/);
    expect(migration).toMatch(/signer_title\s+text NOT NULL/);
    expect(migration).toMatch(/NEW\.authority_declaration := public\.app_contract_authority_declaration\(\)/);
  });
});
