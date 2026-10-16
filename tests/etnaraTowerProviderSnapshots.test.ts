import { describe, expect, it } from "vitest";
import { deriveTowerAlerts } from "../src/modules/etnaraTower/observability.js";
import { githubWorkflowObservation, railwayServiceObservation, railwayDeploymentObservation } from "../src/modules/etnaraTower/providerSnapshots.js";
const at = "2026-10-16T17:00:00.000Z";
describe("Tower sanitized provider snapshots", () => {
  it("uses live service state instead of deployment success as uptime", () => {
    expect(railwayServiceObservation({ name: "backend", state: "crashed", deploymentStatus: "SUCCESS" }, at).health).toBe("unavailable");
  });
  it("does not declare missing data healthy", () => {
    expect(railwayServiceObservation(null, at).health).toBe("unknown");
    expect(railwayDeploymentObservation(null, at).health).toBe("unknown");
  });
  it("turns a failed CI workflow into a warning, not a critical outage", () => {
    const observation = githubWorkflowObservation({ status: "completed", conclusion: "failure" }, at);
    expect(observation.health).toBe("degraded");
    expect(deriveTowerAlerts([observation])[0]?.severity).toBe("warning");
  });
  it("does not alert on incomplete workflows", () => {
    expect(deriveTowerAlerts([githubWorkflowObservation({ status: "in_progress", conclusion: null }, at)])).toEqual([]);
  });
});
