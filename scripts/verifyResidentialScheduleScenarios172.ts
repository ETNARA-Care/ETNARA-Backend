/**
 * 172 · Hogares F2 — escenarios pedidos por la auditoría de GPT (27-nov) sobre 37fda04. Aplicación real por HTTP como
 * app_runtime, datos FICTICIOS, base PROPIA desechable.
 *   C1–C3  crear y asignar un turno individual (el mismo camino del portal: POST /shifts + POST /assignments) a la vez
 *          que otra administradora publica una semana con una entrada de la misma persona: franja idéntica y solape
 *          parcial, para el establecimiento y para una residente, en los dos órdenes. Nunca dos asignaciones solapadas,
 *          nunca dos turnos de la persona en la franja, la publicación es todo o nada y «Mi horario» muestra uno.
 *   C4     sin carrera: semana publicada primero y después un turno del establecimiento en la misma franja → 409.
 *   U1–U7  «Mi horario» refleja al momento: aceptar, modificar, cancelar, rechazar, reasignar, editar una entrada y
 *          republicar, quitar una entrada y republicar.
 *   A1–A3  agencias e independientes: crear un turno individual como hasta ahora (residente, asignar, aceptar,
 *          «Asignármelo», solapes) y establishmentId rechazado sin crear nada.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const serverUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!serverUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(serverUrl)) throw new Error("Hosted database refused");
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 1500) });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  if (!/^https?:\/\/127\.0\.0\.1:/.test(url)) throw new Error(`Salida de red bloqueada en la prueba: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";
process.env.EMAIL_SENDER_ADDRESS ??= "pruebas@example.invalid";
process.env.ACTIVATION_BASE_URL ??= "https://portal.example.invalid";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function futureMonday(weeksAhead: number): string {
  const now = new Date(Date.now() - 4 * 3_600_000);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const toMonday = (8 - d.getUTCDay()) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + toMonday + 7 * weeksAhead);
  return d.toISOString().slice(0, 10);
}
const plusDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function main() {
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  const dbName = `etnara_schedx_${randomBytes(4).toString("hex")}`;
  await srv.query(`CREATE DATABASE ${dbName}`);
  const su = new URL(serverUrl!); su.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: su.toString() }); await db.connect();
  { const log = console.log; console.log = () => undefined; try { await applyPendingMigrations(db, join(process.cwd(), "migrations")); } finally { console.log = log; } }
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const rt = new URL(su.toString()); rt.username = "app_runtime"; rt.password = runtimePassword;
  process.env.DATABASE_URL = rt.toString();
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const { resetFeatureWriteLimitForTests } = await import("../src/middleware/featureWriteLimit.js").catch(() => ({ resetFeatureWriteLimitForTests: () => undefined }));
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const errors500: string[] = [];
  const call = async (method: string, path: string, token: string, body?: Json) => {
    resetFeatureWriteLimitForTests();
    const res = await realFetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: Json = {}; try { json = JSON.parse(text); } catch { /* vacío */ }
    if (res.status >= 500) errors500.push(`${method} ${path} ${res.status} ${json.error ?? ""}`);
    return { status: res.status, body: json };
  };
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toLowerCase();
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types ORDER BY code LIMIT 1`)).rows[0].id;
  const H = (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'RESIDENTIAL_CARE_HOME','active') RETURNING id`, [`Hogar Escenarios ${tag}`])).rows[0].id;
  const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'Ficticia') RETURNING id`, [H])).rows[0].id;
  await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  await q(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'HOGAR_CALENDARIO',true)`, [H]);
  type P = { userId: string; token: string; owm?: string };
  const person = async (key: string, roles: string[], worker = false): Promise<P> => {
    const email = `scx-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, H])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, H, roles]);
    let owm: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Ficticia ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, H])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
    }
    const t = (await call("POST", "/auth/login", "", { email, password })).body.token as string;
    await call("POST", "/me/active-organization", t, { organizationId: H });
    return { userId, token: t, owm };
  };
  const admin1 = await person("admin1", ["ORGANIZATION_ADMIN"]), admin2 = await person("admin2", ["ORGANIZATION_ADMIN"]);
  const w1 = await person("w1", ["WORKER"], true);
  let n = 0;
  const establishment = async () => (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,$2) RETURNING id`, [H, `Casa ${++n}`])).rows[0].id;
  const S = `/organizations/${H}/residential/schedule`;
  const W = (l: string, w: string) => `${S}/establishments/${l}/weeks/${w}`;
  const shiftsOf = async (l: string) => (await q<{ n: number }>(`SELECT count(*)::int n FROM shifts s JOIN establishment_technical_rooms t ON t.room_id = s.room_id
    WHERE t.location_id = $1 AND s.status NOT IN ('cancelled','completed')`, [l])).rows[0].n;
  const week = futureMonday(1);

  const w2 = await person("w2", ["WORKER"], true);
  // Cuidadora sin la credencial requerida (no elegible).
  const w3 = await (async () => {
    const email = `scx-w3-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, H])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='WORKER'`, [m, H]);
    const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,'Ficticia no apta') RETURNING id`, [userId])).rows[0].id;
    const owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, H])).rows[0].id;
    return { owm };
  })();
  const L = await establishment();
  const resident = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,location_id,first_name,last_name) VALUES ($1,$2,'Residente','Ficticio') RETURNING id`, [H, L])).rows[0].id;
  const iso = (localDateTime: string) => new Date(`${localDateTime}:00-04:00`).toISOString();
  const mineOf = async (token: string, wkStart: string) => (await call("GET", `${S}/me/weeks/${wkStart}`, token)).body.schedule as Json;
  const activeAssignment = async (shiftId: string) => (await q<{ id: string; owm: string }>(`SELECT id, organization_worker_membership_id owm FROM assignments
    WHERE shift_id=$1 AND response_status IN ('pending','accepted')`, [shiftId])).rows;
  const overlapsOf = async (owm: string) => (await q<{ n: number }>(`SELECT count(*)::int n FROM assignments a1 JOIN shifts s1 ON s1.id=a1.shift_id
    JOIN assignments a2 ON a2.organization_worker_membership_id=a1.organization_worker_membership_id AND a2.id<>a1.id JOIN shifts s2 ON s2.id=a2.shift_id
    WHERE a1.organization_worker_membership_id=$1 AND a1.response_status IN ('pending','accepted') AND a2.response_status IN ('pending','accepted')
      AND s1.status<>'cancelled' AND s2.status<>'cancelled' AND s1.scheduled_start<s2.scheduled_end AND s2.scheduled_start<s1.scheduled_end`, [owm])).rows[0].n;
  const liveInSlot = async (owm: string, from: string, to: string) => (await q<{ n: number }>(`SELECT count(DISTINCT s.id)::int n FROM shifts s
    JOIN assignments a ON a.shift_id=s.id AND a.response_status IN ('pending','accepted')
    WHERE a.organization_worker_membership_id=$1 AND s.status<>'cancelled' AND s.scheduled_start<$3 AND s.scheduled_end>$2`, [owm, from, to])).rows[0].n;

  // ---------------------------------------------------------------- C. Creación simultánea y publicación
  {
    const runs: Json[] = [];
    for (let i = 0; i < 8; i++) {
      const exact = i % 2 === 0, forEstablishment = i % 4 < 2, createFirst = i < 4, gap = (i % 3) * 4;
      const wkC = futureMonday(4 + i);
      const entry = await call("POST", `${W(L, wkC)}/entries`, admin2.token, { startsAt: `${wkC}T${exact ? "07:00" : "11:00"}`, durationMinutes: 480, membershipId: w1.owm });
      let shiftId = "";
      const createAndAssign = async () => {
        const s = await call("POST", `/organizations/${H}/shifts`, admin1.token, {
          ...(forEstablishment ? { establishmentId: L } : { careRecipientId: resident }), scheduledStart: iso(`${wkC}T07:00`), scheduledEnd: iso(`${wkC}T15:00`) });
        if (s.status !== 201) return { create: s.status, assign: 0, error: s.body.error };
        shiftId = s.body.shift.id;
        const a = await call("POST", `/organizations/${H}/shifts/${shiftId}/assignments`, admin1.token, { organizationWorkerMembershipId: w1.owm });
        return { create: 201, assign: a.status, error: a.body.error };
      };
      const publish = () => call("POST", `${W(L, wkC)}/publish`, admin2.token);
      const [ca, p] = createFirst
        ? await Promise.all([createAndAssign(), sleep(gap).then(publish)])
        : await Promise.all([sleep(gap).then(createAndAssign), publish()]).then(([x, y]) => [x, y] as const);
      const fromIso = iso(`${wkC}T07:00`), toIso = iso(`${wkC}T19:00`);
      const fromCalendar = (await q<{ n: number }>(`SELECT count(*)::int n FROM schedule_week_shifts e JOIN schedule_weeks w ON w.id=e.week_id
        WHERE w.location_id=$1 AND w.week_start=$2 AND e.shift_id IS NOT NULL`, [L, wkC])).rows[0].n;
      const publications = (await q<{ n: number }>(`SELECT count(*)::int n FROM schedule_week_publications pb JOIN schedule_weeks w ON w.id=pb.week_id
        WHERE w.location_id=$1 AND w.week_start=$2`, [L, wkC])).rows[0].n;
      const individualActive = shiftId ? (await activeAssignment(shiftId)).length : -1;
      const m = await mineOf(w1.token, wkC);
      const mineMonday = (m.days as Json[])[0].shiftIds.length;
      const published = p.status === 200, assigned = ca.assign === 201;
      const ok = entry.status === 201 && ca.create === 201 && published !== assigned
        && (await overlapsOf(w1.owm!)) === 0 && (await liveInSlot(w1.owm!, fromIso, toIso)) === 1 && mineMonday === 1
        && (published ? fromCalendar === 1 && publications === 1 && individualActive === 0 : fromCalendar === 0 && publications === 0 && individualActive === 1);
      runs.push({ i, exact, target: forEstablishment ? "establecimiento" : "residente", primero: createFirst ? "crear" : "publicar", gap,
        publicar: p.status, publicarError: p.body.error, asignar: ca.assign, asignarError: ca.error, delCalendario: fromCalendar, publicaciones: publications, mineMonday, ok });
    }
    check("C1. Franja idéntica (4 carreras: establecimiento y residente, los dos órdenes): gana uno, el otro recibe 409; nunca dos turnos de la persona en la franja",
      runs.filter((r) => r.exact).every((r) => r.ok), runs.filter((r) => r.exact));
    check("C2. Solape parcial 07–15 frente a 11–19 (4 carreras): gana uno; nunca dos asignaciones solapadas",
      runs.filter((r) => !r.exact).every((r) => r.ok), runs.filter((r) => !r.exact));
    check("C3. La publicación es todo o nada (si pierde, ni turnos ni versión publicada; si gana, una versión y un turno) y «Mi horario» muestra un solo turno ese lunes en las 8 carreras; el turno individual que pierde queda sin asignar en «Turnos»",
      runs.every((r) => r.ok) && runs.every((r) => r.mineMonday === 1), runs.map((r) => ({ i: r.i, publicar: r.publicar, asignar: r.asignar, delCalendario: r.delCalendario, mineMonday: r.mineMonday })));
  }

  // C4. Orden fijo, sin carrera: la semana se publica primero y después se crea y asigna un turno del establecimiento en
  // la misma franja (idéntica y parcial) → la asignación se rechaza (409) y queda un solo turno de la persona.
  {
    const out: Json[] = []; let ok = true;
    for (const [k, start] of [["idéntica", "07:00"], ["parcial", "11:00"]] as const) {
      const wkS = futureMonday(12 + (k === "idéntica" ? 0 : 1));
      await call("POST", `${W(L, wkS)}/entries`, admin2.token, { startsAt: `${wkS}T${start}`, durationMinutes: 480, membershipId: w1.owm });
      const p = await call("POST", `${W(L, wkS)}/publish`, admin2.token);
      const s = await call("POST", `/organizations/${H}/shifts`, admin1.token, { establishmentId: L, scheduledStart: iso(`${wkS}T07:00`), scheduledEnd: iso(`${wkS}T15:00`) });
      const a = await call("POST", `/organizations/${H}/shifts/${s.body.shift?.id}/assignments`, admin1.token, { organizationWorkerMembershipId: w1.owm });
      const m = await mineOf(w1.token, wkS);
      const pass = p.status === 200 && s.status === 201 && a.status === 409 && (m.days as Json[])[0].shiftIds.length === 1 && (await overlapsOf(w1.owm!)) === 0;
      ok &&= pass; out.push({ k, publicar: p.status, crear: s.status, asignar: [a.status, a.body.error], mine: (m.days as Json[])[0].shiftIds.length });
    }
    check("C4. Sin carrera, publicada primero: crear y asignar después un turno del establecimiento en la misma franja (idéntica o parcial) → 409; un solo turno en «Mi horario»", ok, out);
  }

  // ---------------------------------------------------------------- U. «Mi horario» se actualiza
  const wkU = futureMonday(16);
  const ids = (s: Json) => (s.shifts as Json[]).map((x) => x.shiftId as string);
  const mkShift = async (day: number, from: string, to: string) =>
    (await call("POST", `/organizations/${H}/shifts`, admin1.token, { establishmentId: L, scheduledStart: iso(`${plusDays(wkU, day)}T${from}`), scheduledEnd: iso(`${plusDays(wkU, day)}T${to}`) })).body.shift.id as string;
  const sA = await mkShift(0, "07:00", "15:00");
  await call("POST", `/organizations/${H}/shifts/${sA}/assignments`, admin1.token, { organizationWorkerMembershipId: w1.owm });
  const u0 = await mineOf(w1.token, wkU);
  const acc = await call("POST", `/organizations/${H}/me/shifts/${sA}/respond`, w1.token, { decision: "accepted" });
  const u1 = await mineOf(w1.token, wkU);
  check("U1. Asignado: aparece como pendiente; al aceptarlo, como aceptado (8 h ese lunes)",
    ids(u0).includes(sA) && u0.shifts[0].assignmentStatus === "pending" && acc.status === 200 && u1.shifts[0].assignmentStatus === "accepted" && u1.days[0].minutes === 480,
    { u0: u0.shifts, acc: acc.status, u1: u1.shifts });
  const mod = await call("PATCH", `/organizations/${H}/shifts/${sA}`, admin1.token, { scheduledStart: iso(`${wkU}T08:00`), scheduledEnd: iso(`${wkU}T17:00`) });
  const u2 = await mineOf(w1.token, wkU);
  const sA2 = (u2.shifts as Json[]).find((x) => x.shiftId === sA);
  check("U2. Modificado por la administración: la nueva hora (08:00–17:00) y 9 h ese día",
    mod.status === 200 && sA2?.startsAt === `${wkU}T08:00` && sA2?.endsAt === `${wkU}T17:00` && u2.days[0].minutes === 540 && u2.totalMinutes === 540, { mod: mod.status, sA2, days: u2.days });
  const sB = await mkShift(1, "07:00", "15:00");
  await call("POST", `/organizations/${H}/shifts/${sB}/assignments`, admin1.token, { organizationWorkerMembershipId: w1.owm });
  const beforeReject = ids(await mineOf(w1.token, wkU));
  const rej = await call("POST", `/organizations/${H}/me/shifts/${sB}/respond`, w1.token, { decision: "rejected", reason: "Motivo ficticio" });
  const u4 = await mineOf(w1.token, wkU);
  check("U3. Rechazado por la cuidadora: desaparece de «Mi horario» (estaba antes)", beforeReject.includes(sB) && rej.status === 200 && !ids(u4).includes(sB) && u4.days[1].minutes === 0,
    { beforeReject, rej: rej.status, after: ids(u4) });
  const sC = await mkShift(2, "07:00", "15:00");
  await call("POST", `/organizations/${H}/shifts/${sC}/assignments`, admin1.token, { organizationWorkerMembershipId: w1.owm });
  const beforeReassign = ids(await mineOf(w1.token, wkU));
  const aC = (await activeAssignment(sC))[0];
  const rm = await call("PATCH", `/organizations/${H}/shifts/${sC}/assignments/${aC.id}`, admin1.token, { reason: "Reasignación ficticia" });
  const re = await call("POST", `/organizations/${H}/shifts/${sC}/assignments`, admin1.token, { organizationWorkerMembershipId: w2.owm });
  const u5a = await mineOf(w1.token, wkU), u5b = await mineOf(w2.token, wkU);
  check("U4. Reasignado a una compañera: desaparece de la suya y aparece en la de la compañera",
    beforeReassign.includes(sC) && rm.status === 200 && re.status === 201 && !ids(u5a).includes(sC) && ids(u5b).includes(sC) && u5a.days[2].minutes === 0,
    { rm: rm.status, re: re.status, w1: ids(u5a), w2: ids(u5b) });
  const cancel = await call("POST", `/organizations/${H}/shifts/${sA}/cancel`, admin1.token, { reason: "Cancelación ficticia" });
  const u3 = await mineOf(w1.token, wkU);
  check("U5. Cancelado: desaparece y sus horas salen del total", cancel.status === 200 && !ids(u3).includes(sA) && u3.days[0].minutes === 0 && u3.totalMinutes === 0,
    { cancel: [cancel.status, cancel.body.error], after: ids(u3), total: u3.totalMinutes });
  // Calendario semanal: entrada publicada, editada y republicada, reasignada y quitada.
  const thu = plusDays(wkU, 3);
  const e1 = (await call("POST", `${W(L, wkU)}/entries`, admin1.token, { startsAt: `${thu}T07:00`, durationMinutes: 480, membershipId: w1.owm })).body.entry.id as string;
  const p1 = await call("POST", `${W(L, wkU)}/publish`, admin1.token);
  const c1 = (await mineOf(w1.token, wkU)).shifts as Json[];
  const ed = await call("PATCH", `${S}/entries/${e1}`, admin1.token, { startsAt: `${thu}T10:00`, durationMinutes: 360 });
  const draftMine = (await mineOf(w1.token, wkU)).shifts as Json[];
  const p2 = await call("POST", `${W(L, wkU)}/publish`, admin1.token);
  const c2 = await mineOf(w1.token, wkU);
  check("U6. Entrada del calendario: publicada aparece (07:00); editada sigue igual mientras es borrador; al republicar sale la nueva hora (10:00–16:00, 6 h) y nunca las dos",
    p1.status === 200 && c1.length === 1 && c1[0].startsAt === `${thu}T07:00` && ed.status === 200
    && draftMine.length === 1 && draftMine[0].startsAt === `${thu}T07:00`
    && p2.status === 200 && (c2.shifts as Json[]).length === 1 && c2.shifts[0].startsAt === `${thu}T10:00` && c2.days[3].minutes === 360,
    { p1: p1.status, c1, ed: ed.status, draftMine, p2: [p2.status, p2.body.error], c2: c2.shifts });
  // Una entrada publicada no se toca: editarla crea otra (la anterior queda para quitar). Se sigue la vigente.
  const e2 = ed.body.entry.id as string;
  const rs1 = await call("PATCH", `${S}/entries/${e2}`, admin1.token, { membershipId: w2.owm });
  const p3 = await call("POST", `${W(L, wkU)}/publish`, admin1.token);
  const r1 = await mineOf(w1.token, wkU), r2 = await mineOf(w2.token, wkU);
  const del = await call("DELETE", `${S}/entries/${rs1.body.entry?.id}`, admin1.token);
  const p4 = await call("POST", `${W(L, wkU)}/publish`, admin1.token);
  const d2 = await mineOf(w2.token, wkU);
  check("U7. Reasignada en el calendario y republicada: pasa a la compañera (e1 ya sustituida no se puede editar: 409); quitada y republicada: desaparece; la compañera conserva el reasignado por «Turnos»",
    e2 !== e1 && (await call("PATCH", `${S}/entries/${e1}`, admin1.token, { durationMinutes: 300 })).status === 409
    && rs1.status === 200 && rs1.body.entry?.id !== e2 && p3.status === 200 && (r1.shifts as Json[]).length === 0 && (r2.shifts as Json[]).some((x) => x.startsAt === `${thu}T10:00`)
    && del.status === 200 && p4.status === 200 && !(d2.shifts as Json[]).some((x) => x.startsAt === `${thu}T10:00`) && ids(d2).includes(sC),
    { rs1: rs1.status, p3: [p3.status, p3.body.error], w1: r1.shifts, w2: r2.shifts, del: del.status, p4: [p4.status, p4.body.error], d2: d2.shifts });

  // ---------------------------------------------------------------- A. Agencias e independientes
  const otherOrg = async (type: string, name: string) => {
    const O = (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2,'active') RETURNING id`, [name, type])).rows[0].id;
    const ors = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'Ficticia') RETURNING id`, [O])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [ors, bls]);
    const mk = async (key: string, roles: string[], worker: boolean) => {
      const email = `scx-${key}-${tag}@example.invalid`;
      const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
      const mm = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, O])).rows[0].id;
      await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [mm, O, roles]);
      let owm = "";
      if (worker) {
        const wid = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Ficticia ${key}`])).rows[0].id;
        owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [wid, O])).rows[0].id;
        await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [wid, bls]);
      }
      const t = (await call("POST", "/auth/login", "", { email, password })).body.token as string;
      await call("POST", "/me/active-organization", t, { organizationId: O });
      return { token: t, owm };
    };
    return { O, mk };
  };
  const shiftCount = async (o: string) => (await q<{ n: number }>(`SELECT count(*)::int n FROM shifts WHERE organization_id=$1`, [o])).rows[0].n;
  const recipientIn = async (o: string, token: string) => {
    const r = await call("POST", `/organizations/${o}/care-recipients`, token, { firstName: "Persona", lastName: "Ficticia" });
    return { status: r.status, id: (r.body.careRecipient ?? r.body.recipient ?? r.body).id as string };
  };
  const wkA = futureMonday(20);
  {
    const ag = await otherOrg("HOME_CARE_AGENCY", `Agencia Escenarios ${tag}`);
    const aAdm = await ag.mk("aadm", ["ORGANIZATION_ADMIN"], false), aCg = await ag.mk("acg", ["WORKER"], true);
    const loc = (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,'Oficina') RETURNING id`, [ag.O])).rows[0].id;
    const rec = await recipientIn(ag.O, aAdm.token);
    const s1 = await call("POST", `/organizations/${ag.O}/shifts`, aAdm.token, { careRecipientId: rec.id, scheduledStart: iso(`${wkA}T07:00`), scheduledEnd: iso(`${wkA}T15:00`) });
    const as1 = await call("POST", `/organizations/${ag.O}/shifts/${s1.body.shift?.id}/assignments`, aAdm.token, { organizationWorkerMembershipId: aCg.owm });
    const rp1 = await call("POST", `/organizations/${ag.O}/me/shifts/${s1.body.shift?.id}/respond`, aCg.token, { decision: "accepted" });
    const s2 = await call("POST", `/organizations/${ag.O}/shifts`, aAdm.token, { careRecipientId: rec.id, scheduledStart: iso(`${wkA}T11:00`), scheduledEnd: iso(`${wkA}T19:00`) });
    const as2 = await call("POST", `/organizations/${ag.O}/shifts/${s2.body.shift?.id}/assignments`, aAdm.token, { organizationWorkerMembershipId: aCg.owm });
    const myA = await call("GET", `/organizations/${ag.O}/me/shifts`, aCg.token);
    const before = await shiftCount(ag.O);
    const e1 = await call("POST", `/organizations/${ag.O}/shifts`, aAdm.token, { establishmentId: loc, scheduledStart: iso(`${wkA}T07:00`), scheduledEnd: iso(`${wkA}T15:00`) });
    const e2 = await call("POST", `/organizations/${ag.O}/shifts`, aAdm.token, { establishmentId: loc, careRecipientId: rec.id, scheduledStart: iso(`${wkA}T20:00`), scheduledEnd: iso(`${wkA}T22:00`) });
    const after = await shiftCount(ag.O);
    const mine1 = (myA.body.shifts as Json[] | undefined)?.find((x) => x.id === s1.body.shift?.id);
    check("A1. Agencia: crear un turno para una persona atendida (201, sin habitación), asignar (201), aceptar (200), y un solape de la misma cuidadora → 409; la cuidadora lo ve en sus turnos sin datos de hogar",
      rec.status === 201 && s1.status === 201 && s1.body.shift.room_id === null && s1.body.shift.care_recipient_id === rec.id && as1.status === 201 && rp1.status === 200
      && s2.status === 201 && as2.status === 409 && !!mine1 && (mine1.establishment_name ?? null) === null,
      { rec: rec.status, s1: [s1.status, s1.body.shift?.room_id], as1: as1.status, rp1: rp1.status, as2: [as2.status, as2.body.error], mine1 });
    check("A2. Agencia: establishmentId (solo o junto a una persona) → 400 y no se crea nada",
      e1.status === 400 && e1.body.error === "ESTABLISHMENT_NOT_IN_ORGANIZATION" && e2.status === 400 && after === before, { e1: e1.body, e2: [e2.status, e2.body.error], before, after });
  }
  {
    await q(`SELECT app_ops_authorize_modality_activation('INDEPENDENT_PROVIDER','Prueba 172','Prueba ficticia de escenarios F2 (172)',5)`);
    await q(`UPDATE platform_modalities SET enabled=true WHERE code='INDEPENDENT_PROVIDER'`);
    const ind = await otherOrg("INDEPENDENT_PROVIDER", `Práctica Escenarios ${tag}`);
    const op = await ind.mk("ind", ["ORGANIZATION_ADMIN", "WORKER"], true);
    const rec = await recipientIn(ind.O, op.token);
    const s1 = await call("POST", `/organizations/${ind.O}/shifts`, op.token, { careRecipientId: rec.id, scheduledStart: iso(`${wkA}T07:00`), scheduledEnd: iso(`${wkA}T15:00`) });
    const sa1 = await call("POST", `/organizations/${ind.O}/me/shifts/${s1.body.shift?.id}/self-assign`, op.token, {});
    const s2 = await call("POST", `/organizations/${ind.O}/shifts`, op.token, { careRecipientId: rec.id, scheduledStart: iso(`${wkA}T11:00`), scheduledEnd: iso(`${wkA}T19:00`) });
    const sa2 = await call("POST", `/organizations/${ind.O}/me/shifts/${s2.body.shift?.id}/self-assign`, op.token, {});
    const before = await shiftCount(ind.O);
    const loc = (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,'Consulta') RETURNING id`, [ind.O])).rows[0].id;
    const e1 = await call("POST", `/organizations/${ind.O}/shifts`, op.token, { establishmentId: loc, scheduledStart: iso(`${wkA}T07:00`), scheduledEnd: iso(`${wkA}T15:00`) });
    const after = await shiftCount(ind.O);
    const sched = await call("GET", `/organizations/${ind.O}/residential/schedule/me/weeks/${wkA}`, op.token);
    check("A3. Independiente: crear un turno para su cliente (201), «Asignármelo» (201) y un solape → rechazado; establishmentId → 400 sin crear nada; «Mi horario» de hogares cerrado (403)",
      rec.status === 201 && s1.status === 201 && s1.body.shift.room_id === null && sa1.status === 201 && s2.status === 201 && sa2.status >= 400 && sa2.status < 500
      && e1.status === 400 && after === before && sched.status === 403,
      { rec: rec.status, s1: s1.status, sa1: [sa1.status, sa1.body.error], s2: s2.status, sa2: [sa2.status, sa2.body.error], e1: [e1.status, e1.body.error], before, after, sched: [sched.status, sched.body.error] });
  }

  check("K0. Ningún error 5xx", errors500.length === 0, errors500);
  server.close(); await pool.end(); await db.end();
  await srv.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await srv.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass && !process.env.SHOW_DETAIL ? "" : `\n      ${r.detail}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
