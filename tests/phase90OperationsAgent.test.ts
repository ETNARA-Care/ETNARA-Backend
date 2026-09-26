import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Phase 9.0 assisted operations agent", () => {
  it("creates a manager-requested briefing from the real operational center", () => {
    const service = read("src/modules/operations/operations.service.ts");
    const routes = read("src/modules/operations/operations.routes.ts");

    expect(routes).toContain("/operations/agent/briefing");
    expect(service).toContain("buildOperationsCenter");
    expect(service).toContain("center.alerts.slice(0, 5)");
    expect(service).toContain("requiresHumanConfirmation: true");
    expect(service).not.toMatch(/openai|anthropic|mock/i);
  });

  it("keeps immutable manager-only audit history", () => {
    const migration = read("migrations/061_operational_agent_runs.sql");

    expect(migration).toContain("operational_agent_runs_manager_read");
    expect(migration).toContain("app_is_org_manager()");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("app_record_operational_agent_run");
    expect(migration).toContain("jsonb_array_length(p_priority_alert_keys) > 5");
    expect(migration).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)/i);
  });

  it("prohibits autonomous operational and clinical decisions", () => {
    const service = read("src/modules/operations/operations.service.ts");

    for (const guardrail of [
      "No asigna ni cancela turnos.",
      "No aprueba credenciales, incidentes ni horas.",
      "No toma decisiones clínicas.",
      "Toda acción final requiere confirmación humana.",
    ]) {
      expect(service).toContain(guardrail);
    }
  });

  it("does not expose an agent route to Family", () => {
    const routes = read("src/modules/operations/operations.routes.ts");
    expect(routes).not.toMatch(/family/i);
  });
});
