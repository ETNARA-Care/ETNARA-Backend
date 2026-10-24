import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Two migrations with the same number are ambiguous to read and to roll back
// (24-oct-2026: two different 113 files were prepared in parallel). Numbers
// below 088 have known historical duplicates already applied in production;
// from 088 on every number must be unique.
const KNOWN_HISTORICAL = new Set(["035", "037", "038", "051", "052", "066", "067", "068", "070", "081"]);

describe("migration numbers", () => {
  const files = readdirSync("migrations").filter((f) => f.endsWith(".sql"));
  const byNumber = new Map<string, string[]>();
  for (const f of files) byNumber.set(f.slice(0, 3), [...(byNumber.get(f.slice(0, 3)) ?? []), f]);

  it("every file starts with a three-digit number and an underscore", () => {
    for (const f of files) expect(f).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
  });

  it("no number is used twice, except the known historical ones before 088", () => {
    const duplicated = [...byNumber.entries()].filter(([, names]) => names.length > 1).map(([n]) => n);
    expect(duplicated.filter((n) => !KNOWN_HISTORICAL.has(n))).toEqual([]);
    expect(duplicated.every((n) => Number(n) < 88)).toBe(true);
  });

  it("113 is En Camino and 114 is the check-out fix", () => {
    expect(byNumber.get("113")).toEqual(["113_journey_cancel_reassign_offline.sql"]);
    expect(byNumber.get("114")).toEqual(["114_checkout_long_visit_timesheet_review.sql"]);
  });
});
