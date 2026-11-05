/**
 * Reversión verificada de una migración (150, 151…) en bases DESECHABLES con datos ficticios.
 *   R1 la reversión deja el esquema (tablas, columnas, restricciones, funciones, triggers, políticas,
 *      permisos de tabla y de columna) idéntico al de la migración anterior y la desregistra;
 *   R2 huella de TODAS las filas de TODAS las tablas (agencia demo sembrada + historial ficticio),
 *      sobre las columnas que existían antes: idéntica antes de aplicar, después y tras revertir;
 *   R3 volver a aplicarla después de revertir da el mismo esquema que una aplicación limpia;
 *   R4 aplicarla dos veces es idempotente.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> \
 *     npx tsx scripts/verifyMigrationRollback.ts 150
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");
const N = Number(process.argv[2]);
if (!Number.isInteger(N) || N < 150) throw new Error("usage: verifyMigrationRollback.ts <number ≥150>");
const ALL = join(process.cwd(), "migrations");
const file = readdirSync(ALL).find((f) => f.startsWith(`${N}_`))!;
const MIGRATION = readFileSync(join(ALL, file), "utf8");
const ROLLBACK = readFileSync(join("ops", file.replace(/\.sql$/, ".rollback.sql")), "utf8");
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });
const quiet = async <T>(fn: () => Promise<T>) => { const log = console.log; console.log = () => undefined; try { return await fn(); } finally { console.log = log; } };

async function main() {
  const tag = randomUUID().slice(0, 8);
  const server = new pg.Client({ connectionString: adminUrl }); await server.connect();
  const dir = (max: number) => { const d = mkdtempSync(join(tmpdir(), `etnara-${max}-`)); for (const f of readdirSync(ALL).filter((f) => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) <= max)) copyFileSync(join(ALL, f), join(d, f)); return d; };
  const upToPrev = dir(N - 1), upToN = dir(N);
  const dbs: string[] = [];
  const newDb = async (s: string) => { const name = `etnara_rb${N}_${s}_${tag}`; await server.query(`CREATE DATABASE ${name}`); dbs.push(name); const u = new URL(adminUrl!); u.pathname = `/${name}`; const c = new pg.Client({ connectionString: u.toString() }); await c.connect(); return { c, url: u.toString() }; };
  const migrate = (c: pg.Client, d: string) => quiet(() => applyPendingMigrations(c, d));
  const snapshot = async (c: pg.Client) => JSON.stringify((await c.query(`
    SELECT 'table:'||c.relname||':rls='||c.relrowsecurity AS k FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
    UNION ALL SELECT 'col:'||table_name||':'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') FROM information_schema.columns WHERE table_schema='public'
    UNION ALL SELECT 'con:'||conrelid::regclass||':'||conname||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
    UNION ALL SELECT 'idx:'||indexname||':'||indexdef FROM pg_indexes WHERE schemaname='public'
    UNION ALL SELECT 'fn:'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||'):definer='||p.prosecdef||':'||md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
    UNION ALL SELECT 'fngrant:'||routine_name||':'||grantee FROM information_schema.routine_privileges WHERE routine_schema='public' AND grantee IN ('app_runtime','PUBLIC')
    UNION ALL SELECT 'trigger:'||c.relname||':'||t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
    UNION ALL SELECT 'policy:'||tablename||':'||policyname||':'||cmd||':'||permissive||':'||coalesce(qual,'')||':'||coalesce(with_check,'') FROM pg_policies WHERE schemaname='public'
    UNION ALL SELECT 'grant:'||table_name||':'||grantee||':'||privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('app_runtime','PUBLIC')
    UNION ALL SELECT 'colgrant:'||table_name||':'||column_name||':'||privilege_type FROM information_schema.column_privileges WHERE table_schema='public' AND grantee='app_runtime'
    ORDER BY 1`)).rows.map((r) => r.k));
  /** md5 of every row of every table that existed before, over the columns that existed before. */
  const columnsOf = async (c: pg.Client) => { const m = new Map<string, string[]>(); for (const r of (await c.query<{ t: string; col: string }>(`SELECT table_name t, column_name col FROM information_schema.columns WHERE table_schema='public' AND table_name<>'schema_migrations' ORDER BY table_name, ordinal_position`)).rows) m.set(r.t, [...(m.get(r.t) ?? []), r.col]); return m; };
  const fingerprint = async (c: pg.Client, cols: Map<string, string[]>) => {
    const parts: string[] = []; let rows = 0;
    for (const [t, cs] of cols) {
      const list = cs.map((x) => `x."${x}"`).join(",");
      const r = (await c.query<{ h: string | null; n: number }>(`SELECT md5(string_agg(md5(row(${list})::text), '' ORDER BY md5(row(${list})::text))) h, count(*)::int n FROM "${t}" x`)).rows[0];
      parts.push(`${t}:${r.n}:${r.h ?? "-"}`); rows += r.n;
    }
    return { hash: parts.join("|"), tables: cols.size, rows };
  };
  /** Fictitious history touching what 150/151 change: institutional documents (dated, undated, with a
   *  Central decision) and a direct agency ↔ caregiver conversation with messages. */
  const seed = async (c: pg.Client) => {
    const org = (await c.query(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'RESIDENTIAL_CARE_HOME','active') RETURNING id`, [`RB${N} ${tag}`])).rows[0].id;
    const loc = (await c.query(`INSERT INTO locations (organization_id,name) VALUES ($1,'Hogar ficticio') RETURNING id`, [org])).rows[0].id;
    const user = async (k: string) => (await c.query(`INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id`, [`rb${N}-${k}-${tag}@example.invalid`])).rows[0].id;
    const central = await user("central"), admin = await user("admin"), cg = await user("cg");
    await c.query(`INSERT INTO establishment_documents (organization_id,establishment_id,document_type,title,file_name,content_type,size_bytes,storage_key,expires_on,review_status,reviewed_by_user_id,reviewed_at)
      VALUES ($1,$2,'Licencia sanitaria','Licencia sanitaria','l.pdf','application/pdf',1,$3,'2027-01-31','approved',$4,'2026-10-20'),
             ($1,$2,'Póliza de responsabilidad','Póliza','p.pdf','application/pdf',1,$5,NULL,'pending',NULL,NULL)`, [org, loc, `rb${N}/${tag}/l.pdf`, central, `rb${N}/${tag}/p.pdf`]);
    const mem = async (u: string, role: string) => { const m = (await c.query(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [u, org])).rows[0].id; await c.query(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [m, org, role]); };
    await mem(admin, "ORGANIZATION_ADMIN"); await mem(cg, "WORKER");
    const w = (await c.query(`INSERT INTO workers (user_id,display_name) VALUES ($1,'Cuidadora ficticia') RETURNING id`, [cg])).rows[0].id;
    const owm = (await c.query(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','CNA') RETURNING id`, [w, org])).rows[0].id;
    const th = (await c.query(`INSERT INTO message_threads (organization_id,thread_type,organization_worker_membership_id) VALUES ($1,'caregiver_agency',$2) RETURNING id`, [org, owm])).rows[0].id;
    await c.query(`INSERT INTO message_thread_participants (organization_id,message_thread_id,user_id,can_write) VALUES ($1,$2,$3,true),($1,$2,$4,true)`, [org, th, admin, cg]);
    await c.query(`INSERT INTO messages (organization_id,message_thread_id,sender_user_id,body) VALUES ($1,$2,$3,'Mensaje ficticio')`, [org, th, cg]);
  };
  try {
    const refPrev = await newDb("refprev"); await migrate(refPrev.c, upToPrev); const sPrev = await snapshot(refPrev.c);
    const refN = await newDb("refn"); await migrate(refN.c, upToN); const sN = await snapshot(refN.c);
    const a = await newDb("a");
    await migrate(a.c, upToPrev); await seed(a.c);
    execFileSync("npx", ["tsx", "scripts/seedDemo.ts"], { env: { ...process.env, DATABASE_URL: a.url, DEMO_PASSWORD: randomUUID() }, stdio: "ignore" });
    const cols = await columnsOf(a.c);
    const fpBefore = await fingerprint(a.c, cols);
    await migrate(a.c, upToN);
    const fpAfter = await fingerprint(a.c, cols);
    await a.c.query(MIGRATION);
    const twice = await snapshot(a.c);
    check(`R4 ${N} is idempotent and changes no existing data on apply`, twice === sN && fpAfter.hash === fpBefore.hash, `schema=${twice === sN} data=${fpAfter.hash === fpBefore.hash}`);
    await a.c.query(ROLLBACK);
    const fpRolled = await fingerprint(a.c, cols);
    const sRolled = await snapshot(a.c);
    const registered = (await a.c.query(`SELECT 1 FROM schema_migrations WHERE filename=$1`, [file])).rowCount;
    check(`R1 the rollback leaves the schema identical to ${N - 1} and unregisters ${N}`, sRolled === sPrev && registered === 0,
      `identical=${sRolled === sPrev} registered=${registered} ${sRolled === sPrev ? "" : JSON.stringify({ onlyPrev: (JSON.parse(sPrev) as string[]).filter((k) => !sRolled.includes(JSON.stringify(k))).slice(0, 4), onlyRolled: (JSON.parse(sRolled) as string[]).filter((k) => !sPrev.includes(JSON.stringify(k))).slice(0, 4) })}`);
    check(`R2 every row of every table (demo + fictitious documents, Central decision, direct conversation) is identical before ${N}, after it and after the rollback`,
      fpBefore.hash === fpRolled.hash && fpBefore.hash === fpAfter.hash, `tables=${fpBefore.tables} rows=${fpBefore.rows}`);
    await migrate(a.c, upToN);
    check(`R3 applying ${N} again after the rollback gives the same schema as a clean ${N}`, (await snapshot(a.c)) === sN && (await fingerprint(a.c, cols)).hash === fpBefore.hash);
    for (const x of [refPrev, refN, a]) await x.c.end();
  } finally {
    for (const d of dbs) await server.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => undefined);
    await server.end(); rmSync(upToPrev, { recursive: true, force: true }); rmSync(upToN, { recursive: true, force: true });
  }
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name} — ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nMIGRATION_${N}_ROLLBACK ${results.length - failed}/${results.length}`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
