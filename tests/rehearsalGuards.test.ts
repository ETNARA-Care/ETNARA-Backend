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
  it("PITR mode: refuses production as the SOURCE (only the restored fork may be read)", async () => {
    await expect(assertSafePair("postgres://x@etnara-care-staging-db.railway.internal:5432/railway", "postgres://x@iso.example.invalid/db",
      { ...ok, REHEARSAL_SOURCE_MUST_NOT_BE_PRODUCTION: "true" })).rejects.toThrow(/source host .* is production/);
  });
  it("PITR mode: refuses a source that is an alias of production (same address over DNS)", async () => {
    await expect(assertSafePair("postgres://x@localhost:5432/copy", "postgres://x@iso.example.invalid/db",
      { ...ok, REHEARSAL_SOURCE_MUST_NOT_BE_PRODUCTION: "true", PRODUCTION_DB_HOSTS: "127.0.0.1" })).rejects.toThrow(/resolves to the production address/);
  });
  it("refuses target = source", async () => {
    await expect(assertSafePair(src, src, ok)).rejects.toThrow(/target is the source/);
  });
});
