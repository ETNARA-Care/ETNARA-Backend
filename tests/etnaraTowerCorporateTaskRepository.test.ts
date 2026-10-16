import { describe, expect, it } from "vitest";
import { normalizeCorporateTaskLimit } from "../src/modules/etnaraTower/corporateTaskRepository.js";

describe("corporate task repository query bounds", () => {
  it("accepts safe page limits", () => {
    expect(normalizeCorporateTaskLimit(1)).toBe(1);
    expect(normalizeCorporateTaskLimit(100)).toBe(100);
  });
  it("rejects unbounded, fractional and invalid limits", () => {
    for (const limit of [0, 101, -1, 1.5, NaN, Infinity]) {
      expect(normalizeCorporateTaskLimit(limit)).toBeNull();
    }
  });
});
