import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://unused@localhost/unused";

const planning = readFileSync("src/modules/workforcePlanning/workforcePlanning.service.ts", "utf8");
const operations = readFileSync("src/modules/operations/operations.service.ts", "utf8");

describe("coverage means a caregiver accepted", () => {
  it("planning counts a shift as covered only with an accepted assignment", () => {
    expect(planning).toContain("WHERE a.shift_id = s.id AND a.response_status = 'accepted'");
    expect(planning).not.toContain("a.response_status IN ('pending', 'accepted')");
    expect(planning).toContain("Todos los turnos programados tienen un cuidador confirmado.");
  });

  it("operations keeps the same rule: not accepted means uncovered", () => {
    expect(operations).toMatch(/if \(!shift\.accepted\)/);
  });
});

describe("operational alert times", () => {
  it("are formatted in Puerto Rico time, not the server's UTC, without seconds", async () => {
    const { formatShiftStart } = await import("../src/modules/operations/operations.service.js");
    const label = formatShiftStart("2026-10-22T18:14:29Z");
    expect(label).toContain("2:14");
    expect(label).not.toContain(":29");
    expect(label).not.toContain("6:14");
    expect(operations).not.toMatch(/scheduled_start\)\.toLocaleString\("es-PR"\)/);
  });
});
