import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { legalReference, roleTermsFromAnnex } from "../src/modules/contracts/contracts.roleTerms.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("migrations/156_contract_source_files_role_terms.sql");
const rollback = read("ops/156_contract_source_files_role_terms.rollback.sql");
const ANNEX = ["ANEXO E — TÉRMINOS INDIVIDUALES POR FUNCIÓN", "E.1. Uno.", "E.2. Administración.", "E.3. Cuidadores.", "E.4. Familiares.", "E.5. Todos.", "E.6. Cambios.", "E.7. Evidencia.", "E.8. Representación."];
const SRC = ["PRIMERA. Cláusula.", "ANEXO D — OTRO", "D.1. Otro anexo.", ...ANNEX, "", "[PIE DE PÁGINA DEL DOCUMENTO] Texto"].join("\n");

describe("156: términos por función tomados del Anexo E", () => {
  it("arma cada función con líneas literales: encabezado, E.1, su línea, E.5–E.8", () => {
    expect(roleTermsFromAnnex(SRC, "CAREGIVER")).toBe([ANNEX[0], ANNEX[1], ANNEX[3], ANNEX[5], ANNEX[6], ANNEX[7], ANNEX[8]].join("\n\n") + "\n");
    expect(roleTermsFromAnnex(SRC, "ADMINISTRATION")).toContain("E.2. Administración.");
    expect(roleTermsFromAnnex(SRC, "FAMILY")).not.toContain("E.3.");
    expect(roleTermsFromAnnex(SRC, "FAMILY")).not.toContain("PIE DE PÁGINA");
  });
  it("copia la marca de prueba si el contrato es de prueba y falla si falta el Anexo E", () => {
    expect(roleTermsFromAnnex(`DOCUMENTO FICTICIO DE PRUEBA — x\n${SRC}`, "FAMILY").startsWith("DOCUMENTO FICTICIO DE PRUEBA — x\n\nANEXO E")).toBe(true);
    expect(() => roleTermsFromAnnex("PRIMERA. Sin anexo.", "FAMILY")).toThrow("ROLE_TERMS_ANNEX_NOT_FOUND");
  });
  it("la referencia de aprobación queda con nombre, fecha y documento, en la forma que exige la base", () => {
    expect(legalReference(" Lcda. Nombre Apellido ", "2026-11-21", " Contrato v1.1 ")).toBe("Aprobado por: Lcda. Nombre Apellido | Fecha: 2026-11-21 | Referencia: Contrato v1.1");
    expect(migration).toContain("^Aprobado por: \\S[^|]*\\S \\| Fecha: [0-9]{4}-[0-9]{2}-[0-9]{2} \\| Referencia: \\S[^|]*\\S$");
  });
});

describe("156: garantías de la base", () => {
  it("Word original inmutable con huella calculada por la base y ligado a la versión", () => {
    expect(migration).toContain("NEW.sha256 := encode(sha256(NEW.content), 'hex')");
    expect(migration).toContain("CONTRACT_SOURCE_FILE_IMMUTABLE");
    expect(migration).toContain("CONTRACT_SOURCE_FILE_MISMATCH");
  });
  it("un contrato general oficial no se publica sin referencia completa ni Word aprobado", () => {
    expect(migration).toContain("CONTRACT_LEGAL_APPROVAL_REFERENCE_INCOMPLETE");
    expect(migration).toContain("CONTRACT_SOURCE_FILE_REQUIRED");
  });
  it("los términos solo admiten líneas íntegras del contrato y su aceptación es de la propia persona y función", () => {
    expect(migration).toContain("ROLE_TERMS_TEXT_NOT_IN_CONTRACT");
    expect(migration).toContain("ROLE_TERMS_ROLE_MISMATCH");
    expect(migration).toContain("CONSTRAINT user_role_terms_acceptances_once UNIQUE (user_id, organization_id, terms_version_id)");
  });
  it("la reversión se niega con evidencia oficial", () => {
    expect(rollback).toContain("CONTRACT_ROLLBACK_REFUSED_OFFICIAL_EVIDENCE");
  });
});
