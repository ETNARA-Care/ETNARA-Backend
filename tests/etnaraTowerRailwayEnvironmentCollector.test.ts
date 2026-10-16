import { describe, expect, it } from "vitest";
import { collectRailwayEnvironmentObservations } from "../src/modules/etnaraTower/railwayEnvironmentCollector.js";
const mapping = { backend: "backend-id", database: "db-id" };
const at = "2026-10-16T18:00:00Z";
describe("Tower Railway environment normalization", () => {
  it("maps backend and database independently by stable service ID", () => {
    const result = collectRailwayEnvironmentObservations({ services: [
      { serviceId: "backend-id", serviceName: "backend", state: "online" },
      { serviceId: "db-id", serviceName: "database", state: "crashed" },
    ] }, mapping, at);
    expect(result.map(r => r.service)).toEqual(["backend", "database"]);
    expect(result.map(r => r.health)).toEqual(["healthy", "unavailable"]);
  });
  it("does not guess health when a service is missing", () => {
    const result = collectRailwayEnvironmentObservations(null, mapping, at);
    expect(result.every(r => r.health === "unknown")).toBe(true);
  });
  it("does not include raw status text or secrets in output", () => {
    const result = collectRailwayEnvironmentObservations({ services: [
      { serviceId: "backend-id", serviceName: "backend", state: "online", statusText: "SECRET-TOKEN" },
    ] }, mapping, at);
    expect(JSON.stringify(result)).not.toContain("SECRET-TOKEN");
  });
});
