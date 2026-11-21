import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const O = "11111111-1111-4111-8111-111111111111", V = "22222222-2222-4222-8222-222222222222";
const mig = read("migrations/158_contracts_central_admin.sql");
const routes = read("src/modules/contracts/contracts.routes.ts");
const service = read("src/modules/contracts/contracts.service.ts");

describe("158: herramientas de Central para contratos", () => {
  it("solo un documento de PRUEBA puede dirigirse a una agencia; la Orden sigue exigiendo la suya", () => {
    expect(mig).toMatch(/kind <> 'SUBSCRIPTION_ORDER' OR organization_id IS NOT NULL/);
    expect(mig).toMatch(/organization_id IS NULL OR kind = 'SUBSCRIPTION_ORDER' OR is_test/);
    expect(service).toMatch(/if \(!input\.isTest\) throw new ContractRuleError\("CONTRACT_SCOPE_TEST_ONLY", 422\)/);
  });
  it("las representantes elegibles son administradoras activas, solo para superadministración, sin más datos que cuenta y correo", () => {
    expect(mig).toMatch(/IF NOT public\.app_is_superadmin\(\) THEN\s+RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED'/);
    expect(mig).toMatch(/app_contract_acceptance_facts\(u\.id, p_organization_id\)/);
    expect(mig).toMatch(/RETURNS TABLE \(user_id uuid, email text\)/);
    expect(mig).toMatch(/REVOKE ALL ON FUNCTION public\.app_platform_contract_eligible_signatories\(uuid\) FROM PUBLIC/);
  });
  it("retirar acepta un motivo que queda en la auditoría y nunca borra", () => {
    expect(routes).toMatch(/retireBody = z\.object\(\{ reason: z\.string\(\)\.trim\(\)\.min\(5\)\.max\(500\)\.optional\(\) \}\)\.strict\(\)/);
    expect(service).toMatch(/"CONTRACT_VERSION_RETIRED", "contract_document_version", versionId, reason \? \{ reason \} : \{\}/);
    const retire = service.slice(service.indexOf("export async function platformRetireVersion"), service.indexOf("export async function platformEligibleSignatories"));
    expect(retire).not.toMatch(/DELETE/);
  });
  it("las rutas nuevas son de Central y no dependen del interruptor de ninguna agencia", () => {
    expect(routes).toMatch(/router\.get\("\/platform\/contracts\/organizations\/:organizationId\/eligible-signatories", requireAuth/);
    expect(gatedFeatureFor(`/platform/contracts/organizations/${O}/eligible-signatories`, "GET")).toBeNull();
    expect(gatedFeatureFor(`/platform/contracts/versions/${V}/retire`, "POST")).toBeNull();
  });
  it("la reversión se niega si ya hay documentos de prueba dirigidos a una agencia", () => {
    expect(read("ops/158_contracts_central_admin.rollback.sql")).toMatch(/ROLLBACK_158_REFUSED/);
  });
});
