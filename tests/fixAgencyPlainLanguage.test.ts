import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const planning = readFileSync("src/modules/workforcePlanning/workforcePlanning.service.ts", "utf8");
const coverage = readFileSync("src/modules/coverage/coverage.service.ts", "utf8");
const operations = readFileSync("src/modules/operations/operations.service.ts", "utf8");

describe("agency-facing texts", () => {
  it("use real Spanish plurals instead of (s)/(es)", () => {
    for (const source of [planning, coverage]) {
      expect(source).not.toMatch(/[a-záéíóúñ]\((s|es)\)/);
    }
    expect(planning).toContain('"1 turno no tiene cuidador confirmado y requiere"');
    expect(planning).toContain('"1 día presenta"');
  });

  it("operational alerts name the resident by preferred name when there is one", () => {
    expect(operations.match(/COALESCE\(NULLIF\(trim\(cr\.preferred_name\), ''\), trim\(concat_ws\(' ', cr\.first_name, cr\.last_name\)\)\) recipient/g)).toHaveLength(2);
  });
});
