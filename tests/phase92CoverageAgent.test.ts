import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Phase 9.2 assisted coverage agent", () => {
  it("uses real uncovered shifts, campaigns and fresh recommendations", () => {
    const service = read("src/modules/coverageAgent/coverageAgent.service.ts");
    const routes = read("src/modules/coverageAgent/coverageAgent.routes.ts");

    expect(routes).toContain("/coverage/agent/briefing");
    expect(service).toContain("shift.status = 'unassigned'");
    expect(service).toContain("coverage_campaigns");
    expect(service).toContain("recommendCoverage(userId, organizationId");
    expect(service).toContain("selected = analyzed.slice(0, 5)");
    expect(service).not.toMatch(/openai|anthropic|mock/i);
  });

  it("records manager-only immutable run history", () => {
    const migration = read("migrations/063_coverage_agent_runs.sql");

    expect(migration).toContain("coverage_agent_runs_manager_read");
    expect(migration).toContain("app_is_org_manager()");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("app_record_coverage_agent_run");
    expect(migration).toContain("jsonb_array_length(p_priority_shift_ids) > 5");
    expect(migration).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)/i);
  });

  it("keeps offers and assignments under human control", () => {
    const service = read("src/modules/coverageAgent/coverageAgent.service.ts");

    for (const guardrail of [
      "No envía ofertas ni contacta al personal.",
      "No asigna ni cancela turnos.",
      "No cambia elegibilidad, disponibilidad ni campañas.",
      "Toda acción final requiere confirmación humana.",
    ]) {
      expect(service).toContain(guardrail);
    }
    expect(service).toContain("requiresHumanConfirmation: true");
    expect(service).not.toMatch(/INSERT INTO (assignments|coverage_campaigns|coverage_offers)/i);
  });

  it("exposes no Family coverage agent route", () => {
    const routes = read("src/modules/coverageAgent/coverageAgent.routes.ts");
    expect(routes).not.toMatch(/family/i);
  });
});
