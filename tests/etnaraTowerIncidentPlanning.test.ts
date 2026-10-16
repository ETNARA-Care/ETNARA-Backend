import { describe, expect, it } from "vitest";
import { planTowerIncident } from "../src/modules/etnaraTower/incidentPlanning.js";

const incident = {
  id: "INC-001",
  title: "Login unavailable",
  environment: "production",
  risk: "high" as const,
  status: "open" as const,
  evidenceRefs: ["sanitized-log-1"],
};

describe("ETNARA Tower incident planning", () => {
  it("creates an immutable planning snapshot", () => {
    const result = planTowerIncident(incident, [{
      id: "TASK-1",
      incidentId: "INC-001",
      assignedAgent: "sre",
      status: "queued",
      action: "investigate",
      evidenceRefs: [],
    }]);
    expect(result.tasks[0].assignedAgent).toBe("sre");
    expect(result.incident.status).toBe("open");
  });

  it("rejects tasks belonging to other incidents", () => {
    expect(() => planTowerIncident(incident, [{
      id: "TASK-2",
      incidentId: "INC-999",
      assignedAgent: "cto",
      status: "queued",
      action: "investigate",
      evidenceRefs: [],
    }])).toThrow("Tasks must belong to the incident");
  });

  it("rejects duplicate task ids", () => {
    const task = {
      id: "TASK-1",
      incidentId: "INC-001",
      assignedAgent: "sre" as const,
      status: "queued" as const,
      action: "investigate" as const,
      evidenceRefs: [],
    };
    expect(() => planTowerIncident(incident, [task, task])).toThrow("Duplicate task ids");
  });
});
