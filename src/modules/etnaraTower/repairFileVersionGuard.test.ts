import { describe, expect, it } from "vitest";
import { validateRepairFileVersions } from "./repairFileVersionGuard.js";
const file = { path: "src/modules/etnaraTower/tower.routes.ts", expectedBlobSha: "a".repeat(40) };
describe("repair file version guard", () => {
  it("requires a valid expected Git blob SHA", () => {
    expect(validateRepairFileVersions([file])).toEqual([file]);
    expect(validateRepairFileVersions([{ ...file, expectedBlobSha: "bad" }])).toBeNull();
  });
  it("rejects duplicates, paths outside the Tower and unknown fields", () => {
    expect(validateRepairFileVersions([file, file])).toBeNull();
    expect(validateRepairFileVersions([{ ...file, path: "../.env" }])).toBeNull();
    expect(validateRepairFileVersions([{ ...file, overwrite: true }])).toBeNull();
    expect(validateRepairFileVersions([])).toBeNull();
  });
});
