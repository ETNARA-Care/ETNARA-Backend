import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { teamRouteFor } from "../src/middleware/modalityRules.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const mig = read("migrations/160_independent_provider_modality.sql");
const rollback = read("ops/160_independent_provider_modality.rollback.sql");
const m085 = read("migrations/085_org_admin_authority.sql");
const fn = (src: string) => src.slice(src.indexOf("CREATE OR REPLACE FUNCTION app_activate_organization_admin_invitation("), src.indexOf("GRANT EXECUTE ON FUNCTION app_activate_organization_admin_invitation(text,text,uuid) TO app_runtime;"));
const O = "/organizations/11111111-2222-3333-4444-555555555555";

describe("160: cuidador independiente (PR A)", () => {
  it("la modalidad nace apagada y app_runtime no puede encenderla", () => {
    expect(mig).toMatch(/VALUES \('INDEPENDENT_PROVIDER', false,/);
    expect(mig).toMatch(/REVOKE ALL ON platform_modalities FROM app_runtime;/);
    expect(mig).toMatch(/RAISE EXCEPTION 'INDEPENDENT_MODALITY_DISABLED'/);
  });
  it("el tipo es inmutable salvo el procedimiento, que nunca se concede a app_runtime", () => {
    expect(mig).toMatch(/session_user = 'app_runtime'/);
    expect(mig).toMatch(/RAISE EXCEPTION 'ORGANIZATION_TYPE_IMMUTABLE'/);
    expect(mig).not.toMatch(/GRANT EXECUTE ON FUNCTION app_ops_change_organization_type/);
    expect(mig).not.toMatch(/GRANT EXECUTE ON FUNCTION app_independent_provision_operator/);
  });
  it("cada guarda nuevo se limita a INDEPENDENT_PROVIDER", () => {
    for (const g of ["app_independent_roles_guard", "app_independent_worker_membership_guard", "app_independent_invitation_guard"]) {
      const body = mig.slice(mig.indexOf(`FUNCTION ${g}()`));
      expect(body.slice(0, 400)).toMatch(/IF NOT public\.app_org_is_independent\(NEW\.organization_id\) THEN RETURN NEW; END IF;/);
    }
  });
  it("la activación es la de la 085 más un único bloque marcado 160", () => {
    const now = fn(mig), before = fn(m085);
    const block = now.slice(now.indexOf("  -- 160:"), now.indexOf("  END IF;\n", now.indexOf("  -- 160:")) + "  END IF;\n".length);
    expect(block).toContain("app_independent_provision_operator");
    expect(now.replace(block, "").replace(/\n{2,}/g, "\n")).toBe(before.replace(/\n{2,}/g, "\n"));
    expect(fn(rollback)).toBe(before);
  });
  it("rutas de equipo cerradas para el independiente; lo propio sigue abierto", () => {
    for (const [m, p] of [["GET", "/team"], ["POST", "/workers"], ["GET", "/credentials/review-queue"], ["GET", "/smartmatch/x"], ["GET", "/operations/center"], ["GET", "/ESTABLISHMENTS"], ["GET", "/pay-periods"], ["GET", "/compliance/audit"], ["POST", "/compliance/agent/briefing"], ["POST", "/my-agency-conversation"]])
      expect(teamRouteFor(`${O}${p}`, m)).not.toBeNull();
    for (const [m, p] of [["GET", "/workers"], ["GET", "/care-recipients"], ["POST", "/care-recipients"], ["GET", "/shifts"], ["POST", "/access-invitations"], ["GET", "/me/credentials"], ["GET", "/conversations"], ["GET", "/compliance/configuration"], ["GET", "/workers/11111111-2222-3333-4444-555555555555/compliance"], ["POST", "/shifts/11111111-2222-3333-4444-555555555555/assignments"], ["POST", "/shifts/11111111-2222-3333-4444-555555555555/check-in"]])
      expect(teamRouteFor(`${O}${p}`, m)).toBeNull();
  });
  it("PR B: «Asignármelo» reutiliza las reglas de Turnos (elegibilidad incluida) y solo existe en independientes", () => {
    const svc = read("src/modules/assignments/assignments.service.ts");
    const body = svc.slice(svc.indexOf("export async function selfAssignMyShift("), svc.indexOf("/**\n * Removal"));
    expect(body).toMatch(/app_org_is_independent/);
    expect(body).toMatch(/throw new SelfAssignNotAvailableError\(\)/);
    expect(body).toMatch(/assignWorkerToShiftInTransaction\(trx, organizationId, shiftId/);
    expect(body).toMatch(/app_my_confirmed_commitment_overlaps/);
    expect(body).not.toMatch(/evaluateWorkerEligibility|eligibilityStatus/); // no evalúa por su cuenta ni la salta
    const assign = svc.slice(svc.indexOf("export async function assignWorkerToShiftInTransaction("), svc.indexOf("export async function listAssignments("));
    expect(assign).toMatch(/if \(eligibility\.eligibilityStatus !== "eligible" && !selfDeclarationMissing\) \{/);
  });
});
