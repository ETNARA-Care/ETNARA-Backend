/**
 * Reversión de 148 (ops/148_default_care_event_types.rollback.sql y .rollback_full.sql).
 * Trabaja en sus PROPIAS bases temporales (se crean y se borran aquí) y compara la estructura del
 * esquema (tablas, funciones, disparadores, políticas y permisos) con una base que nunca tuvo 148.
 *
 *  R1 la reversión estándar deja el esquema idéntico al de 147 y conserva la configuración creada;
 *     una agencia creada después vuelve a nacer sin tipos (como en 147);
 *  R2 148 se vuelve a aplicar después de la reversión: rellena solo la agencia sin configuración;
 *  R3 la reversión completa retira solo lo que puso 148 y no se modificó; respeta la configuración
 *     propia, la archivada y una fila cambiada por la agencia; el esquema vuelve a ser el de 147;
 *  R4 las reversiones se pueden repetir sin error.
 *
 * Servidores desechables solamente:
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });
const STANDARD = readFileSync("ops/148_default_care_event_types.rollback.sql", "utf8");
const FULL = readFileSync("ops/148_default_care_event_types.rollback_full.sql", "utf8");
const ALL = join(process.cwd(), "migrations");

const quiet = async <T>(fn: () => Promise<T>) => { const log = console.log; console.log = () => undefined; try { return await fn(); } finally { console.log = log; } };

async function main() {
  const tag = randomUUID().slice(0, 8);
  const server = new pg.Client({ connectionString: adminUrl }); await server.connect();
  const upTo147 = mkdtempSync(join(tmpdir(), "etnara-147-"));
  for (const f of readdirSync(ALL).filter((f) => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) <= 147)) copyFileSync(join(ALL, f), join(upTo147, f));
  const dbs: string[] = [];
  const newDb = async (suffix: string) => {
    const name = `etnara_rb148_${suffix}_${tag}`; await server.query(`CREATE DATABASE ${name}`); dbs.push(name);
    const u = new URL(adminUrl!); u.pathname = `/${name}`; const c = new pg.Client({ connectionString: u.toString() }); await c.connect(); return c;
  };
  const migrate = (c: pg.Client, dir: string) => quiet(() => applyPendingMigrations(c, dir));
  const snapshot = async (c: pg.Client) => JSON.stringify((await c.query(`
    SELECT 'table:'||c.relname||':rls='||c.relrowsecurity AS k FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
    UNION ALL SELECT 'fn:'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||'):definer='||p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    UNION ALL SELECT 'trigger:'||c.relname||':'||t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
    UNION ALL SELECT 'policy:'||tablename||':'||policyname||':'||cmd FROM pg_policies WHERE schemaname='public'
    UNION ALL SELECT 'grant:'||table_name||':'||grantee||':'||privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('app_runtime','PUBLIC')
    ORDER BY 1`)).rows.map((r) => r.k));
  const cfg = async (c: pg.Client, org: string) => JSON.stringify((await c.query(`SELECT cet.code, o.is_enabled, o.label_override, o.display_order, o.is_required
     FROM organization_care_event_types o JOIN care_event_types cet ON cet.id=o.care_event_type_id WHERE o.organization_id=$1 ORDER BY cet.code`, [org])).rows);
  const count = async (c: pg.Client, org: string) => (await c.query(`SELECT count(*)::int n FROM organization_care_event_types WHERE organization_id=$1`, [org])).rows[0].n as number;
  const org = async (c: pg.Client, name: string, archived = false) => (await c.query(`INSERT INTO organizations (name, organization_type, status, archived_at) VALUES ($1,'HOME_CARE_AGENCY','active',$2) RETURNING id`, [name, archived ? new Date() : null])).rows[0].id as string;
  const run = async (c: pg.Client, sql: string) => { try { await c.query(sql); return "ok"; } catch (e) { await c.query("ROLLBACK").catch(() => undefined); return (e as Error).message; } };
  const has148 = async (c: pg.Client) => (await c.query(`SELECT 1 FROM schema_migrations WHERE filename='148_default_care_event_types.sql'`)).rowCount === 1;
  // Fixtures anteriores a 148: sin configuración, con configuración propia y archivada.
  const fixtures = async (c: pg.Client) => {
    const blank = await org(c, "Sin configuración"); const custom = await org(c, "Configuración propia"); const archived = await org(c, "Archivada", true);
    await c.query(`INSERT INTO organization_care_event_types (organization_id, care_event_type_id, is_enabled) SELECT $1, id, false FROM care_event_types WHERE code='MEAL'`, [custom]);
    await c.query(`INSERT INTO organization_care_event_types (organization_id, care_event_type_id, label_override, display_order) SELECT $1, id, 'Nota del turno', 3 FROM care_event_types WHERE code='NOTE'`, [custom]);
    return { blank, custom, archived };
  };

  try {
    check("RB0 los scripts de reversión no conceden permisos ni tocan care_events",
      ![STANDARD, FULL].some((s) => /\bGRANT\b/i.test(s.replace(/--.*$/gm, "")) || /care_events\b/i.test(s.replace(/--.*$/gm, ""))));
    // Referencia: una base que nunca tuvo 148.
    const pre = await newDb("pre"); await migrate(pre, upTo147);
    const preSnap = await snapshot(pre);
    const preNew = await org(pre, "Nueva en 147");
    check("RB1 referencia: en 147 una agencia nueva nace sin tipos (hallazgo A1)", (await count(pre, preNew)) === 0);
    await pre.end();

    // ---------- R1/R2: reversión estándar y nueva aplicación
    const a = await newDb("std"); await migrate(a, upTo147);
    const fa = await fixtures(a);
    const customBefore = await cfg(a, fa.custom);
    await migrate(a, ALL);
    const newAfter148 = await org(a, "Nueva con 148");
    check("R1a 148 aplicada: relleno de la agencia sin configuración y agencia nueva con 8 tipos", (await count(a, fa.blank)) === 8 && (await count(a, newAfter148)) === 8);
    check("R1b 148 no cambió la configuración propia ni la archivada", (await cfg(a, fa.custom)) === customBefore && (await count(a, fa.archived)) === 0);
    const blankCfg = await cfg(a, fa.blank);
    const r1 = await run(a, STANDARD);
    check("R1c la reversión estándar se ejecuta", r1 === "ok", r1);
    check("R1d el esquema queda IDÉNTICO al de 147", (await snapshot(a)) === preSnap);
    check("R1e conserva la configuración creada (las agencias siguen pudiendo registrar)", (await cfg(a, fa.blank)) === blankCfg && (await count(a, newAfter148)) === 8);
    check("R1f 148 deja de constar como aplicada", !(await has148(a)));
    const afterRollback = await org(a, "Nueva tras la reversión");
    check("R1g una agencia creada tras la reversión nace sin tipos (como en 147)", (await count(a, afterRollback)) === 0);
    check("R4a la reversión estándar se puede repetir", (await run(a, STANDARD)) === "ok");
    await migrate(a, ALL);
    check("R2a 148 se vuelve a aplicar después de la reversión", await has148(a));
    check("R2b solo se rellena la agencia que quedó sin tipos; las demás no cambian",
      (await count(a, afterRollback)) === 8 && (await cfg(a, fa.blank)) === blankCfg && (await cfg(a, fa.custom)) === customBefore && (await count(a, fa.archived)) === 0);
    const dup = (await a.query(`SELECT count(*)::int n FROM (SELECT 1 FROM organization_care_event_types GROUP BY organization_id, care_event_type_id HAVING count(*)>1) d`)).rows[0].n;
    check("R2c ninguna configuración duplicada", dup === 0, `${dup}`);
    await a.end();

    // ---------- R3: reversión completa
    const b = await newDb("full"); await migrate(b, upTo147);
    const fb = await fixtures(b);
    const customBeforeB = await cfg(b, fb.custom);
    await migrate(b, ALL);
    const newB = await org(b, "Nueva con 148");
    // La agencia rellenada cambia uno de los tipos que puso 148: debe conservarse.
    await b.query(`UPDATE organization_care_event_types SET is_enabled=false WHERE organization_id=$1 AND care_event_type_id=(SELECT id FROM care_event_types WHERE code='HYDRATION')`, [fb.blank]);
    const r3 = await run(b, FULL);
    check("R3a la reversión completa se ejecuta", r3 === "ok", r3);
    check("R3b retira lo que puso 148 sin cambios (agencia nueva: 0 filas)", (await count(b, newB)) === 0);
    check("R3c conserva la fila que la agencia modificó (HYDRATION apagado) y retira las otras 7",
      (await cfg(b, fb.blank)) === JSON.stringify([{ code: "HYDRATION", is_enabled: false, label_override: null, display_order: null, is_required: false }]), await cfg(b, fb.blank));
    check("R3d no toca la configuración que existía antes de 148 ni la archivada", (await cfg(b, fb.custom)) === customBeforeB && (await count(b, fb.archived)) === 0);
    check("R3e el esquema queda IDÉNTICO al de 147", (await snapshot(b)) === preSnap);
    check("R4b la reversión completa se puede repetir (sin registro no borra nada)", (await run(b, FULL)) === "ok" && (await cfg(b, fb.custom)) === customBeforeB);
    await b.end();
  } finally {
    for (const d of dbs) await server.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => undefined);
    await server.end();
    rmSync(upTo147, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `  (${r.detail})`}`);
  console.log(`\nDEFAULT_CARE_EVENT_TYPES_ROLLBACK ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
