import { describe, expect, it } from "vitest";
import { classifyGithubCI, classifyRailwayDeployment } from "../src/modules/etnaraTower/readOnlyAdapters.js";

describe("ETNARA Tower read-only adapters", () => {
  it("classifies successful Railway deployment without exposing details", () => {
    const result = classifyRailwayDeployment({ status: "SUCCESS", createdAt: "2026-10-16", serviceName: "backend" }, "backend", "2026-10-16T15:00:00Z");
    expect(result.health).toBe("healthy");
    expect(result.summary).toBe("Latest deployment succeeded");
  });
  it("classifies failed deployments as unavailable", () => {
    expect(classifyRailwayDeployment({ status: "CRASHED", createdAt: "", serviceName: "backend" }).health).toBe("unavailable");
  });
  it("does not confuse missing observations with success", () => {
    expect(classifyRailwayDeployment(null).health).toBe("unknown");
  });
  it("keeps CI results distinct from uptime", () => {
    expect(classifyGithubCI("success")).toBe("passing");
    expect(classifyGithubCI("failure")).toBe("failing");
  });
});
