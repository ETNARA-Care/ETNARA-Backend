import { describe, expect, it } from "vitest";
import { assertSafePair } from "../scripts/rehearsal/rehearseMigrations.js";

const ok = { REHEARSAL_CONFIRM: "TARGET-IS-DISPOSABLE" } as NodeJS.ProcessEnv;
const src = "postgres://ro@source.example.invalid:5432/railway";

describe("migration rehearsal guards (before any connection)", () => {
  it("requires the explicit confirmation", async () => {
    await expect(assertSafePair(src, "postgres://x@iso.example.invalid/db", {} as NodeJS.ProcessEnv)).rejects.toThrow(/REHEARSAL_CONFIRM/);
  });
  it("never runs with NODE_ENV=production", async () => {
    await expect(assertSafePair(src, "postgres://x@iso.example.invalid/db", { ...ok, NODE_ENV: "production" })).rejects.toThrow(/NODE_ENV=production/);
  });
  it("refuses the production database host as target (built-in and configured)", async () => {
    await expect(assertSafePair(src, "postgres://x@etnara-care-staging-db.railway.internal:5432/railway", ok)).rejects.toThrow(/deny-list/);
    await expect(assertSafePair(src, "postgres://x@prod.example.invalid/db", { ...ok, PRODUCTION_DB_HOSTS: "prod.example.invalid" })).rejects.toThrow(/deny-list/);
  });
  it("refuses target = source", async () => {
    await expect(assertSafePair(src, src, ok)).rejects.toThrow(/target is the source/);
  });
});
