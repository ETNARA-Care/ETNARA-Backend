/**
 * 149 — reversión verificada en bases DESECHABLES (datos ficticios):
 *  R1 la reversión deja el esquema (tablas, funciones, triggers, políticas, permisos) idéntico al de 148;
 *  R2 no toca datos: documentos (incluidas decisiones históricas de Central), credenciales,
 *     revisiones y versiones quedan idénticos;
 *  R3 volver a aplicar 149 después de revertirla funciona y deja el mismo esquema que una 149 limpia;
 *  R4 aplicar 149 dos veces es idempotente.
 *  R5 huella de TODAS las filas de TODAS las tablas (demo sembrada + historial ficticio): idéntica antes
 *     de aplicar 149, después de aplicarla y después de revertirla (solo cambia schema_migrations).
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { execFileSync } from "node:child_process";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });
const ROLLBACK = readFileSync("ops/149_agency_document_responsibility.rollback.sql", "utf8");
const MIGRATION = readFileSync("migrations/149_agency_document_responsibility.sql", "utf8");
const ALL = join(process.cwd(), "migrations");
const diff = (a: string, b: string) => { const x = new Set(JSON.parse(a) as string[]), y = new Set(JSON.parse(b) as string[]); return { onlyIn148: [...x].filter((k) => !y.has(k)).slice(0, 5), onlyAfter: [...y].filter((k) => !x.has(k)).slice(0, 5) }; };
const quiet = async <T>(fn: () => Promise<T>) => { const log = console.log; console.log = () => undefined; try { return await fn(); } finally { console.log = log; } };

async function main() {
  const tag = randomUUID().slice(0, 8);
  const server = new pg.Client({ connectionString: adminUrl }); await server.connect();
  const dir = (max: number) => {
    const d = mkdtempSync(join(tmpdir(), `etnara-${max}-`));
    for (const f of readdirSync(ALL).filter((f) => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) <= max)) copyFileSync(join(ALL, f), join(d, f));
    return d;
  };
  const upTo148 = dir(148), upTo149 = dir(149);
  const dbs: string[] = [];
  const newDb = async (suffix: string) => {
    const name = `etnara_rb149_${suffix}_${tag}`; await server.query(`CREATE DATABASE ${name}`); dbs.push(name);
    const u = new URL(adminUrl!); u.pathname = `/${name}`; const c = new pg.Client({ connectionString: u.toString() }); await c.connect(); return c;
  };
  const migrate = (c: pg.Client, d: string) => quiet(() => applyPendingMigrations(c, d));
  const snapshot = async (c: pg.Client) => JSON.stringify((await c.query(`
    SELECT 'table:'||c.relname||':rls='||c.relrowsecurity AS k FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
    UNION ALL SELECT 'fn:'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||'):definer='||p.prosecdef||':'||md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
    UNION ALL SELECT 'trigger:'||c.relname||':'||t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
    UNION ALL SELECT 'policy:'||tablename||':'||policyname||':'||cmd||':'||permissive||':'||coalesce(qual,'')||':'||coalesce(with_check,'') FROM pg_policies WHERE schemaname='public'
    UNION ALL SELECT 'grant:'||table_name||':'||grantee||':'||privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('app_runtime','PUBLIC')
    UNION ALL SELECT 'colgrant:'||table_name||':'||column_name||':'||grantee||':'||privilege_type FROM information_schema.column_privileges WHERE table_schema='public' AND grantee='app_runtime' AND table_name IN ('establishment_documents','credentials','organization_credential_reviews')
    ORDER BY 1`)).rows.map((r) => r.k));
  const data = async (c: pg.Client) => JSON.stringify((await c.query(`
    SELECT 'ed:'||id||':'||review_status||':'||coalesce(reviewed_by_user_id::text,'')||':'||coalesce(reviewed_at::text,'')||':'||coalesce(review_reason,'')||':'||coalesce(archived_at::text,'') k FROM establishment_documents
    UNION ALL SELECT 'cr:'||id||':'||status||':'||coalesce(expires_at::text,'')||':'||coalesce(document_id::text,'') FROM credentials
    UNION ALL SELECT 'ocr:'||id||':'||review_status||':'||reviewed_by_user_id FROM organization_credential_reviews
    UNION ALL SELECT 'odvr:'||id||':'||review_status FROM organization_document_version_reviews
    ORDER BY 1`)).rows.map((r) => r.k));
  /** md5 of every row of every public table except the migration log. */
  const fingerprint = async (c: pg.Client) => {
    const tables = (await c.query<{ t: string }>(`SELECT c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'schema_migrations' ORDER BY 1`)).rows.map((r) => r.t);
    const parts: string[] = []; let rows = 0;
    for (const t of tables) {
      const r = (await c.query<{ h: string | null; n: number }>(`SELECT md5(string_agg(md5(x::text), '' ORDER BY md5(x::text))) h, count(*)::int n FROM "${t}" x`)).rows[0];
      parts.push(`${t}:${r.n}:${r.h ?? "-"}`); rows += r.n;
    }
    return { hash: parts.join("|"), tables: tables.length, rows };
  };
  /** Fictitious agency with history from before 149 (a Central decision, a credential and its review). */
  const seed = async (c: pg.Client) => {
    const org = (await c.query(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`RB149 ${tag}`])).rows[0].id;
    const loc = (await c.query(`INSERT INTO locations (organization_id,name) VALUES ($1,'Hogar ficticio') RETURNING id`, [org])).rows[0].id;
    const reviewer = (await c.query(`INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id`, [`rb149-central-${tag}@example.invalid`])).rows[0].id;
    const mgr = (await c.query(`INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id`, [`rb149-mgr-${tag}@example.invalid`])).rows[0].id;
    const cgUser = (await c.query(`INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id`, [`rb149-cg-${tag}@example.invalid`])).rows[0].id;
    await c.query(`INSERT INTO establishment_documents (organization_id,establishment_id,document_type,title,file_name,content_type,size_bytes,storage_key,review_status,reviewed_by_user_id,reviewed_at,review_reason)
      VALUES ($1,$2,'insurance','Póliza','p.pdf','application/pdf',1,$3,'approved',$4,'2026-10-20','')`, [org, loc, `rb149/${tag}/p.pdf`, reviewer]);
    const w = (await c.query(`INSERT INTO workers (user_id,display_name) VALUES ($1,'CNA ficticia') RETURNING id`, [cgUser])).rows[0].id;
    await c.query(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','CNA')`, [w, org]);
    const cred = (await c.query(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) SELECT $1,id,'government','active','2027-12-31' FROM credential_types WHERE code='CPR' RETURNING id`, [w])).rows[0].id;
    await c.query(`INSERT INTO organization_credential_reviews (credential_id,organization_id,reviewed_by_user_id,review_status,reviewed_at) VALUES ($1,$2,$3,'approved',now())`, [cred, org, mgr]);
  };

  try {
    // Reference: a clean database up to 148, and one up to 149.
    const ref148 = await newDb("ref148"); await migrate(ref148, upTo148); const s148 = await snapshot(ref148);
    const ref149 = await newDb("ref149"); await migrate(ref149, upTo149); const s149 = await snapshot(ref149);

    const a = await newDb("a");
    await migrate(a, upTo148); await seed(a);
    // The demo agency (Casa Demo shape) as the seed script creates it, as the migrations superuser.
    const ua = new URL(adminUrl!); ua.pathname = `/etnara_rb149_a_${tag}`;
    execFileSync("npx", ["tsx", "scripts/seedDemo.ts"], { env: { ...process.env, DATABASE_URL: ua.toString(), DEMO_PASSWORD: randomUUID() }, stdio: "ignore" });
    const before = await data(a);
    const fpBefore = await fingerprint(a);
    const demoRows = (await a.query<{ o: number; w: number; s: number }>(`SELECT (SELECT count(*) FROM organizations WHERE name LIKE '%Demo%')::int o, (SELECT count(*) FROM workers)::int w, (SELECT count(*) FROM shifts)::int s`)).rows[0];
    await migrate(a, upTo149);
    const after149 = await data(a);
    const fpAfter = await fingerprint(a);
    await migrate(a, upTo149); // R4 idempotent (already registered: skipped) and re-running the SQL itself
    await a.query(MIGRATION);
    const twice = await snapshot(a);
    check("R4 149 is idempotent (registered twice and its SQL run again) and does not change any data on apply", twice === s149 && after149 === before, `schema=${twice === s149} data=${after149 === before}`);

    await a.query(ROLLBACK);
    const fpRolled = await fingerprint(a);
    check("R5 every row of every table (seeded demo agency + fictitious history: Central decisions, credentials, reviews, versions) is identical before 149, after 149 and after its rollback",
      fpBefore.hash === fpAfter.hash && fpBefore.hash === fpRolled.hash && demoRows.o >= 1 && demoRows.w >= 2 && demoRows.s >= 1, `tables=${fpBefore.tables} rows=${fpBefore.rows} demo=${JSON.stringify(demoRows)} apply=${fpBefore.hash === fpAfter.hash} rollback=${fpBefore.hash === fpRolled.hash}`);
    const sRolled = await snapshot(a);
    const dRolled = await data(a);
    const registered = (await a.query(`SELECT 1 FROM schema_migrations WHERE filename='149_agency_document_responsibility.sql'`)).rowCount;
    check("R1 the rollback leaves the schema (tables, functions, triggers, policies, table and column grants) identical to 148 and unregisters 149",
      sRolled === s148 && registered === 0, `identical=${sRolled === s148} registered=${registered} diff=${JSON.stringify(diff(s148, sRolled))}`);
    check("R2 the rollback touches no data: establishment documents (with Central's historical decision), credentials, reviews and version reviews are identical", dRolled === before, `identical=${dRolled === before}`);

    await migrate(a, upTo149);
    const sAgain = await snapshot(a);
    check("R3 applying 149 again after the rollback works and gives the same schema as a clean 149; data still identical", sAgain === s149 && (await data(a)) === before, `schema=${sAgain === s149}`);
    for (const c of [ref148, ref149, a]) await c.end();
  } finally {
    for (const d of dbs) await server.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => undefined);
    await server.end();
    rmSync(upTo148, { recursive: true, force: true }); rmSync(upTo149, { recursive: true, force: true });
  }
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name} — ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nAGENCY_DOCUMENT_RESPONSIBILITY_ROLLBACK ${results.length - failed}/${results.length}`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
