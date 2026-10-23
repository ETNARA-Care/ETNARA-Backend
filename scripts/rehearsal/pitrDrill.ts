/**
 * PITR drill in STAGING (synthetic data only). Two stages, one per run:
 *
 *  DRILL_STAGE=seed    Create database `prodshape` on the staging server in the
 *                      production state (all migrations up to 087, demo seed).
 *                      Never runs bootstrap (it would rotate app_runtime's
 *                      cluster-wide password used by the staging API).
 *  DRILL_STAGE=verify  After PITR restore: fingerprint ORIGINAL vs COPY,
 *                      apply 088 ONLY on the copy, prove the original did not
 *                      change, run check088 on the copy.
 *
 * URLs: DRILL_ORIG_ADMIN_URL (original server, db "railway"), DRILL_ORIG_PRODSHAPE_URL,
 *       DRILL_COPY_PRODSHAPE_URL, DRILL_COPY_RAILWAY_URL (verify), DRILL_ORIG_RAILWAY_URL (verify).
 */
import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyPendingMigrations } from "../lib/runMigrations.js";
import { fingerprint } from "./fingerprint.js";
import { check088 } from "./check088.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const PRODUCTION_HOSTS = ["etnara-care-staging-db.railway.internal"];
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };
const host = (u: string) => new URL(u).hostname;
const out = (k: string, v: unknown) => console.log(`${k} ${JSON.stringify(v)}`);

async function refuseProduction(...urls: string[]) {
  for (const u of urls) if (PRODUCTION_HOSTS.includes(host(u))) throw new Error(`refused: production host ${host(u)}`);
}
async function addrs(h: string) { try { return (await lookup(h, { all: true })).map((a) => a.address); } catch { return []; } }

async function seed() {
  const admin = need("DRILL_ORIG_ADMIN_URL"), prodshape = need("DRILL_ORIG_PRODSHAPE_URL");
  await refuseProduction(admin, prodshape);
  if (new URL(prodshape).pathname !== "/prodshape") throw new Error("prodshape URL must point at database prodshape");
  const c = new Client({ connectionString: admin }); await c.connect();
  const exists = (await c.query(`SELECT 1 FROM pg_database WHERE datname='prodshape'`)).rowCount;
  if (exists && process.env.DRILL_RESEED !== "1") throw new Error("prodshape already exists: set DRILL_RESEED=1 to recreate it (synthetic drill database only)");
  if (exists) await c.query(`DROP DATABASE prodshape WITH (FORCE)`);
  await c.query(`CREATE DATABASE prodshape`);
  await c.end();
  // Production state = every migration up to 087 (088 excluded), applied with the repo's runner.
  const dir = mkdtempSync(join(tmpdir(), "mig087-"));
  for (const f of readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) <= 87)) cpSync(join(MIGRATIONS, f), join(dir, f));
  const p = new Client({ connectionString: prodshape }); await p.connect();
  await applyPendingMigrations(p, dir);
  await p.end();
  const s = spawnSync("npx", ["tsx", "scripts/seedDemo.ts"], { env: { ...process.env, DATABASE_URL: prodshape }, encoding: "utf8" });
  if (s.status !== 0) throw new Error(`seedDemo failed: ${(s.stderr || s.stdout || "").split("\n").filter((l) => l.trim() && !/password/i.test(l)).slice(0, 6).join(" | ")}`);
  const f = await fingerprint(prodshape);
  out("DRILL_SEED", { lastMigration: f.lastMigration, tables: f.tables, rows: f.rows, dataHash: f.dataHash, schemaHash: f.schemaHash, policies: f.policies, timeline: f.timeline });
}

async function verify() {
  const origRailway = need("DRILL_ORIG_RAILWAY_URL"), origShape = need("DRILL_ORIG_PRODSHAPE_URL");
  const copyRailway = need("DRILL_COPY_RAILWAY_URL"), copyShape = need("DRILL_COPY_PRODSHAPE_URL");
  await refuseProduction(origRailway, origShape, copyRailway, copyShape);
  // The copy must be a different server than the original (also over DNS).
  // DRILL_LOCAL_TEST=1 (127.0.0.1 only) lets both live in one local cluster for the local test.
  const local = process.env.DRILL_LOCAL_TEST === "1" && ["127.0.0.1", "localhost"].includes(host(copyShape));
  if (!local) {
    if (host(copyShape) === host(origShape)) throw new Error("copy and original are the same host");
    const origA = await addrs(host(origShape));
    if ((await addrs(host(copyShape))).some((a) => origA.includes(a))) throw new Error("copy resolves to the original's address");
  }

  const strip = (f: Awaited<ReturnType<typeof fingerprint>>) => ({ tables: f.tables, rows: f.rows, dataHash: f.dataHash, schemaHash: f.schemaHash, lastMigration: f.lastMigration, policies: f.policies, timeline: f.timeline });
  const o1 = await fingerprint(origShape), c1 = await fingerprint(copyShape);
  const or = await fingerprint(origRailway), cr = await fingerprint(copyRailway);
  out("DRILL_BEFORE", { origProdshape: strip(o1), copyProdshape: strip(c1), origRailway: strip(or), copyRailway: strip(cr) });
  const expected = process.env.DRILL_EXPECT_ORIG_DATAHASH;
  const report: Record<string, unknown> = {
    copyEqualsOriginal_prodshape: o1.dataHash === c1.dataHash && o1.schemaHash === c1.schemaHash,
    copyTimelineAboveOriginal: (c1.timeline ?? 0) > (o1.timeline ?? 0),
    railwaySchemaEqual: or.schemaHash === cr.schemaHash,
    railwayTablesDiffering: Object.keys(or.perTable).filter((t) => or.perTable[t]?.hash !== cr.perTable[t]?.hash),
    originalUnchangedSinceSeed: expected ? o1.dataHash === expected : null,
  };

  // 088 on the COPY only, with the repo's runner (this image's migrations end at 088).
  const t0 = Date.now();
  const p = new Client({ connectionString: copyShape }); await p.connect();
  await applyPendingMigrations(p, MIGRATIONS);
  await p.end();
  report.migrate088Seconds = (Date.now() - t0) / 1000;
  const c2 = await fingerprint(copyShape), o2 = await fingerprint(origShape);
  const changedTables = Object.keys(c1.perTable).filter((t) => c1.perTable[t].hash !== c2.perTable[t]?.hash);
  report.copyAfter088 = { lastMigration: c2.lastMigration, policies: { before: c1.policies, after: c2.policies }, tablesWithChangedData: changedTables };
  report.dataUnchangedBy088 = changedTables.length === 1 && changedTables[0] === "public.schema_migrations";
  report.originalUntouchedAfterDrill = o2.dataHash === o1.dataHash && o2.schemaHash === o1.schemaHash && o2.lastMigration === "087_offline_check_in_out.sql";

  const checks = await check088(copyShape, host(copyShape));
  report.check088 = `${checks.filter((r) => r.pass).length}/${checks.length}`;
  report.check088Failures = checks.filter((r) => !r.pass).map((r) => `${r.name}: ${r.detail}`);
  report.verdict = report.copyEqualsOriginal_prodshape && report.dataUnchangedBy088 && report.originalUntouchedAfterDrill
    && report.railwaySchemaEqual && (report.originalUnchangedSinceSeed !== false) && checks.every((r) => r.pass) ? "PASS" : "REVIEW";
  out("DRILL_REPORT", report);
  if (report.verdict !== "PASS") process.exitCode = 2;
}

(process.env.DRILL_STAGE === "seed" ? seed() : process.env.DRILL_STAGE === "verify" ? verify() : Promise.reject(new Error("DRILL_STAGE must be seed|verify")))
  .catch((e) => { console.error(`DRILL_ERROR ${(e as Error).message}`); process.exit(1); });
