import { describe, expect, it } from "vitest";
import { TOWER_AGENTS, TOWER_AGENT_IDS, mayExecuteTowerAction, towerActionRequiresApproval } from "../src/modules/etnaraTower/agentCatalog.js";

describe("ETNARA Tower phase 11.2 agent policy", () => {
  it("defines exactly five unique agents", () => {
    expect(TOWER_AGENTS).toHaveLength(5);
    expect(new Set(TOWER_AGENTS.map((agent) => agent.id)).size).toBe(5);
    expect(TOWER_AGENTS.map((agent) => agent.id)).toEqual([...TOWER_AGENT_IDS]);
  });

  it("never executes sensitive actions from this read-only core", () => {
    for (const action of ["write-code", "deploy", "rollback", "change-dns", "change-access", "run-migration"] as const) {
      expect(towerActionRequiresApproval(action)).toBe(true);
      expect(mayExecuteTowerAction(action)).toBe(false);
      expect(mayExecuteTowerAction(action, "approved")).toBe(false);
    }
  });

  it("allows read-only actions without approval", () => {
    expect(mayExecuteTowerAction("read-observability")).toBe(true);
    expect(mayExecuteTowerAction("read-repository")).toBe(true);
    expect(mayExecuteTowerAction("read-infrastructure")).toBe(true);
    expect(mayExecuteTowerAction("propose-change")).toBe(true);
  });
});
