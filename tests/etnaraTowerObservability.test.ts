import { describe, expect, it } from "vitest";
import { deriveTowerAlerts } from "../src/modules/etnaraTower/observability.js";

describe("ETNARA Tower observability", () => {
  it("reports unavailable services as critical", () => {
    expect(deriveTowerAlerts([{ service: "backend", environment: "production", checkedAt: "2026-10-16T12:00:00Z", health: "unavailable", source: "healthcheck", summary: "Unavailable" }])).toEqual([{
      service: "backend", severity: "critical", title: "Service unavailable", evidenceSource: "healthcheck",
    }]);
  });
  it("does not claim unknown status is healthy or alert", () => {
    expect(deriveTowerAlerts([{ service: "dns", environment: "production", checkedAt: "2026-10-16T12:00:00Z", health: "unknown", source: "not-connected", summary: "No observation" }])).toEqual([]);
  });
  it("reports degraded services as warnings", () => {
    expect(deriveTowerAlerts([{ service: "database", environment: "production", checkedAt: "2026-10-16T12:00:00Z", health: "degraded", source: "metrics", summary: "Elevated latency" }])[0]?.severity).toBe("warning");
  });
});
