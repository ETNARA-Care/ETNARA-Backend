import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Phase 9.3 assisted care quality agent", () => {
  it("uses real verification, care documentation and follow-up records", () => {
    const service = read("src/modules/careQualityAgent/careQualityAgent.service.ts");
    const routes = read("src/modules/careQualityAgent/careQualityAgent.routes.ts");

    expect(routes).toContain("/care-quality/agent/briefing");
    expect(service).toContain("verification_events");
    expect(service).toContain("organization_care_event_types");
    expect(service).toContain("observation.status = 'open'");
    expect(service).toContain("incident_timeline_entries");
    expect(service).toContain("priorities.slice(0, 5)");
    expect(service).not.toMatch(/openai|anthropic|mock/i);
  });

  it("records manager-only immutable run history", () => {
    const migration = read("migrations/064_care_quality_agent_runs.sql");

    expect(migration).toContain("care_quality_agent_runs_manager_read");
    expect(migration).toContain("app_is_org_manager()");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("app_record_care_quality_agent_run");
    expect(migration).toContain("jsonb_array_length(p_priority_keys) > 5");
    expect(migration).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)/i);
  });

  it("keeps documentation and clinical decisions under human control", () => {
    const service = read("src/modules/careQualityAgent/careQualityAgent.service.ts");

    for (const guardrail of [
      "No crea ni edita notas de cuidado.",
      "No marca observaciones como revisadas ni resuelve incidentes.",
      "No emite diagnósticos ni conclusiones clínicas.",
      "Toda acción final requiere confirmación humana.",
    ]) {
      expect(service).toContain(guardrail);
    }
    expect(service).toContain("requiresHumanConfirmation: true");
    expect(service).not.toMatch(/UPDATE (care_events|observations|incidents)/i);
  });

  it("exposes no Family care quality route", () => {
    const routes = read("src/modules/careQualityAgent/careQualityAgent.routes.ts");
    expect(routes).not.toMatch(/family/i);
  });
});
