/**
 * 177 sobre la secuencia de PRODUCCIÓN (…175 → 180 → 176 → 177) frente a la de una base limpia o la CI (…176 → 177 → 180).
 * En producción la 180 y la 176 ya están aplicadas cuando llega la 177. Bases DESECHABLES, sin datos reales.
 *   O1 mismo esquema final en los dos órdenes;  O2 revertir la 177 deja producción EXACTAMENTE como hoy (180 y 176 incluidas);
 *   O3 volver a aplicarla da lo mismo;  O4 los objetos de la 180 y de la 176 no cambian;  O5 solo redefine app_worker_messaging_window.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> npx tsx scripts/verifyMigration177ProductionOrder.ts
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
// Solo lo que había al llegar la 177: hasta la 177 y la 180 (fases posteriores, 178…, no cuentan aquí).
const upTo177 = (n: number) => n <= 177 || n === 180;
const ALL = join(repo, "migrations");
const files = readdirSync(ALL).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
const dir = (pick: (n: number) => boolean) => { const d = mkdtempSync(join(tmpdir(), "o177-")); for (const f of files.filter((f) => pick(Number(f.slice(0, 3))))) copyFileSync(join(ALL, f), join(d, f)); return d; };
const quiet = async <T>(fn: () => Promise<T>) => { const l = console.log; console.log = () => undefined; try { return await fn(); } finally { console.log = l; } };
const server = new pg.Client({ connectionString: admin }); await server.connect();
const tag = randomUUID().slice(0, 6); const made: string[] = []; const clients: pg.Client[] = [];
const db = async (s: string) => { const n = `o177_${s}_${tag}`; await server.query(`CREATE DATABASE ${n}`); made.push(n); const u = new URL(admin); u.pathname = `/${n}`; const c = new pg.Client({ connectionString: u.toString() }); c.on('error', () => undefined); await c.connect(); clients.push(c); return c; };
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
  // Producción hoy: todo ≤175, luego 180 y luego 176 (sin 177), en ese orden
  const prod = await db("prod");
  await quiet(() => applyPendingMigrations(prod, dir((n) => n !== 176 && n !== 177 && upTo177(n))));
  await quiet(() => applyPendingMigrations(prod, dir((n) => n !== 177 && upTo177(n))));
  const sProd = await snap(prod);
  // Producción tras integrar F5: …180 → 176 → 177
  await quiet(() => applyPendingMigrations(prod, dir(upTo177)));
  const sProd177 = await snap(prod);
  const order = (await prod.query(`SELECT filename FROM schema_migrations WHERE filename >= '170' ORDER BY applied_at, filename`)).rows.map((r) => r.filename.slice(0, 3));
  check("O0. La copia de producción aplica 180, después 176 y al final 177", order.join(" ") === "170 171 172 173 174 175 180 176 177", order.join(" → "));
  // Base limpia / CI: …176 → 177 → 180
  const ci = await db("ci"); await quiet(() => applyPendingMigrations(ci, dir(upTo177)));
  const d1 = diff(sProd177, await snap(ci));
  check("O1. Mismo esquema final en el orden de producción (180 → 176 → 177) y en el de una base limpia (176 → 177 → 180)", d1.soloA.length === 0 && d1.soloB.length === 0, d1);
  // Revertir la 177 sobre producción: vuelve EXACTAMENTE al estado de hoy
  await prod.query(readFileSync(join(repo, "ops/177_residential_portals.rollback.sql"), "utf8"));
  const d2 = diff(await snap(prod), sProd);
  const reg = (await prod.query(`SELECT count(*)::int n FROM schema_migrations WHERE filename LIKE '177_%'`)).rows[0].n;
  check("O2. Revertir la 177 sobre producción deja el esquema idéntico al de hoy (con la 180 y la 176) y la desregistra", d2.soloA.length === 0 && d2.soloB.length === 0 && reg === 0, { ...d2, reg });
  await quiet(() => applyPendingMigrations(prod, dir(upTo177)));
  const d3 = diff(await snap(prod), sProd177);
  check("O3. Volver a aplicar la 177 tras revertirla da el mismo esquema que la primera vez", d3.soloA.length === 0 && d3.soloB.length === 0, d3);
  const only180 = (s: string[]) => s.filter((k) => /family_scope_|app_family_(only_member|has_recipient|recipient_shift|visible_)/.test(k));
  const only176 = (s: string[]) => s.filter((k) => /shift_substitutions|shift_resident_assignments|shift_coverage_alerts|app_residential_(coverage|membership_busy|substitut|assignment_guard|care_event_window|close_resident|user_has_recipient_now|worker_has_recipient)|care_recipients_residential_close_assignments|notifications_insert_shift_substitution/.test(k));
  check("O4. Los objetos de la 180 y de la 176 son idénticos antes y después de la 177",
    only180(sProd).length >= 20 && only176(sProd).length >= 200 && JSON.stringify(only180(sProd)) === JSON.stringify(only180(sProd177))
    && JSON.stringify(only176(sProd)) === JSON.stringify(only176(sProd177)), { n180: only180(sProd).length, n176: only176(sProd).length });
  const removed = sProd.filter((k) => !sProd177.includes(k)).map((k) => k.split("(")[0]);
  check("O5. La 177 no quita nada existente: solo redefine app_worker_messaging_window", JSON.stringify(removed) === JSON.stringify(["fn:app_worker_messaging_window"]), removed);
} finally {
  for (const c of clients) await c.end().catch(() => undefined);
  for (const n of made) await server.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
  await server.end();
}
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `\n      ${r.detail}`}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`\nMIGRATION_177_PRODUCTION_ORDER ${results.length - failed}/${results.length}`);
process.exit(failed || results.length < 6 ? 1 : 0);
