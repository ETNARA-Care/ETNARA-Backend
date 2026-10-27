import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertDisposableDatabase, demoPasswordFromEnv, MIN_DEMO_PASSWORD_LENGTH } from "../scripts/lib/disposableDatabase.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = ["scripts/seedDemo.ts", "scripts/repairDemoAccess.ts", "scripts/createMinimalCaregiverDemo.ts"];
const ok = { ETNARA_DISPOSABLE_DB: "true" } as NodeJS.ProcessEnv;
const strong = "x".repeat(MIN_DEMO_PASSWORD_LENGTH);

describe("assertDisposableDatabase", () => {
  it("accepts local disposable databases", () => {
    for (const url of [
      "postgres://postgres@localhost:5432/etnara_ci",
      "postgres://postgres@127.0.0.1:5440/x",
      "postgres://postgres@[::1]:5432/x",
      "postgres://postgres@db:5432/x",
      "postgres://postgres@/x?host=/var/run/postgresql",
    ]) expect(() => assertDisposableDatabase(url, ok)).not.toThrow();
  });

  it("refuses production-like hosts even with ETNARA_DISPOSABLE_DB=true", () => {
    for (const url of [
      "postgres://postgres:pw@etnara-care-staging-db.railway.internal:5432/railway",
      "postgres://postgres:pw@monorail.proxy.rlwy.net:12345/railway",
      "postgres://u:pw@db.example.com:5432/x",
      "postgres://u:pw@10.0.0.5:5432/x",
      "postgres://u:pw@abc.supabase.co:5432/x",
    ]) expect(() => assertDisposableDatabase(url, ok)).toThrow(/disposable local database/);
  });

  it("refuses without the explicit flag, in production mode, inside Railway, or without a URL", () => {
    const local = "postgres://postgres@localhost/x";
    expect(() => assertDisposableDatabase(local, {} as NodeJS.ProcessEnv)).toThrow(/ETNARA_DISPOSABLE_DB/);
    expect(() => assertDisposableDatabase(local, { ...ok, NODE_ENV: "production" })).toThrow(/NODE_ENV/);
    expect(() => assertDisposableDatabase(local, { ...ok, RAILWAY_ENVIRONMENT: "production" })).toThrow(/Railway/);
    expect(() => assertDisposableDatabase(local, { ...ok, RAILWAY_PROJECT_ID: "p" })).toThrow(/Railway/);
    expect(() => assertDisposableDatabase(undefined, ok)).toThrow(/connection string/);
    expect(() => assertDisposableDatabase("not a url", ok)).toThrow(/valid URL/);
  });
});

describe("demoPasswordFromEnv", () => {
  it("requires DEMO_PASSWORD of at least 16 characters (the published one was shorter)", () => {
    expect(() => demoPasswordFromEnv({} as NodeJS.ProcessEnv)).toThrow(/DEMO_PASSWORD/);
    expect(() => demoPasswordFromEnv({ DEMO_PASSWORD: "x".repeat(MIN_DEMO_PASSWORD_LENGTH - 1) } as NodeJS.ProcessEnv)).toThrow(/DEMO_PASSWORD/);
    expect(demoPasswordFromEnv({ DEMO_PASSWORD: strong } as NodeJS.ProcessEnv)).toBe(strong);
  });
});

describe("demo scripts", () => {
  it.each(SCRIPTS)("%s has no hard-coded password and guards before connecting", (file) => {
    const src = readFileSync(join(root, file), "utf8");
    expect(src).not.toMatch(/DEMO_PASSWORD\s*=\s*["'`]/);
    expect(src).not.toMatch(/password\s+[A-Z][a-z]+\d{3,}!/); // no literal password in comments either
    const guard = src.indexOf("assertDisposableDatabase(");
    const connect = src.indexOf("new Client(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(connect);
    expect(src.indexOf("demoPasswordFromEnv(")).toBeGreaterThan(-1);
  });

  // Real processes: each script must stop before opening any connection when pointed at production.
  const prodUrl = "postgres://postgres:pw@etnara-care-staging-db.railway.internal:5432/railway";
  const run = (file: string, env: Record<string, string>) => {
    try {
      execFileSync("npx", ["tsx", join(root, file)], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdio: "pipe", timeout: 60_000 });
      return "ran";
    } catch (e) {
      return String((e as { stderr?: Buffer }).stderr ?? "");
    }
  };
  it.each(SCRIPTS)("%s refuses a production database, even with ETNARA_DISPOSABLE_DB=true", (file) => {
    const out = run(file, { ETNARA_DISPOSABLE_DB: "true", DATABASE_URL: prodUrl, MIGRATIONS_DATABASE_URL: prodUrl, DEMO_PASSWORD: strong });
    expect(out).toMatch(/disposable local database: hosted database refused/);
    expect(out).not.toMatch(/ENOTFOUND|ECONNREFUSED|getaddrinfo/); // never tried to connect
  }, 70_000);
  it.each(SCRIPTS)("%s refuses inside Railway (railway run)", (file) => {
    const local = "postgres://postgres@localhost:1/none";
    const out = run(file, { ETNARA_DISPOSABLE_DB: "true", RAILWAY_ENVIRONMENT: "production", DATABASE_URL: local, MIGRATIONS_DATABASE_URL: local, DEMO_PASSWORD: strong });
    expect(out).toMatch(/running inside Railway/);
  }, 70_000);
  it.each(SCRIPTS)("%s refuses a short DEMO_PASSWORD", (file) => {
    const local = "postgres://postgres@localhost:1/none";
    const out = run(file, { ETNARA_DISPOSABLE_DB: "true", DATABASE_URL: local, MIGRATIONS_DATABASE_URL: local, DEMO_PASSWORD: "short1!" });
    expect(out).toMatch(/DEMO_PASSWORD with at least 16 characters/);
    expect(out).not.toMatch(/ECONNREFUSED/);
  }, 70_000);
});
