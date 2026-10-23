/**
 * Migration rehearsal on an ISOLATED COPY of a database (e.g. production),
 * with guards so it can never write to the source.
 *
 *   1. Source (read-only): every session is forced read-only; pg_dump runs with
 *      default_transaction_read_only=on. The source is only read.
 *   2. Target (disposable): must be an EMPTY database (a new one per run); the
 *      tool marks it with a rehearsal marker table before restoring. Never the same cluster as the source (system
 *      identifier), never a host on the production deny-list.
 *   3. Restore -> snapshot -> apply pending migrations with the repo's runner
 *      (same code as deploys) -> snapshot -> checks -> report.
 *   4. The report contains only counts, names of tables/constraints and timings,
 *      never row data.
 *
 * Usage (only with the owner's authorization when the source is production):
 *   REHEARSAL_SOURCE_URL=postgres://<read-only role>@<source>/<db> \
 *   REHEARSAL_TARGET_URL=postgres://<superuser>@<isolated>/<db> \
 *   REHEARSAL_CONFIRM=TARGET-IS-DISPOSABLE \
 *   [PRODUCTION_DB_HOSTS=host1,host2] [REHEARSAL_REPORT=./rehearsal-report.json] \
 *   npx tsx scripts/rehearsal/rehearseMigrations.ts
 *
 * Local test only: REHEARSAL_ALLOW_SAME_CLUSTER=local-test lets source and
 * target live in one local cluster (127.0.0.1/localhost only).
 *
 * Verified backup (REHEARSAL_MODE=backup: no migrations are applied):
 *   - the dump and the source row counts come from ONE exported snapshot, so
 *     the restored copy must match the source table by table, exactly;
 *   - with BACKUP_PASSPHRASE the dump is kept, encrypted (gpg AES-256), with
 *     its SHA-256; with BACKUP_S3_BUCKET (+ AWS_ENDPOINT_URL, AWS_ACCESS_KEY_ID,
 *     AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION) it is uploaded to a private
 *     bucket, downloaded again and its checksum compared.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyPendingMigrations, listMigrationFiles } from "../lib/runMigrations.js";

const MARKER = "etnara_rehearsal_marker";
/** Hosts that are never a valid TARGET (production). Extend with PRODUCTION_DB_HOSTS. */
const BUILTIN_PRODUCTION_HOSTS = ["etnara-care-staging-db.railway.internal"];
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

export class RehearsalGuardError extends Error {
  constructor(message: string) { super(message); this.name = "RehearsalGuardError"; }
}

type Conn = { url: string; host: string; db: string };
const parse = (url: string): Conn => { const u = new URL(url); return { url, host: u.hostname.toLowerCase(), db: u.pathname.replace(/^\//, "") }; };
const isLocal = (h: string) => h === "127.0.0.1" || h === "localhost" || h === "::1";

async function connect(url: string, readOnly: boolean) {
  const c = new Client({ connectionString: url, ...(readOnly ? { options: "-c default_transaction_read_only=on" } : {}) });
  await c.connect();
  if (readOnly) {
    await c.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    const ro = await c.query<{ transaction_read_only: string }>("SHOW transaction_read_only");
    if (ro.rows[0]?.transaction_read_only !== "on") throw new RehearsalGuardError("source session is not read-only");
  }
  return c;
}
const systemId = async (c: Client) =>
  String((await c.query<{ id: string }>("SELECT system_identifier::text AS id FROM pg_control_system()")).rows[0].id);
const hasMarker = async (c: Client) =>
  (await c.query<{ ok: boolean }>(`SELECT to_regclass('public.${MARKER}') IS NOT NULL AS ok`)).rows[0].ok;
const userTableCount = async (c: Client) =>
  Number((await c.query<{ n: string }>(`SELECT count(*) n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`)).rows[0].n);

/** Every guard, before anything is written anywhere. Exported for the verifier. */
export async function assertSafePair(sourceUrl: string, targetUrl: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.REHEARSAL_CONFIRM !== "TARGET-IS-DISPOSABLE") throw new RehearsalGuardError("REHEARSAL_CONFIRM=TARGET-IS-DISPOSABLE is required");
  if (env.NODE_ENV === "production") throw new RehearsalGuardError("refusing to run with NODE_ENV=production");
  const s = parse(sourceUrl), t = parse(targetUrl);
  const deny = [...BUILTIN_PRODUCTION_HOSTS, ...(env.PRODUCTION_DB_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)];
  if (deny.includes(t.host)) throw new RehearsalGuardError(`target host ${t.host} is on the production deny-list`);
  // PITR mode: the source must be the restored fork, never production itself
  // (no SQL access to the live database at all).
  if (env.REHEARSAL_SOURCE_MUST_NOT_BE_PRODUCTION === "true" && deny.includes(s.host)) {
    throw new RehearsalGuardError(`source host ${s.host} is production; in this mode the source must be the restored copy`);
  }
  if (s.host === t.host && s.db === t.db) throw new RehearsalGuardError("target is the source database");
  const src = await connect(sourceUrl, true);
  const tgt = await connect(targetUrl, false);
  try {
    if (await hasMarker(src)) throw new RehearsalGuardError("source carries the rehearsal marker: it is a rehearsal copy, not a source");
    const [sid, tid] = [await systemId(src), await systemId(tgt)];
    if (sid === tid && !(env.REHEARSAL_ALLOW_SAME_CLUSTER === "local-test" && isLocal(s.host) && isLocal(t.host))) {
      throw new RehearsalGuardError("target lives in the same PostgreSQL cluster as the source");
    }
    // Only an empty database (at most our own marker) is a valid target: a fresh copy per run.
    const tables = await userTableCount(tgt);
    if (tables > ((await hasMarker(tgt)) ? 1 : 0)) {
      throw new RehearsalGuardError("target is not empty: use a new, empty database for every rehearsal");
    }
    const ver = async (c: Client) => {
      const v = Number((await c.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0].v);
      if (!Number.isFinite(v) || v < 100000) throw new RehearsalGuardError("could not read the server version");
      return v;
    };
    return { sourceVersion: await ver(src), targetVersion: await ver(tgt) };
  } finally { await src.end(); await tgt.end(); }
}

async function snapshot(c: Client) {
  const tables = (await c.query<{ t: string }>(
    `SELECT format('%I.%I', schemaname, tablename) t FROM pg_tables WHERE schemaname = 'public' AND tablename <> '${MARKER}' ORDER BY 1`)).rows.map((r) => r.t);
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t] = Number((await c.query<{ n: string }>(`SELECT count(*) n FROM ${t}`)).rows[0].n);
  const hasHistory = (await c.query<{ ok: boolean }>(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok`)).rows[0].ok;
  const migrations = hasHistory ? (await c.query<{ filename: string; applied_at: string }>(
    `SELECT filename, applied_at FROM schema_migrations ORDER BY filename`)).rows : [];
  const policies = Number((await c.query<{ n: string }>(`SELECT count(*) n FROM pg_policies WHERE schemaname='public'`)).rows[0].n);
  const noRls = (await c.query<{ t: string }>(
    `SELECT relname t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity AND relname NOT IN ('schema_migrations','${MARKER}') ORDER BY 1`)).rows.map((r) => r.t);
  return { counts, migrations, policies, tablesWithoutRls: noRls };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, input?: string) {
  const r = spawnSync(cmd, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input });
  if (r.status !== 0) throw new Error(`${cmd} failed (exit ${r.status}): ${(r.stderr || "").split("\n").filter((l) => !/password/i.test(l)).slice(0, 5).join(" | ")}`);
  return r.stdout;
}

async function main() {
  const sourceUrl = process.env.REHEARSAL_SOURCE_URL, targetUrl = process.env.REHEARSAL_TARGET_URL;
  if (!sourceUrl || !targetUrl) throw new RehearsalGuardError("REHEARSAL_SOURCE_URL and REHEARSAL_TARGET_URL are required");
  const versions = await assertSafePair(sourceUrl, targetUrl);
  const dumpMajor = Number((run("pg_dump", ["--version"], process.env).match(/(\d+)\.\d+/) ?? [])[1]);
  if (!Number.isFinite(dumpMajor) || dumpMajor < Math.floor(versions.sourceVersion / 10000)) {
    throw new RehearsalGuardError(`pg_dump ${dumpMajor} is older than the source server (${versions.sourceVersion}); use the same or newer major`);
  }
  if (Math.floor(versions.targetVersion / 10000) !== Math.floor(versions.sourceVersion / 10000)) {
    console.warn(`WARNING: target major ${versions.targetVersion} differs from source ${versions.sourceVersion}; use the production major for a faithful rehearsal.`);
  }
  const mode = process.env.REHEARSAL_MODE === "backup" ? "backup" : "rehearse";
  const report: Record<string, unknown> = { mode, startedAt: new Date().toISOString(), versions };
  const work = mkdtempSync(join(tmpdir(), "etnara-rehearsal-"));
  const dumpFile = join(work, "source.dump");
  try {
    // 1. Read-only, consistent dump: one exported snapshot for the dump AND the source counts.
    const t0 = Date.now();
    const src = await connect(sourceUrl, true);
    await src.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snap = (await src.query<{ s: string }>("SELECT pg_export_snapshot() AS s")).rows[0].s;
    const sourceSnapshot = await snapshot(src);
    const roles = (await src.query<{ r: string }>(
      `SELECT DISTINCT grantee r FROM information_schema.role_table_grants WHERE grantee NOT IN ('PUBLIC') AND grantee NOT LIKE 'pg\\_%'
       UNION SELECT DISTINCT unnest(roles)::text FROM pg_policies WHERE schemaname='public'`)).rows.map((r) => r.r).filter((r) => r !== "public");
    run("pg_dump", ["--format=custom", "--no-owner", `--snapshot=${snap}`, `--file=${dumpFile}`, `--dbname=${sourceUrl}`],
      { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on" });
    await src.query("COMMIT");
    await src.end();
    report.dumpSeconds = (Date.now() - t0) / 1000;
    report.dumpBytes = statSync(dumpFile).size;
    report.sourceMigration = sourceSnapshot.migrations.at(-1)?.filename ?? null;

    // 1b. Optional retained backup: encrypted, checksummed, uploaded and read back.
    const passphrase = process.env.BACKUP_PASSPHRASE;
    if (passphrase) {
      const enc = join(work, "source.dump.gpg");
      run("gpg", ["--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--symmetric", "--cipher-algo", "AES256",
        "--output", enc, dumpFile], process.env, passphrase);
      const sha = createHash("sha256").update(readFileSync(enc)).digest("hex");
      const backup: Record<string, unknown> = { encrypted: "gpg AES256", sha256: sha, bytes: statSync(enc).size };
      const bucket = process.env.BACKUP_S3_BUCKET;
      if (bucket) {
        const key = `etnara-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${backup.sha256 as string}`.slice(0, 120) + ".dump.gpg";
        const endpoint = process.env.AWS_ENDPOINT_URL ? ["--endpoint-url", process.env.AWS_ENDPOINT_URL] : [];
        run("aws", [...endpoint, "s3", "cp", enc, `s3://${bucket}/${key}`, "--only-show-errors"], process.env);
        const back = join(work, "readback.gpg");
        run("aws", [...endpoint, "s3", "cp", `s3://${bucket}/${key}`, back, "--only-show-errors"], process.env);
        const sha2 = createHash("sha256").update(readFileSync(back)).digest("hex");
        backup.object = `s3://${bucket}/${key}`;
        backup.readBackChecksumMatches = sha2 === sha;
      }
      // Decrypting must give back the exact dump (the passphrase works).
      const dec = join(work, "decrypted.dump");
      run("gpg", ["--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--output", dec, "--decrypt", enc], process.env, passphrase);
      backup.decryptMatches = createHash("sha256").update(readFileSync(dec)).digest("hex") === createHash("sha256").update(readFileSync(dumpFile)).digest("hex");
      report.backup = backup;
    }

    // 2. Target: marker first (protects every later run), roles the dump references, restore.
    const tgt = await connect(targetUrl, false);
    await tgt.query(`CREATE TABLE IF NOT EXISTS public.${MARKER} (created_at timestamptz NOT NULL DEFAULT now(), note text)`);
    await tgt.query(`INSERT INTO public.${MARKER} (note) VALUES ('ETNARA migration rehearsal copy -- disposable, delete after use')`);
    for (const role of roles) {
      await tgt.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role.replace(/'/g, "''")}') THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOBYPASSRLS', '${role.replace(/'/g, "''")}'); END IF; END $$`);
    }
    await tgt.end();
    const t1 = Date.now();
    run("pg_restore", ["--no-owner", "--exit-on-error", `--dbname=${targetUrl}`, dumpFile], process.env);
    report.restoreSeconds = (Date.now() - t1) / 1000;

    // 3. The restored copy must equal the source snapshot, table by table.
    const c = await connect(targetUrl, false);
    const before = await snapshot(c);
    const mismatches = [...new Set([...Object.keys(sourceSnapshot.counts), ...Object.keys(before.counts)])]
      .filter((t) => sourceSnapshot.counts[t] !== before.counts[t]);
    report.restoreVerification = {
      tables: Object.keys(sourceSnapshot.counts).length,
      rows: Object.values(sourceSnapshot.counts).reduce((a, b) => a + b, 0),
      policies: { source: sourceSnapshot.policies, copy: before.policies },
      mismatchedTables: mismatches,
      verified: mismatches.length === 0 && sourceSnapshot.policies === before.policies
        && sourceSnapshot.migrations.length === before.migrations.length,
    };
    if (mode === "backup") {
      await c.end();
      const b = report.backup as Record<string, unknown> | undefined;
      report.verdict = (report.restoreVerification as { verified: boolean }).verified
        && (!b || (b.decryptMatches === true && b.readBackChecksumMatches !== false)) ? "PASS" : "REVIEW";
      return finish(report);
    }

    // 4. Migrate on the copy.
    const pending = listMigrationFiles(MIGRATIONS_DIR).filter((f) => !before.migrations.some((m) => m.filename === f));
    report.pendingMigrations = pending;
    const t2 = Date.now();
    let migrationError: string | null = null;
    try { await applyPendingMigrations(c, MIGRATIONS_DIR); } catch (e) { migrationError = (e as Error).message.slice(0, 500); }
    report.migrateSeconds = (Date.now() - t2) / 1000;
    report.migrationError = migrationError;
    const after = await snapshot(c);
    const applied = after.migrations.filter((m) => pending.includes(m.filename));
    report.applied = applied.map((m, i) => ({
      file: m.filename,
      approxSeconds: i + 1 < applied.length ? (new Date(applied[i + 1].applied_at).getTime() - new Date(m.applied_at).getTime()) / 1000 : null,
    }));
    const changed = Object.keys(before.counts).filter((t) => after.counts[t] !== before.counts[t]).map((t) => ({ table: t, before: before.counts[t], after: after.counts[t] }));
    const lost = Object.keys(before.counts).filter((t) => !(t in after.counts));
    report.rowCountChanges = changed;
    report.tablesDropped = lost;
    report.newTables = Object.keys(after.counts).filter((t) => !(t in before.counts));
    report.policies = { before: before.policies, after: after.policies };
    report.tablesWithoutRls = after.tablesWithoutRls;
    // NOT VALID constraints: would existing data pass them? (validated and rolled back)
    const notValid = (await c.query<{ tbl: string; con: string }>(
      `SELECT conrelid::regclass::text tbl, conname con FROM pg_constraint WHERE NOT convalidated AND contype IN ('c','f') ORDER BY 1,2`)).rows;
    const validation: { table: string; constraint: string; ok: boolean }[] = [];
    for (const nv of notValid) {
      await c.query("BEGIN");
      try { await c.query(`ALTER TABLE ${nv.tbl} VALIDATE CONSTRAINT "${nv.con}"`); validation.push({ table: nv.tbl, constraint: nv.con, ok: true }); }
      catch { validation.push({ table: nv.tbl, constraint: nv.con, ok: false }); }
      finally { await c.query("ROLLBACK"); }
    }
    report.notValidConstraints = validation;
    await c.end();
    report.verdict = (report.restoreVerification as { verified: boolean }).verified
      && !migrationError && lost.length === 0 && validation.every((v) => v.ok) && pending.length === applied.length ? "PASS" : "REVIEW";
    return finish(report);
  } finally {
    rmSync(work, { recursive: true, force: true }); // local files never outlive the run
  }
}

function finish(report: Record<string, unknown>) {
  report.finishedAt = new Date().toISOString();
  const out = process.env.REHEARSAL_REPORT ?? "rehearsal-report.json";
  writeFileSync(out, JSON.stringify(report, null, 2));
  // Counts, names and timings only -- safe for logs.
  console.log(`REHEARSAL_REPORT ${JSON.stringify(report)}`);
  console.log(`Rehearsal (${report.mode}) ${report.verdict}${report.applied ? `: ${(report.applied as unknown[]).length} migrations applied in ${report.migrateSeconds}s` : ""}; report: ${out}`);
  if (report.verdict !== "PASS") process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e instanceof RehearsalGuardError ? `REFUSED: ${e.message}` : e); process.exit(1); });
}
