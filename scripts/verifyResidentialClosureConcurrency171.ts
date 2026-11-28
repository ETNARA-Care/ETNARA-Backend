/**
 * 171 · Hogares F1: concurrencia entre el cierre de un establecimiento y crear habitaciones, ubicar residentes o crear
 * turnos (auditoría 26-nov). Dos sesiones app_runtime simultáneas con contexto de administración, en los dos órdenes
 * (cierre primero / operación primero). Nunca puede quedar un establecimiento cerrado con habitaciones activas,
 * residentes activos ni turnos futuros. Base PROPIA desechable, datos ficticios.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import pg from "pg";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const serverUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!serverUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(serverUrl)) throw new Error("Hosted database refused");
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Est = { L: string; gu: string; R: string };
type Outcome = { primero: string; segundo: string; segundo_espero: boolean; cerrado: boolean; habitaciones_activas: number; residentes_activos: number; turnos_futuros: number; inconsistente: boolean };

async function main() {
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  const dbName = `etnara_h171c_${randomBytes(4).toString("hex")}`;
  await srv.query(`CREATE DATABASE ${dbName}`);
  const su = new URL(serverUrl!); su.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: su.toString() }); await db.connect();
  { const log = console.log; console.log = () => undefined; try { await applyPendingMigrations(db, join(process.cwd(), "migrations")); } finally { console.log = log; } }
  const q = async (s: string, p: unknown[] = []) => (await db.query(s, p)).rows;
  const pw = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${pw}'`);
  const rt = new URL(su.toString()); rt.username = "app_runtime"; rt.password = pw;
  const H = (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ('Hogar concurrencia ficticio','RESIDENTIAL_CARE_HOME','active') RETURNING id`))[0].id as string;
  const admin = (await q(`INSERT INTO users (email,password_hash,status) VALUES ($1,'x','active') RETURNING id`, [`admin-concurrencia-${randomBytes(3).toString("hex")}@example.invalid`]))[0].id as string;
  const m = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [admin, H]))[0].id;
  await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='ORGANIZATION_ADMIN'`, [m, H]);
  const session = async () => { const c = new pg.Client({ connectionString: rt.toString() }); await c.connect(); await c.query(`SET statement_timeout = '8s'`); return c; };
  const begin = async (c: pg.Client, org = H) => {
    await c.query("BEGIN");
    await c.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin','false',true)`, [admin, org]);
  };
  let n = 0;
  const establishment = async (): Promise<Est> => {
    n++;
    const L = (await q(`INSERT INTO locations (organization_id,name) VALUES ($1,$2) RETURNING id`, [H, `Sede concurrencia ${n}`]))[0].id as string;
    const gu = (await q(`SELECT unit_id FROM establishment_general_units WHERE location_id=$1`, [L]))[0].unit_id as string;
    const R = (await q(`INSERT INTO rooms (unit_id,organization_id,name) VALUES ($1,$2,'101') RETURNING id`, [gu, H]))[0].id as string;
    return { L, gu, R };
  };
  const state = async (L: string) => (await q(`SELECT
      (SELECT archived_at IS NOT NULL FROM locations WHERE id=$1) cerrado,
      (SELECT count(*)::int FROM rooms r JOIN units u ON u.id=r.unit_id WHERE u.location_id=$1 AND r.archived_at IS NULL) habitaciones_activas,
      (SELECT count(*)::int FROM care_recipients WHERE location_id=$1 AND status='active') residentes_activos,
      (SELECT count(*)::int FROM shifts s WHERE s.status NOT IN ('cancelled','completed') AND s.scheduled_end > now()
         AND (s.room_id IN (SELECT r.id FROM rooms r JOIN units u ON u.id=r.unit_id WHERE u.location_id=$1)
              OR s.care_recipient_id IN (SELECT id FROM care_recipients WHERE location_id=$1))) turnos_futuros`, [L]))[0];
  // La operación concurrente, tal como la hace la aplicación (el turno pasa por la comprobación con bloqueo del servicio).
  const operate = async (c: pg.Client, kind: string, e: Est): Promise<string> => {
    try {
      if (kind === "habitacion") await c.query(`INSERT INTO rooms (unit_id,organization_id,name) VALUES ($1,$2,'Nueva')`, [e.gu, H]);
      if (kind === "residente") await c.query(`INSERT INTO care_recipients (organization_id,location_id,room_id,first_name,last_name,status) VALUES ($1,$2,$3,'Residente','Ficticio','active')`, [H, e.L, e.R]);
      if (kind === "turno") {
        const st = (await c.query(`SELECT app_residential_shift_target_state($1, NULL) s`, [e.R])).rows[0].s as string;
        if (st !== "ok") return `RECHAZADO ${st}`;
        await c.query(`INSERT INTO shifts (organization_id,room_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()+interval '1 day',now()+interval '26 hours','confirmed')`, [H, e.R]);
      }
      return "OK";
    } catch (x) { return (x as Error).message.slice(0, 60); }
  };
  const close = (c: pg.Client, e: Est) => c.query(`SELECT app_residential_close_establishment($1,'Cierre ficticio por prueba')`, [e.L]).then(() => "OK", (x: Error) => x.message.slice(0, 60));
  const pending = async (p: Promise<string>) => Promise.race([p.then(() => false), sleep(10).then(() => true)]);

  const out: Record<string, Outcome> = {};
  const kinds = ["habitacion", "residente", "turno"];
  for (const kind of kinds) {
    for (const order of ["cierre_primero", "operacion_primero"]) {
      const e = await establishment();
      const c1 = await session(), c2 = await session();
      await begin(c1); await begin(c2);
      let primero: string, segundo: string, espero: boolean;
      if (order === "cierre_primero") {
        primero = await close(c1, e);
        const p2 = operate(c2, kind, e); await sleep(700); espero = await pending(p2);
        await c1.query(primero === "OK" ? "COMMIT" : "ROLLBACK");
        segundo = await p2; await c2.query(segundo === "OK" ? "COMMIT" : "ROLLBACK").catch(() => undefined);
      } else {
        primero = await operate(c2, kind, e);
        const p1 = close(c1, e); await sleep(700); espero = await pending(p1);
        await c2.query(primero === "OK" ? "COMMIT" : "ROLLBACK");
        segundo = await p1; await c1.query(segundo === "OK" ? "COMMIT" : "ROLLBACK").catch(() => undefined);
      }
      const st = await state(e.L);
      out[`${kind}/${order}`] = { primero, segundo, segundo_espero: espero, ...st,
        inconsistente: st.cerrado === true && (st.habitaciones_activas > 0 || st.residentes_activos > 0 || st.turnos_futuros > 0) } as Outcome;
      await c1.end(); await c2.end();
    }
  }
  const labels: Record<string, string> = { habitacion: "crear una habitación", residente: "ubicar un residente", turno: "crear un turno" };
  for (const kind of kinds) {
    const a = out[`${kind}/cierre_primero`], b = out[`${kind}/operacion_primero`];
    check(`C-${kind}. Cierre y ${labels[kind]} a la vez, en los dos órdenes: la segunda operación espera y el resultado es coherente (nunca un establecimiento cerrado con algo activo)`,
      !a.inconsistente && !b.inconsistente && a.segundo_espero && b.segundo_espero && a.primero === "OK" && a.segundo !== "OK" && b.primero === "OK",
      { cierre_primero: a, operacion_primero: b });
  }

  // Secuencial: tras el cierre, un turno nuevo sobre una habitación del establecimiento cerrado se rechaza.
  {
    const e = await establishment();
    const c = await session(); await begin(c);
    await c.query(`SELECT app_residential_close_establishment($1,'Cierre ficticio por prueba')`, [e.L]); await c.query("COMMIT");
    await begin(c);
    const r = await operate(c, "turno", e);
    await c.query("ROLLBACK"); await c.end();
    check("C-secuencial. Tras el cierre, un turno nuevo sobre una habitación del establecimiento se rechaza", r === "RECHAZADO establishment_closed", r);
  }

  // Fuera de hogares la comprobación no hace nada (agencias sin cambios).
  const A = (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ('Agencia concurrencia ficticia','HOME_CARE_AGENCY','active') RETURNING id`))[0].id as string;
  const mA = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [admin, A]))[0].id;
  await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='ORGANIZATION_ADMIN'`, [mA, A]);
  const cA = await session(); await begin(cA, A);
  const agencyState = (await cA.query(`SELECT app_residential_shift_target_state(gen_random_uuid(), gen_random_uuid()) s`)).rows[0].s;
  await cA.query("ROLLBACK"); await cA.end();
  const fnInfo = (await q(`SELECT count(*)::int n, bool_and(prosecdef) sd, bool_and(NOT has_function_privilege('public', oid, 'EXECUTE')) nopublic FROM pg_proc
    WHERE proname IN ('app_residential_lock_establishment','app_residential_shift_target_state')`))[0];
  check("C-agencias. Fuera de hogares la comprobación devuelve 'ok' sin bloquear; las 2 funciones son SECURITY DEFINER y sin ejecución para PUBLIC",
    agencyState === "ok" && fnInfo.n === 2 && fnInfo.sd === true && fnInfo.nopublic === true, { agencyState, fnInfo });

  await db.end(); await srv.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await srv.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 1500)}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
