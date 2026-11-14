import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { checkDatabase } from "../src/modules/health/dbHealth.js";

describe("/health/db — disponibilidad de la base para el monitor externo", () => {
  it("responde ok cuando la base contesta", async () => {
    expect(await checkDatabase(async () => ({ rows: [{ "?column?": 1 }] }))).toBe(true);
  });
  it("falla cuando la consulta da error, sin propagar el mensaje", async () => {
    expect(await checkDatabase(async () => { throw new Error("password authentication failed for host x"); })).toBe(false);
  });
  it("falla por tiempo cuando la base no responde", async () => {
    const t0 = Date.now();
    expect(await checkDatabase(() => new Promise(() => undefined), 100)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("/health (healthcheck de Railway) sigue sin tocar la base y /health/db responde 200/503 sin detalles", () => {
    const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    expect(app).toContain('app.get("/health",(_req,res)=>{res.status(200).json({status:"ok"});});');
    expect(app).toContain('res.status(ok?200:503).json({status:ok?"ok":"unavailable"})');
  });
});
