/**
 * RLS G1b (migración 131): inicio hecho a tiempo SIN SEÑAL y sincronizado después del final, bajo app_runtime.
 *
 * Directamente en la base, como app_runtime, con el contexto de cada actor:
 *   - la cuidadora registra SU inicio sin señal de un turno aceptado, con hora real no posterior al final
 *     (≤ 7 días) → permitido; después marca el turno «en curso»;
 *   - y NO puede: con la membresía de otra, con asignación pendiente, en turno cancelado o completado, con hora
 *     posterior al final, con más de 7 días, sin marcar «sin señal», como salida (check_out), en otra agencia;
 *   - NO marca «en curso» un turno sin su visita abierta.
 * Todo dentro de transacciones revertidas. Datos sintéticos; solo bases desechables.
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> npx tsx scripts/verifyRlsLateOfflineCheckIn.ts
 */
import { randomUUID } from "node:crypto";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = async (s: string, p: unknown[] = []) => (await db.query(s, p)).rows;
  const tag = randomUUID().slice(0, 8);
  const org = async (n: string) => (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`LATE ${n} ${tag}`]))[0].id as string;
  const A = await org("A"), B = await org("B");
  const caregiver = async (k: string, o: string) => {
    const u = (await q(`INSERT INTO users (email,password_hash,status) VALUES ($1,'x','active') RETURNING id`, [`late-${k}-${tag}@example.invalid`]))[0].id;
    const om = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [u, o]))[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='WORKER'`, [om, o]);
    const w = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [u, k]))[0].id;
    const owm = (await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [w, o]))[0].id;
    return { user: u as string, owm: owm as string, org: o };
  };
  const c = await caregiver("c", A), other = await caregiver("otra", A), cB = await caregiver("b", B);
  const rec = (await q(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Sintetico',$2) RETURNING id`, [A, tag]))[0].id;
  const recB = (await q(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Sintetico',$2) RETURNING id`, [B, tag]))[0].id;
  const method = (await q(`SELECT id FROM verification_methods WHERE code='CAREGIVER_SESSION'`))[0].id;
  const shift = async (o: string, r: string, startH: number, endH: number, status: string) =>
    (await q(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()+make_interval(mins=>$3::int),now()+make_interval(mins=>$4::int),$5) RETURNING id`,
      [o, r, Math.round(startH * 60), Math.round(endH * 60), status]))[0].id as string;
  const assign = (o: string, s: string, owm: string, r: string, st: string) =>
    q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,response_status) VALUES ($1,$2,$3,$4,$5)`, [o, s, owm, r, st]);

  const ended = await shift(A, rec, -4, -1, "confirmed"); await assign(A, ended, c.owm, rec, "accepted");
  const pending = await shift(A, rec, -4, -1, "confirmed"); await assign(A, pending, c.owm, rec, "pending");
  const cancelled = await shift(A, rec, -4, -1, "cancelled"); await assign(A, cancelled, c.owm, rec, "accepted");
  const completed = await shift(A, rec, -4, -1, "completed"); await assign(A, completed, c.owm, rec, "accepted");
  const old = await shift(A, rec, -8 * 24 - 4, -8 * 24 - 1, "confirmed"); await assign(A, old, c.owm, rec, "accepted");
  const othersShift = await shift(A, rec, -4, -1, "confirmed"); await assign(A, othersShift, other.owm, rec, "accepted");
  const shiftB = await shift(B, recB, -4, -1, "confirmed"); await assign(B, shiftB, cB.owm, recB, "accepted");

  // Runs one write as app_runtime with the actor's context, in a rolled-back transaction.
  async function as(actor: { user: string; org: string }, orgOverride: string | null, fn: () => Promise<string>): Promise<string> {
    await q("BEGIN");
    try {
      await q(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [actor.user, orgOverride ?? actor.org]);
      await q("SET LOCAL ROLE app_runtime");
      return await fn();
    } catch (e: any) { return e.code ?? "ERROR"; } finally { await q("ROLLBACK"); }
  }
  const insert = (o: string, s: string, owm: string, type: string, minutesAgo: number, offline = true) =>
    q(`INSERT INTO verification_events (organization_id,shift_id,organization_worker_membership_id,verification_method_id,event_type,occurred_at,recorded_offline)
       VALUES ($1,$2,$3,$4,$5,now()-make_interval(mins=>$6::int),$7) RETURNING id`, [o, s, owm, method, type, minutesAgo, offline]).then((r) => `filas=${r.length}`);
  const ok = (r: string) => r === "filas=1";
  const denied = (r: string) => r === "42501";

  const allowed = await as(c, null, async () => {
    const ins = await insert(A, ended, c.owm, "check_in", 3 * 60);
    const upd = (await q(`UPDATE shifts SET status='in_progress', updated_at=now() WHERE id=$1 RETURNING id`, [ended])).length;
    return `${ins} upd=${upd}`;
  });
  check("su inicio sin señal, a tiempo, enviado tras el final → permitido y marca «en curso»", allowed === "filas=1 upd=1", allowed);

  const cases: Array<[string, () => Promise<string>]> = [
    ["con la membresía de otra cuidadora", () => as(c, null, () => insert(A, othersShift, other.owm, "check_in", 3 * 60))],
    ["en el turno asignado a otra (con su propia membresía)", () => as(c, null, () => insert(A, othersShift, c.owm, "check_in", 3 * 60))],
    ["con la asignación pendiente", () => as(c, null, () => insert(A, pending, c.owm, "check_in", 3 * 60))],
    ["en un turno cancelado", () => as(c, null, () => insert(A, cancelled, c.owm, "check_in", 3 * 60))],
    ["en un turno completado", () => as(c, null, () => insert(A, completed, c.owm, "check_in", 3 * 60))],
    ["con hora real posterior al final", () => as(c, null, () => insert(A, ended, c.owm, "check_in", 30))],
    ["con más de 7 días", () => as(c, null, () => insert(A, old, c.owm, "check_in", 8 * 24 * 60 + 3 * 60))],
    ["sin marcar «sin señal»", () => as(c, null, () => insert(A, ended, c.owm, "check_in", 3 * 60, false))],
    ["como salida (check_out) sin visita abierta", () => as(c, null, () => insert(A, ended, c.owm, "check_out", 90))],
    ["en otra agencia (contexto de A, turno de B)", () => as(c, null, () => insert(B, shiftB, cB.owm, "check_in", 3 * 60))],
    ["fingiendo el contexto de B", () => as(c, B, () => insert(B, shiftB, cB.owm, "check_in", 3 * 60))],
  ];
  for (const [name, run] of cases) {
    const r = await run();
    check(`NO: ${name}`, denied(r) || r === "filas=0", r);
  }
  const noVisit = await as(c, null, async () => `upd=${(await q(`UPDATE shifts SET status='in_progress' WHERE id=$1 RETURNING id`, [ended])).length}`);
  check("NO marca «en curso» un turno sin su visita abierta", noVisit === "upd=0", noVisit);
  const othersUpd = await as(c, null, async () => {
    await insert(A, ended, c.owm, "check_in", 3 * 60);
    return `upd=${(await q(`UPDATE shifts SET status='in_progress' WHERE id=$1 RETURNING id`, [othersShift])).length}`;
  });
  check("NO marca «en curso» el turno de otra aunque tenga una visita propia abierta", othersUpd === "upd=0", othersUpd);
  const fns = (await q(`SELECT proname, prosecdef, proconfig::text AS cfg, has_function_privilege('pg_monitor', oid, 'EXECUTE') AS pub
                        FROM pg_proc WHERE proname IN ('app_worker_late_offline_check_in','app_worker_open_visit')`));
  check("funciones nuevas: SECURITY DEFINER, search_path fijo, sin EXECUTE para PUBLIC", fns.length === 2 && fns.every((f: any) => f.prosecdef && /search_path=pg_catalog, public/.test(f.cfg) && !f.pub), JSON.stringify(fns));
  const left = Number((await q(`SELECT count(*) FROM verification_events WHERE shift_id = ANY($1)`, [[ended, pending, cancelled, completed, old, othersShift, shiftB]]))[0].count);
  check("nada quedó guardado (todo revertido)", left === 0, `${left}`);

  await db.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `  (${r.detail})`}`);
  console.log(`\nRLS_LATE_OFFLINE_CHECK_IN ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
