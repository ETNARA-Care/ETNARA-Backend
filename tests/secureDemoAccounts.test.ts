import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { aliasFor, unusableHash } from "../scripts/secureDemoAccounts.js";
import { verifyPassword } from "../src/security/password.js";

describe("secureDemoAccounts", () => {
  it("builds a +demo alias of the owner's mailbox", () => {
    expect(aliasFor("Owner@Gmail.com", "maria@demo.etnara.care")).toBe("owner+demo-maria@gmail.com");
    expect(() => aliasFor("owner+x@gmail.com", "maria@demo.etnara.care")).toThrow();
    expect(() => aliasFor("not-an-email", "maria@demo.etnara.care")).toThrow();
  });

  it("writes a hash in the app's format that no password verifies", async () => {
    const h = await unusableHash();
    expect(h.startsWith("scrypt$N=16384,r=8,p=1$")).toBe(true);
    expect(await verifyPassword("", h)).toBe(false);
    expect(await verifyPassword("anything-at-all", h)).toBe(false);
  });

  it("simulates by default and only commits with DEMO_ROTATION_APPLY=yes", () => {
    const src = readFileSync(new URL("../scripts/secureDemoAccounts.ts", import.meta.url), "utf8");
    expect(src).toContain('apply: process.env.DEMO_ROTATION_APPLY === "yes"');
    expect(src).toMatch(/else \{ await c\.query\("ROLLBACK"\)/);
  });

  it("demo seeding scripts refuse to run outside a disposable database (guard from #231)", () => {
    for (const f of ["seedDemo.ts", "repairDemoAccess.ts", "createMinimalCaregiverDemo.ts"]) {
      const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), "utf8");
      expect(src, f).toContain("assertDisposableDatabase(");
      expect(src, f).toContain("demoPasswordFromEnv(");
    }
  });

  it("the one-shot rotation function has the approved, fixed targets", () => {
    const fn = readFileSync(new URL("../ops/demo-rotation/apply.function.ts", import.meta.url), "utf8");
    expect(fn).toContain('const EXPECTED_ORG = "febe519d-3504-4488-a741-d962db40be89"');
    expect(fn).toContain('const ALIAS_MAILBOX = "etnaracare@gmail.com"');
    for (const n of ["admin", "carlos", "familia", "maria", "supervisor"]) expect(fn).toContain(`"etnaracare+demo-${n}@gmail.com"`);
    expect(fn).toContain('endsWith(".railway.internal")');
    const sim = readFileSync(new URL("../ops/demo-rotation/simulate.function.ts", import.meta.url), "utf8");
    expect(sim).toContain("apply: false });");
    expect(sim).not.toContain("apply: true");
  });
});
