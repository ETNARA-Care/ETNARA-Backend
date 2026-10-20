import { describe, expect, it } from "vitest";
import { buildAxelHealthSummary } from "../src/modules/etnaraTower/axelHealthSummary.js";
import type { TowerStatusBoard } from "../src/modules/etnaraTower/statusBoard.js";

describe("AXEL read-only health summary", () => {
  it("contains service status and timestamps but not raw summaries or alerts", () => {
    const board: TowerStatusBoard = {
      generatedAt: "2026-10-19T23:00:00.000Z",
      overall: "attention",
      services: [{
        service: "backend",
        health: "healthy",
        checkedAt: "2026-10-19T23:00:00.000Z",
        summary: "sensitive diagnostic text must not be forwarded",
      }],
      alerts: [],
      totalObservations: 1,
    };
    const output = buildAxelHealthSummary(board);
    expect(output).toContain('"service":"backend"');
    expect(output).toContain('"health":"healthy"');
    expect(output).not.toContain("sensitive diagnostic text");
    expect(output).not.toContain('"alerts"');
  });
});
