import { describe, expect, it } from "vitest";
import { buildTowerStatusBoard } from "../src/modules/etnaraTower/statusBoard.js";
describe("Tower production status isolation", () => {
  it("does not allow passing CI to override a failed production backend", () => {
    const board = buildTowerStatusBoard([
      { service: "backend", environment: "production", checkedAt: "2026-10-16T10:00:00Z", health: "unavailable", source: "prod", summary: "Unavailable" },
      { service: "backend", environment: "ci", checkedAt: "2026-10-16T11:00:00Z", health: "healthy", source: "github", summary: "CI passing" },
    ], "2026-10-16T12:00:00Z");
    expect(board.services.find(s => s.service === "backend")?.health).toBe("unavailable");
    expect(board.overall).toBe("critical");
    expect(board.totalObservations).toBe(1);
  });
});
