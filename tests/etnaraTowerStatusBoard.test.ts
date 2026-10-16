import { describe, expect, it } from "vitest";
import { buildTowerStatusBoard } from "../src/modules/etnaraTower/statusBoard.js";
import type { TowerHealthObservation } from "../src/modules/etnaraTower/observability.js";
const at = "2026-10-16T17:00:00Z";
const observation = (service: TowerHealthObservation["service"], health: TowerHealthObservation["health"], checkedAt = at): TowerHealthObservation =>
  ({ service, health, checkedAt, environment: "production", source: "test", summary: "Sanitized test observation" });
describe("Tower status board", () => {
  it("never reports all healthy when some sources are absent", () => {
    const board = buildTowerStatusBoard([observation("backend", "healthy")], at);
    expect(board.overall).toBe("unknown");
    expect(board.services).toHaveLength(4);
  });
  it("surfaces critical outages", () => {
    const board = buildTowerStatusBoard([observation("backend", "unavailable")], at);
    expect(board.overall).toBe("critical");
    expect(board.alerts[0]?.severity).toBe("critical");
  });
  it("uses the most recent observation instead of stale alerts", () => {
    const board = buildTowerStatusBoard([observation("backend", "unavailable", "2026-10-15T17:00:00Z"), observation("backend", "healthy")], at);
    expect(board.alerts).toEqual([]);
    expect(board.services[0]?.health).toBe("healthy");
  });
  it("reports healthy only when every tracked service is healthy", () => {
    const board = buildTowerStatusBoard(["backend", "frontend", "database", "dns"].map(s => observation(s as TowerHealthObservation["service"], "healthy")), at);
    expect(board.overall).toBe("healthy");
  });
});
