import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routes = readFileSync("src/modules/auth/auth.routes.ts", "utf8");
const reset = routes.slice(routes.indexOf('router.post("/auth/password-reset/request"'), routes.indexOf('router.post("/auth/password-reset/confirm"'));

describe("password reset request (PR 0)", () => {
  it("answers before doing any account work, so timing reveals nothing", () => {
    expect(reset.indexOf('res.status(200).json({ ok: true });')).toBeLessThan(reset.indexOf("requestPasswordReset("));
    expect(reset).toMatch(/setImmediate\(\(\) => \{\s+requestPasswordReset\(parsed\.data\.email\)\.catch/);
    expect(reset).not.toMatch(/await requestPasswordReset/);
  });

  it("has its own rate-limit counter, separate from login", () => {
    expect(reset).toMatch(/const limitKey = `reset:\$\{parsed\.data\.email\}`;/);
    expect(reset).toMatch(/checkLimit\(req, res, limitKey\)/);
    expect(reset).not.toMatch(/checkLimit\(req, res, parsed\.data\.email\)/);
  });

  it("never logs the address or the error message", () => {
    expect(reset).not.toMatch(/console\.\w+\([^)]*email/);
    expect(reset).toMatch(/\{ name: e\?\.name \?\? "Error", code:/);
  });
});
