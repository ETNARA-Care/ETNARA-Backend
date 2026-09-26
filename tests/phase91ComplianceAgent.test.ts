import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Phase 9.1 assisted compliance agent", () => {
  it("uses fresh eligibility and real credential expirations", () => {
    const service = read("src/modules/eligibility/eligibility.service.ts");

    expect(service).toContain("getComplianceSummary(userId, organizationId");
    expect(service).toContain("c.expires_at BETWEEN current_date AND current_date + 30");
    expect(service).toContain("PLATFORM_VERIFICATION_REJECTED");
    expect(service).toContain("CREDENTIAL_EXPIRED");
    expect(service).toContain("selected = priorityCandidates.slice(0, 5)");
    expect(service).not.toMatch(/openai|anthropic|mock/i);
  });

  it("records manager-only immutable run history", () => {
    const migration = read("migrations/062_compliance_agent_runs.sql");

    expect(migration).toContain("compliance_agent_runs_manager_read");
    expect(migration).toContain("app_is_org_manager()");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("app_record_compliance_agent_run");
    expect(migration).toContain("jsonb_array_length(p_priority_membership_ids) > 5");
    expect(migration).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)/i);
  });

  it("keeps all compliance decisions human-controlled", () => {
    const service = read("src/modules/eligibility/eligibility.service.ts");

    for (const guardrail of [
      "No aprueba ni rechaza credenciales.",
      "No cambia la elegibilidad ni el estado laboral.",
      "No carga documentos ni modifica políticas.",
      "Toda acción final requiere confirmación humana.",
    ]) {
      expect(service).toContain(guardrail);
    }
    expect(service).toContain("requiresHumanConfirmation: true");
  });

  it("exposes no Family compliance agent route", () => {
    const routes = read("src/modules/eligibility/eligibility.routes.ts");
    expect(routes).toContain("/compliance/agent/briefing");
    expect(routes).not.toMatch(/family[^\n]*compliance\/agent/i);
  });
});
