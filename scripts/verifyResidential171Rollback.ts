/**
 * Hogares F1 · migración 171: ida y vuelta completa en una base desechable (26-nov-2026). Datos ficticios.
 *
 *  1. Aplica las migraciones hasta la 170 y crea datos previos ficticios: un hogar con establecimiento, unidad,
 *     habitación y residente, y una agencia con lo mismo.
 *  2. Guarda una huella del esquema (tablas, columnas, políticas, disparadores, funciones y permisos) y de los datos.
 *  3. Aplica la 171: crea solo las piezas automáticas del hogar («General», unidad y habitación técnicas, ajustes).
 *  4. Ejecuta ops/171_…rollback.sql sin datos de personas en F1: debe completar y dejar el esquema y los datos
 *     exactamente como en la 170 (la agencia no se toca nunca).
 *  5. Vuelve a aplicar la 171: completa y es idempotente (una segunda pasada no aplica nada).
 */
import { join } from "node:path";
import { mkdtempSync, readdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import pg from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const serverUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!serverUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Solo en una base desechable (ETNARA_DISPOSABLE_DB=true).");
const results: { check: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
const quiet = async (fn: () => Promise<void>) => { const log = console.log; console.log = () => undefined; try { await fn(); } finally { console.log = log; } };

const FINGERPRINT = `
SELECT md5(string_agg(x, '|' ORDER BY x)) AS h, count(*)::int AS n FROM (
  SELECT 'col:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS x
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
  UNION ALL SELECT 'pol:' || tablename || '.' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') FROM pg_policies WHERE schemaname = 'public'
  UNION ALL SELECT 'trg:' || event_object_table || '.' || trigger_name || ':' || event_manipulation || ':' || action_statement FROM information_schema.triggers WHERE trigger_schema = 'public'
  UNION ALL SELECT 'fn:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || md5(p.prosrc) || ':' || p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
  UNION ALL SELECT 'grant:' || table_name || ':' || grantee || ':' || privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee IN ('app_runtime', 'PUBLIC')
  UNION ALL SELECT 'con:' || conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'public'::regnamespace
  UNION ALL SELECT 'idx:' || indexname || ':' || indexdef FROM pg_indexes WHERE schemaname = 'public'
) s`;
const DATA = `
SELECT (SELECT count(*) FROM locations)::int AS locations, (SELECT count(*) FROM units)::int AS units, (SELECT count(*) FROM rooms)::int AS rooms,
       (SELECT count(*) FROM care_recipients)::int AS recipients, (SELECT count(*) FROM care_recipients WHERE room_id IS NOT NULL)::int AS with_room,
       (SELECT md5(string_agg(id::text || name || coalesce(archived_at::text, ''), ',' ORDER BY id)) FROM units) AS units_hash,
       (SELECT md5(string_agg(id::text || name || coalesce(archived_at::text, ''), ',' ORDER BY id)) FROM rooms) AS rooms_hash`;

async function main() {
  const dbName = `etnara_171rt_${process.pid}`;
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  await srv.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await srv.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(serverUrl!); url.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: url.toString() }); await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const all = join(process.cwd(), "migrations");
  const upTo170 = mkdtempSync(join(tmpdir(), "mig170-"));
  for (const f of readdirSync(all)) if (!f.startsWith("171_")) copyFileSync(join(all, f), join(upTo170, f));
  try {
    // 1. Hasta la 170, con datos previos ficticios.
    await quiet(() => applyPendingMigrations(db, upTo170));
    // Base = todas las migraciones salvo la 171 (en producción: 170 + 180). Se exige la 170 registrada y la 171 no.
    const expectedLast = readdirSync(upTo170).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort().at(-1);
    const last = (await q<{ f: string }>(`SELECT max(filename) f FROM schema_migrations`)).rows[0].f;
    const has170 = (await q<{ n: number }>(`SELECT count(*)::int n FROM schema_migrations WHERE filename = '170_residential_modality_foundation.sql'`)).rows[0].n === 1;
    const has171 = (await q<{ n: number }>(`SELECT count(*)::int n FROM schema_migrations WHERE filename LIKE '171_%'`)).rows[0].n > 0;
    const org = async (n: string, t: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2,'active') RETURNING id`, [n, t])).rows[0].id;
    const H = await org("Hogar Ficticio RT", "RESIDENTIAL_CARE_HOME"), A = await org("Agencia Ficticia RT", "HOME_CARE_AGENCY");
    for (const [o, tag] of [[H, "H"], [A, "A"]] as const) {
      const l = (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,$2) RETURNING id`, [o, `Sede ${tag}`])).rows[0].id;
      const u = (await q<{ id: string }>(`INSERT INTO units (organization_id,location_id,name) VALUES ($1,$2,'Ala previa') RETURNING id`, [o, l])).rows[0].id;
      const r = (await q<{ id: string }>(`INSERT INTO rooms (organization_id,unit_id,name) VALUES ($1,$2,'P-1') RETURNING id`, [o, u])).rows[0].id;
      await q(`INSERT INTO care_recipients (organization_id,location_id,room_id,first_name,last_name,status) VALUES ($1,$2,$3,'Previa','Ficticia','active')`, [o, l, tag === "A" ? r : null]);
    }
    const fp170 = (await q<{ h: string; n: number }>(FINGERPRINT)).rows[0];
    const d170 = (await q(DATA)).rows[0];
    check("P1. Base anterior a la 171 (170 y, si existen, posteriores como la 180) con datos previos ficticios (hogar y agencia)", has170 && !has171 && last === expectedLast && d170.locations === 2 && d170.rooms === 2, [last, expectedLast, d170]);

    // 2. Aplicar la 171.
    await quiet(() => applyPendingMigrations(db, all));
    const d171 = (await q(DATA)).rows[0];
    const auto = (await q<{ general: number; technical: number; settings: number }>(
      `SELECT (SELECT count(*) FROM establishment_general_units)::int general, (SELECT count(*) FROM establishment_technical_rooms)::int technical, (SELECT count(*) FROM establishment_settings)::int settings`)).rows[0];
    check("P2. La 171 crea solo las piezas automáticas del hogar (1 «General», 1 habitación técnica, 1 ajuste); la agencia no cambia",
      auto.general === 1 && auto.technical === 1 && auto.settings === 1 && d171.recipients === d170.recipients && d171.with_room === d170.with_room, [auto, d171]);

    // 3. Reversión sin datos de personas en F1.
    let rbError = "OK";
    try { await q(readFileSync(join(process.cwd(), "ops/171_residential_establishments_rooms.rollback.sql"), "utf8")); }
    catch (e) { rbError = (e as Error).message; await q("ROLLBACK").catch(() => undefined); }
    const fpRb = (await q<{ h: string; n: number }>(FINGERPRINT)).rows[0];
    const dRb = (await q(DATA)).rows[0];
    const reg = (await q<{ n: number }>(`SELECT count(*)::int n FROM schema_migrations WHERE filename LIKE '171_%'`)).rows[0].n;
    const left = (await q<{ t: string | null }>(`SELECT string_agg(c, ',') t FROM unnest(ARRAY['establishment_settings','establishment_technical_rooms','establishment_general_units','room_profiles','care_recipient_room_events','establishment_closures','establishment_settings_events']) c WHERE to_regclass('public.' || c) IS NOT NULL`)).rows[0].t;
    check("R1. Sin datos de personas en F1, la reversión completa", rbError === "OK", rbError);
    check("R2. Tras la reversión, el esquema es idéntico al de la 170 (tablas, columnas, políticas, disparadores, funciones, permisos, restricciones e índices)", fpRb.h === fp170.h && fpRb.n === fp170.n && reg === 0 && left === null, [fp170, fpRb, reg, left]);
    check("R3. Tras la reversión, los datos son los de la 170: unidades y habitaciones previas intactas y las automáticas retiradas", JSON.stringify(dRb) === JSON.stringify(d170), [d170, dRb]);

    // 4. Volver a aplicar la 171 (idempotente).
    let reError = "OK";
    try { await quiet(() => applyPendingMigrations(db, all)); } catch (e) { reError = (e as Error).message; }
    const again = (await q<{ general: number; technical: number }>(`SELECT (SELECT count(*) FROM establishment_general_units)::int general, (SELECT count(*) FROM establishment_technical_rooms)::int technical`)).rows[0];
    const before = (await q<{ n: number }>(`SELECT count(*)::int n FROM schema_migrations`)).rows[0].n;
    await quiet(() => applyPendingMigrations(db, all));
    const after = (await q<{ n: number }>(`SELECT count(*)::int n FROM schema_migrations`)).rows[0].n;
    check("A1. Volver a aplicar la 171 completa y recrea las mismas piezas automáticas", reError === "OK" && again.general === 1 && again.technical === 1, [reError, again]);
    check("A2. Una segunda pasada de migraciones no aplica nada (idempotente)", before === after, [before, after]);

    // 5. Con un dato de persona (una cama registrada), la reversión se niega y no deja nada a medias.
    const room = (await q<{ id: string }>(`SELECT r.id FROM rooms r JOIN units u ON u.id = r.unit_id JOIN locations l ON l.id = u.location_id WHERE l.organization_id = $1 AND r.name = 'P-1'`, [H])).rows[0].id;
    await q(`INSERT INTO room_profiles (room_id, organization_id, bed_capacity) VALUES ($1,$2,2)`, [room, H]).catch(async () => {
      await q(`UPDATE establishment_settings SET geofence_radius_m = 150`);
    });
    let refused = "";
    try { await q(readFileSync(join(process.cwd(), "ops/171_residential_establishments_rooms.rollback.sql"), "utf8")); } catch (e) { refused = (e as Error).message; await q("ROLLBACK").catch(() => undefined); }
    const stillThere = (await q<{ ok: boolean }>(`SELECT to_regclass('public.establishment_technical_rooms') IS NOT NULL ok`)).rows[0].ok;
    check("R4. Con datos de personas, la reversión se niega (ROLLBACK_171_REFUSED) y la 171 sigue completa", refused.includes("ROLLBACK_171_REFUSED") && stillThere, refused);
  } finally {
    rmSync(upTo170, { recursive: true, force: true });
    await db.end();
    await srv.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await srv.end();
  }
}

main().then(() => {
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 900)}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
