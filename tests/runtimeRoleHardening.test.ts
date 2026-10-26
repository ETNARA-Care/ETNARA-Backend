import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MANIFEST_PATH, manifestText } from "../scripts/generateRuntimePrivilegeManifest.js";

const read = (p: string) => readFileSync(p, "utf8");

describe("Security audit 26-oct — the backend must run as app_runtime", () => {
  it("the runtime privilege manifest matches the code (regenerate it when queries change)", () => {
    expect(read(MANIFEST_PATH)).toBe(manifestText());
  });
  it("the database role is checked before the server listens; refusal is opt-in with REQUIRE_RESTRICTED_DB_ROLE", () => {
    const index = read("src/index.ts");
    expect(index.indexOf("await startupDatabaseCheck(")).toBeGreaterThan(-1);
    expect(index.indexOf("await startupDatabaseCheck(")).toBeLessThan(index.indexOf("app.listen("));
    expect(index).toContain('requireRestricted: process.env.REQUIRE_RESTRICTED_DB_ROLE === "true"');
    expect(index).toContain('failClosed: process.env.DB_STARTUP_FAIL_CLOSED === "true"');
  });
  it("the startup check is read-only, logs no connection string and only exits with the opt-in variables", () => {
    const s = read("src/config/dbRuntimeRole.ts").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(s).toContain('BEGIN TRANSACTION READ ONLY');
    expect(s).not.toMatch(/query(?:<[^>]*>)?\(\s*[`"']\s*(INSERT|UPDATE|DELETE|ALTER|GRANT|REVOKE|CREATE|DROP|SET ROLE)\b/i);
    expect(s).not.toMatch(/log\([^)]*connectionString/);
    expect(s).toMatch(/DB_STARTUP_CHECK FAIL[\s\S]*if \(opts\.failClosed\) return exit\(1\);\s*return \{ role: null, readiness: null \}/);
    // every exit is behind an opt-in flag
    const exits = [...s.matchAll(/exit\(1\)/g)].length;
    const guarded = [...s.matchAll(/if \(opts\.(failClosed|requireRestricted)\)[^\n]*exit\(1\)/g)].length;
    expect(exits).toBe(guarded);
  });
  it("the bootstrap keeps using MIGRATIONS_DATABASE_URL (postgres) for migrations and role setup", () => {
    const b = read("scripts/bootstrapStaging.ts");
    expect(b).toContain("process.env.MIGRATIONS_DATABASE_URL");
    expect(b).not.toMatch(/process\.env\.DATABASE_URL\b(?!\s*:)/);
  });
});
