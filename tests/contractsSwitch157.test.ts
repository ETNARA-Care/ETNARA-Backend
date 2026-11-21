import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const O = "11111111-1111-4111-8111-111111111111", V = "22222222-2222-4222-8222-222222222222";

describe("157: interruptor «Contratos» por agencia", () => {
  it("Central lo administra como los demás interruptores", () => {
    expect(read("src/modules/platformOrganizations/platformOrganizationFeatures.ts")).toMatch(/FEATURE_CODES = \[[^\]]*"CONTRACTS"\] as const/);
  });
  it("todas las rutas de contratos y términos de una agencia pasan por él, también las lecturas", () => {
    for (const [path, method] of [[`/organizations/${O}/contracts`, "GET"], [`/organizations/${O}/contracts/versions/${V}/accept`, "POST"],
      [`/organizations/${O}/contracts/acceptances/${V}/certificate.pdf`, "GET"], [`/organizations/${O}/contracts/versions/${V}/document.docx`, "GET"],
      [`/organizations/${O}/role-terms`, "GET"], [`/organizations/${O}/role-terms/${V}/accept`, "POST"], [`/organizations/${O}/CONTRACTS`, "GET"]] as const) {
      const g = gatedFeatureFor(path, method);
      expect(g, path).toMatchObject({ organizationId: O, feature: "CONTRACTS" });
      expect(g?.readOnlyPass, path).toBeUndefined();
    }
  });
  it("las rutas de Central no dependen del interruptor de ninguna agencia", () => {
    expect(gatedFeatureFor(`/platform/contracts/versions/${V}/publish`, "POST")).toBeNull();
  });
  it("la base exige el interruptor para nuevas evidencias desde la aplicación y la reversión no toca contratos", () => {
    const m = read("migrations/157_contracts_per_agency_switch.sql");
    expect(m).toContain("CONTRACT_ORGANIZATION_NOT_ENABLED");
    for (const t of ["contract_signature_challenges", "organization_contract_acceptances", "contract_document_downloads", "user_role_terms_acceptances"]) expect(m).toContain(`'${t}'`);
    const r = read("ops/157_contracts_per_agency_switch.rollback.sql");
    expect(r).not.toMatch(/DELETE FROM (organization_contract_acceptances|contract_)/);
  });
});
