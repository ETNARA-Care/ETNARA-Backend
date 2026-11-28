/**
 * 176 sobre la secuencia de PRODUCCIÓN (…175 → 180 → 176) frente a la de una base limpia o la CI (…175 → 176 → 180).
 * En producción la 180 ya está aplicada cuando llega la 176. Bases DESECHABLES, sin datos reales.
 *   O1 mismo esquema final en los dos órdenes;  O2 revertir la 176 deja producción EXACTAMENTE como hoy (180 incluida);
 *   O3 volver a aplicarla da lo mismo;  O4 los objetos de la 180 no cambian;  O5 solo cambia 3 funciones existentes.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> npx tsx scripts/verifyMigration176ProductionOrder.ts
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const admin = process.env.MIGRATIONS_DATABASE_URL;
if (!admin || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(admin)) throw new Error("Hosted database refused");
const repo = process.cwd();
// Solo lo que había al llegar la 176: hasta la 176 y la 180 (las fases posteriores, 177…, no cuentan aquí).
const upTo176 = (n: number) => n <= 176 || n === 180;
const ALL = join(repo, "migrations");
const files = readdirSync(ALL).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
const dir = (pick: (n: number) => boolean) => { const d = mkdtempSync(join(tmpdir(), "o176-")); for (const f of files.filter((f) => pick(Number(f.slice(0, 3))))) copyFileSync(join(ALL, f), join(d, f)); return d; };
const quiet = async <T>(fn: () => Promise<T>) => { const l = console.log; console.log = () => undefined; try { return await fn(); } finally { console.log = l; } };
const server = new pg.Client({ connectionString: admin }); await server.connect();
const tag = randomUUID().slice(0, 6); const made: string[] = []; const clients: pg.Client[] = [];
const db = async (s: string) => { const n = `o176_${s}_${tag}`; await server.query(`CREATE DATABASE ${n}`); made.push(n); const u = new URL(admin); u.pathname = `/${n}`; const c = new pg.Client({ connectionString: u.toString() }); c.on('error', () => undefined); await c.connect(); clients.push(c); return c; };
const snap = async (c: pg.Client) => (await c.query(`
    SELECT 'table:'||c.relname||':rls='||c.relrowsecurity||':force='||c.relforcerowsecurity AS k FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
    UNION ALL SELECT 'col:'||table_name||':'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') FROM information_schema.columns WHERE table_schema='public'
    UNION ALL SELECT 'con:'||conrelid::regclass||':'||conname||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
    UNION ALL SELECT 'idx:'||indexname||':'||indexdef FROM pg_indexes WHERE schemaname='public'
    UNION ALL SELECT 'fn:'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||'):definer='||p.prosecdef||':'||md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
    UNION ALL SELECT 'fngrant:'||routine_name||':'||grantee FROM information_schema.routine_privileges WHERE routine_schema='public' AND grantee IN ('app_runtime','PUBLIC')
    UNION ALL SELECT 'trigger:'||c.relname||':'||t.tgname||':'||md5(pg_get_triggerdef(t.oid)) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
    UNION ALL SELECT 'policy:'||tablename||':'||policyname||':'||cmd||':'||permissive||':'||array_to_string(roles,',')||':'||coalesce(qual,'')||':'||coalesce(with_check,'') FROM pg_policies WHERE schemaname='public'
    UNION ALL SELECT 'grant:'||table_name||':'||grantee||':'||privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('app_runtime','PUBLIC')
    UNION ALL SELECT 'colgrant:'||table_name||':'||column_name||':'||privilege_type FROM information_schema.column_privileges WHERE table_schema='public' AND grantee='app_runtime'
    ORDER BY 1`)).rows.map((r) => r.k as string);
const diff = (a: string[], b: string[]) => ({ soloA: a.filter((x) => !b.includes(x)), soloB: b.filter((x) => !a.includes(x)) });
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 1500) });
try {
  // Producción hoy: todo ≤175 y 180 (sin 176)
  const prod = await db("prod"); await quiet(() => applyPendingMigrations(prod, dir((n) => n !== 176 && upTo176(n))));
  const sProd = await snap(prod);
  // Producción tras integrar F3: …175 → 180 → 176
  await quiet(() => applyPendingMigrations(prod, dir(upTo176)));
  const sProd176 = await snap(prod);
  const order = (await prod.query(`SELECT filename FROM schema_migrations WHERE filename >= '170' ORDER BY applied_at, filename`)).rows.map((r) => r.filename.slice(0, 3));
  // CI / base limpia: …175 → 176 → 180
  const ci = await db("ci"); await quiet(() => applyPendingMigrations(ci, dir(upTo176)));
  const sCi = await snap(ci);
  const d1 = diff(sProd176, sCi);
  check("O1. Mismo esquema final en el orden de producción (180 → 176) y en el de una base limpia (176 → 180)", d1.soloA.length === 0 && d1.soloB.length === 0, d1);
  check("O0. La copia de producción aplica 176 después de 180", order.join(" ") === "170 171 172 173 174 175 180 176", order.join(" → "));
  // Reversión de 176 sobre producción: vuelve EXACTAMENTE al estado actual (con 180)
  const rb = readFileSync(join(repo, "ops/176_residential_resident_assignments.rollback.sql"), "utf8");
  await prod.query(rb);
  const sAfterRb = await snap(prod);
  const d2 = diff(sAfterRb, sProd);
  const reg = (await prod.query(`SELECT count(*)::int n FROM schema_migrations WHERE filename LIKE '176_%'`)).rows[0].n;
  check("O2. Revertir la 176 sobre producción deja el esquema idéntico al de hoy (con la 180) y la desregistra", d2.soloA.length === 0 && d2.soloB.length === 0 && reg === 0, { ...d2, reg });
  // Volver a aplicar tras revertir = aplicación limpia
  await quiet(() => applyPendingMigrations(prod, dir(upTo176)));
  const d3 = diff(await snap(prod), sProd176);
  check("O3. Volver a aplicar la 176 tras revertirla da el mismo esquema que la primera vez", d3.soloA.length === 0 && d3.soloB.length === 0, d3);
  // 180 intacta tras 176: sus políticas y funciones no cambian
  const only180 = (s: string[]) => s.filter((k) => /family_scope_|app_family_/.test(k));
  check("O4. Los objetos de la 180 (políticas family_scope_* y funciones app_family_*) son idénticos antes y después de la 176", only180(sProd).length >= 30 && JSON.stringify(only180(sProd)) === JSON.stringify(only180(sProd176)), only180(sProd).length);
  // Qué cambia 176 en objetos que ya existían
  const removed = sProd.filter((k) => !sProd176.includes(k)).map((k) => k.split("(")[0]);
  check("O5. La 176 no quita nada existente: solo redefine app_attendance_my_shifts, app_worker_has_recipient_assignment y app_worker_messaging_window",
    JSON.stringify(removed.sort()) === JSON.stringify(["fn:app_attendance_my_shifts", "fn:app_worker_has_recipient_assignment", "fn:app_worker_messaging_window"]), removed);
} finally {
  for (const c of clients) await c.end().catch(() => undefined);
  for (const n of made) await server.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
  await server.end();
}
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `\n      ${r.detail}`}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`\nMIGRATION_176_PRODUCTION_ORDER ${results.length - failed}/${results.length}`);
process.exit(failed || results.length < 6 ? 1 : 0);
