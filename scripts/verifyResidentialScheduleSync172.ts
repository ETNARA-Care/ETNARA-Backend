/**
 * 172 · Hogares F2: turnos individuales y calendario semanal sincronizados, y «Mi horario» del cuidador (decisiones de
 * Rafa, 27-nov). Aplicación real por HTTP como app_runtime, datos FICTICIOS, base PROPIA desechable.
 *   I1–I4  «Crear turno» del establecimiento sin residente; la semana lo muestra (solo lectura), cuenta sus horas y lo
 *          usa en los avisos; publicar nunca duplica; cada turno aparece una sola vez; agencias sin cambios;
 *   I5     asignar un turno individual y publicar uno solapado de la misma persona a la vez: nunca dos solapados;
 *   I6     elegibilidad igual en turnos individuales;
 *   M1–M5  «Mi horario»: solo sus turnos (individuales y publicados), 7 días con horas y días sin turnos, nocturnos
 *          repartidos, semanas anteriores y futuras, nunca borradores ni compañeros; accesos y puertas.
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
  const dbName = `etnara_scheds_${randomBytes(4).toString("hex")}`;
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
  const H = (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'RESIDENTIAL_CARE_HOME','active') RETURNING id`, [`Hogar Sincronia ${tag}`])).rows[0].id;
  const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'Ficticia') RETURNING id`, [H])).rows[0].id;
  await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  await q(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'HOGAR_CALENDARIO',true)`, [H]);
  type P = { userId: string; token: string; owm?: string };
  const person = async (key: string, roles: string[], worker = false): Promise<P> => {
    const email = `scs-${key}-${tag}@example.invalid`;
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
    const email = `scs-w3-${tag}@example.invalid`;
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
  const wk = futureMonday(2);

  // I1. «Crear turno» del establecimiento, sin residente.
  const est = await call("POST", `/organizations/${H}/shifts`, admin1.token, { establishmentId: L, scheduledStart: iso(`${wk}T07:00`), scheduledEnd: iso(`${wk}T15:00`) });
  const both = await call("POST", `/organizations/${H}/shifts`, admin1.token, { establishmentId: L, careRecipientId: resident, scheduledStart: iso(`${wk}T07:00`), scheduledEnd: iso(`${wk}T15:00`) });
  const foreign = await call("POST", `/organizations/${H}/shifts`, admin1.token, { establishmentId: randomUUID(), scheduledStart: iso(`${wk}T07:00`), scheduledEnd: iso(`${wk}T15:00`) });
  const A = (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`Agencia Sincronia ${tag}`])).rows[0].id;
  const AL = (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,'Oficina') RETURNING id`, [A])).rows[0].id;
  const aAdminEmail = `scs-aadmin-${tag}@example.invalid`;
  const aAdmin = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [aAdminEmail, hash])).rows[0].id;
  const am = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [aAdmin, A])).rows[0].id;
  await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='ORGANIZATION_ADMIN'`, [am, A]);
  const tA = (await call("POST", "/auth/login", "", { email: aAdminEmail, password })).body.token as string;
  await call("POST", "/me/active-organization", tA, { organizationId: A });
  const agency = await call("POST", `/organizations/${A}/shifts`, tA, { establishmentId: AL, scheduledStart: iso(`${wk}T07:00`), scheduledEnd: iso(`${wk}T15:00`) });
  const estRow = (await q<{ tech: boolean; rec: string | null }>(`SELECT app_is_technical_room(room_id) tech, care_recipient_id rec FROM shifts WHERE id=$1`, [est.body.shift?.id ?? randomUUID()])).rows[0];
  check("I1. «Crear turno» del establecimiento sin residente: 201 y se guarda en el establecimiento (la respuesta nunca muestra la habitación técnica); con residente a la vez, de otra organización o en una agencia → 400",
    est.status === 201 && est.body.shift?.room_id === null && est.body.shift?.care_recipient_id === null && estRow?.tech === true && estRow?.rec === null
    && both.status === 400 && foreign.status === 400 && foreign.body.error === "ESTABLISHMENT_NOT_IN_ORGANIZATION" && agency.status === 400 && agency.body.error === "ESTABLISHMENT_NOT_IN_ORGANIZATION",
    { est: [est.status, est.body.shift?.room_id], both: both.status, foreign: foreign.body, agency: agency.body });
  const estShift = est.body.shift.id as string;
  const resShift = (await call("POST", `/organizations/${H}/shifts`, admin1.token, { careRecipientId: resident, scheduledStart: iso(`${plusDays(wk, 1)}T09:00`), scheduledEnd: iso(`${plusDays(wk, 1)}T11:00`) })).body.shift.id as string;
  const asg = await call("POST", `/organizations/${H}/shifts/${estShift}/assignments`, admin1.token, { organizationWorkerMembershipId: w1.owm });

  // I2. La semana muestra los individuales (solo lectura), cuenta sus horas y no duplica los del calendario.
  await call("POST", `${W(L, wk)}/entries`, admin1.token, { startsAt: `${plusDays(wk, 2)}T07:00`, durationMinutes: 480, membershipId: w2.owm });
  const pub = await call("POST", `${W(L, wk)}/publish`, admin1.token);
  const wv = (await call("GET", W(L, wk), admin1.token)).body.schedule;
  const ind = wv.individualShifts as Json[];
  const kinds = ind.map((i) => i.target).sort();
  const calendarShiftIds = (wv.entries as Json[]).map(() => null);
  const calShift = (await q<{ id: string }>(`SELECT e.shift_id id FROM schedule_week_shifts e JOIN schedule_weeks w ON w.id=e.week_id WHERE w.location_id=$1 AND e.shift_id IS NOT NULL`, [L])).rows.map((r) => r.id);
  const list = await call("GET", `/organizations/${H}/shifts`, admin1.token);
  const ids = (list.body.shifts as Json[]).map((s) => s.id);
  const once = [estShift, resShift, ...calShift].every((id) => ids.filter((x: string) => x === id).length === 1);
  check("I2. La semana muestra los turnos individuales del establecimiento (del establecimiento y de un residente, con su persona), cuenta sus horas, y los del calendario no se repiten como individuales; en «Turnos» cada turno aparece una sola vez",
    asg.status === 201 && pub.status === 200 && ind.length === 2 && JSON.stringify(kinds) === JSON.stringify(["establishment", "resident"])
    && ind.some((i) => i.shiftId === estShift && i.membershipId === w1.owm && i.workerName) && !ind.some((i) => calShift.includes(i.shiftId))
    && wv.summary.totalMinutes === 480 + 120 + 480 && once && calendarShiftIds.length === 1,
    { asg: asg.status, pub: pub.status, ind, total: wv.summary.totalMinutes, once });

  // I3. Avisos: una entrada de la misma persona que se solapa o coincide con un turno individual bloquea la publicación.
  const wk2 = plusDays(wk, 7);
  const ind2 = (await call("POST", `/organizations/${H}/shifts`, admin1.token, { establishmentId: L, scheduledStart: iso(`${wk2}T07:00`), scheduledEnd: iso(`${wk2}T15:00`) })).body.shift.id as string;
  await call("POST", `/organizations/${H}/shifts/${ind2}/assignments`, admin1.token, { organizationWorkerMembershipId: w1.owm });
  const same = await call("POST", `${W(L, wk2)}/entries`, admin1.token, { startsAt: `${wk2}T07:00`, durationMinutes: 480, membershipId: w1.owm });
  const g = (await call("GET", W(L, wk2), admin1.token)).body.schedule;
  const blocked = await call("POST", `${W(L, wk2)}/publish`, admin1.token);
  const created = (await q<{ n: number }>(`SELECT count(*)::int n FROM schedule_week_shifts e JOIN schedule_weeks w ON w.id=e.week_id WHERE w.location_id=$1 AND w.week_start=$2 AND e.shift_id IS NOT NULL`, [L, wk2])).rows[0].n;
  check("I3. Una entrada que coincide con un turno individual de la misma persona sale como duplicado y bloquea la publicación (409, nada creado): nunca dos turnos para la misma persona y franja",
    same.status === 201 && g.warnings.some((w: Json) => w.type === "duplicate" && w.shiftIds?.includes(ind2) && w.entryIds.includes(same.body.entry.id))
    && blocked.status === 409 && blocked.body.error === "RESIDENTIAL_SCHEDULE_OVERLAP" && created === 0,
    { warnings: g.warnings, blocked: blocked.body, created });
  // I4. Solape parcial también, y quitar la entrada lo resuelve.
  await call("DELETE", `${S}/entries/${same.body.entry.id}`, admin1.token);
  const partial = await call("POST", `${W(L, wk2)}/entries`, admin1.token, { startsAt: `${wk2}T13:00`, durationMinutes: 240, membershipId: w1.owm });
  const g2 = (await call("GET", W(L, wk2), admin1.token)).body.schedule;
  await call("DELETE", `${S}/entries/${partial.body.entry.id}`, admin1.token);
  const ok2 = await call("POST", `${W(L, wk2)}/entries`, admin1.token, { startsAt: `${wk2}T15:00`, durationMinutes: 480, membershipId: w1.owm });
  const pub2 = await call("POST", `${W(L, wk2)}/publish`, admin1.token);
  check("I4. Solape parcial con un turno individual → aviso de solape; una entrada contigua (15:00 tras un turno hasta las 15:00) se publica",
    g2.warnings.some((w: Json) => w.type === "overlap" && w.shiftIds?.includes(ind2)) && ok2.status === 201 && pub2.status === 200, { warnings: g2.warnings, pub2: pub2.status });

  // I5. Concurrencia: asignar un turno individual y publicar uno solapado de la misma persona a la vez.
  {
    const out: Json[] = []; let ok = true;
    for (let i = 0; i < 3; i++) {
      const wk3 = plusDays(wk, 14 + 7 * i);
      const s3 = (await call("POST", `/organizations/${H}/shifts`, admin1.token, { establishmentId: L, scheduledStart: iso(`${wk3}T07:00`), scheduledEnd: iso(`${wk3}T15:00`) })).body.shift.id as string;
      await call("POST", `${W(L, wk3)}/entries`, admin2.token, { startsAt: `${wk3}T09:00`, durationMinutes: 480, membershipId: w2.owm });
      const [a, p] = await Promise.all([
        call("POST", `/organizations/${H}/shifts/${s3}/assignments`, admin1.token, { organizationWorkerMembershipId: w2.owm }),
        call("POST", `${W(L, wk3)}/publish`, admin2.token),
      ]);
      const overlaps = (await q<{ n: number }>(`SELECT count(*)::int n FROM assignments a1 JOIN shifts s1 ON s1.id=a1.shift_id
        JOIN assignments a2 ON a2.organization_worker_membership_id=a1.organization_worker_membership_id AND a2.id<>a1.id JOIN shifts s2 ON s2.id=a2.shift_id
        WHERE a1.organization_worker_membership_id=$1 AND a1.response_status IN ('pending','accepted') AND a2.response_status IN ('pending','accepted')
          AND s1.status<>'cancelled' AND s2.status<>'cancelled' AND s1.scheduled_start<s2.scheduled_end AND s2.scheduled_start<s1.scheduled_end`, [w2.owm])).rows[0].n;
      const pass = overlaps === 0 && ((a.status === 201) !== (p.status === 200));
      ok &&= pass; out.push({ asignar: a.status, publicar: p.status, error: a.status === 201 ? p.body.error : a.body.error, overlaps });
    }
    check("I5. Asignar un turno individual y publicar a la vez uno solapado de la misma persona: gana uno y nunca quedan dos asignaciones solapadas (3 repeticiones)", ok, out);
  }

  // I6. Elegibilidad igual en los turnos individuales.
  const s6 = (await call("POST", `/organizations/${H}/shifts`, admin1.token, { establishmentId: L, scheduledStart: iso(`${plusDays(wk, 3)}T07:00`), scheduledEnd: iso(`${plusDays(wk, 3)}T15:00`) })).body.shift.id as string;
  const a6 = await call("POST", `/organizations/${H}/shifts/${s6}/assignments`, admin1.token, { organizationWorkerMembershipId: w3.owm });
  check("I6. Elegibilidad: una cuidadora sin la credencial requerida no se puede asignar a un turno individual del establecimiento (409)", a6.status === 409, a6.body);

  // M. «Mi horario».
  const night = (await call("POST", `/organizations/${H}/shifts`, admin1.token, { establishmentId: L, scheduledStart: iso(`${plusDays(wk, 6)}T23:00`), scheduledEnd: iso(`${plusDays(wk, 7)}T07:00`) })).body.shift.id as string;
  await call("POST", `/organizations/${H}/shifts/${night}/assignments`, admin1.token, { organizationWorkerMembershipId: w1.owm });
  const wkDraft = plusDays(wk, 70);
  await call("POST", `${W(L, wkDraft)}/entries`, admin1.token, { startsAt: `${wkDraft}T07:00`, durationMinutes: 480, membershipId: w1.owm });
  const mine = await call("GET", `${S}/me/weeks/${wk}`, w1.token);
  const m = mine.body.schedule;
  const shownIds = (m?.shifts ?? []).map((x: Json) => x.shiftId);
  check("M1. «Mi horario»: solo sus turnos de la semana (el individual del establecimiento y el nocturno), con el nombre del establecimiento y nunca la habitación técnica; ni el turno del calendario de una compañera",
    mine.status === 200 && shownIds.includes(estShift) && shownIds.includes(night) && !calShift.some((id) => shownIds.includes(id))
    && m.shifts.every((x: Json) => x.establishmentName && !("roomId" in x)), { status: mine.status, shownIds, calShift });
  const days = m.days as Json[];
  const sunday = days[6], monday = days[0];
  check("M2. 7 días con sus horas: 8 h el lunes, días sin turnos a 0 y el nocturno del domingo reparte 1 h dentro de la semana (el total no cuenta lo que cae fuera)",
    days.length === 7 && monday.minutes === 480 && days.filter((d) => d.minutes === 0).length === 5 && sunday.minutes === 60
    && sunday.shiftIds.includes(night) && m.totalMinutes === 540, { days, total: m.totalMinutes });
  const prev = await call("GET", `${S}/me/weeks/${plusDays(wk, -7)}`, w1.token);
  const next = await call("GET", `${S}/me/weeks/${plusDays(wk, 7)}`, w1.token);
  const nextIds = (next.body.schedule?.shifts ?? []).map((x: Json) => x.shiftId);
  const draftWeek = await call("GET", `${S}/me/weeks/${wkDraft}`, w1.token);
  const nextMonday = next.body.schedule?.days?.[0]?.minutes;
  check("M3. Semanas anteriores y siguientes: la anterior vacía; la siguiente con su turno individual, el publicado y el final del nocturno del domingo (lunes 7 + 8 + 8 h); la semana con solo un borrador, vacía",
    prev.status === 200 && prev.body.schedule.shifts.length === 0 && next.status === 200 && nextIds.includes(ind2) && nextIds.includes(night) && nextIds.length === 3
    && nextMonday === 420 + 480 + 480 && next.body.schedule.totalMinutes === 1380
    && draftWeek.status === 200 && draftWeek.body.schedule.shifts.length === 0, { prev: prev.body.schedule?.shifts, nextIds, nextMonday, draft: draftWeek.body.schedule?.shifts });
  const colleague = await call("GET", `${S}/me/weeks/${wk}`, w2.token);
  const cIds = (colleague.body.schedule?.shifts ?? []).map((x: Json) => x.shiftId);
  check("M4. La compañera ve solo los suyos (el del calendario publicado), nunca los de w1",
    colleague.status === 200 && calShift.every((id) => cIds.includes(id)) && !cIds.includes(estShift) && !cIds.includes(night), { cIds });
  const adminMe = await call("GET", `${S}/me/weeks/${wk}`, admin1.token);
  const badWeek = await call("GET", `${S}/me/weeks/${plusDays(wk, 1)}`, w1.token);
  const agencyMe = await call("GET", `/organizations/${A}/residential/schedule/me/weeks/${wk}`, tA);
  await q(`UPDATE organization_features SET enabled=false WHERE organization_id=$1 AND feature_code='HOGAR_CALENDARIO'`, [H]);
  const off = await call("GET", `${S}/me/weeks/${wk}`, w1.token);
  await q(`UPDATE organization_features SET enabled=true WHERE organization_id=$1 AND feature_code='HOGAR_CALENDARIO'`, [H]);
  check("M5. Puertas: sin perfil de personal 403; semana que no empieza en lunes 400; agencia 403 MODALITY_NOT_AVAILABLE; con HOGAR_CALENDARIO apagado 404",
    adminMe.status === 403 && adminMe.body.error === "RESIDENTIAL_SCHEDULE_STAFF_ONLY" && badWeek.status === 400
    && agencyMe.status === 403 && agencyMe.body.error === "MODALITY_NOT_AVAILABLE" && off.status === 404 && off.body.error === "FEATURE_NOT_ENABLED",
    { adminMe: adminMe.body, badWeek: badWeek.status, agencyMe: agencyMe.body, off: off.body });
  const staffDb = await (async () => {
    const c = new pg.Client({ connectionString: rt.toString() }); await c.connect();
    await c.query("BEGIN"); await c.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [w1.userId, H]);
    const r = await c.query(`SELECT (SELECT count(*)::int FROM schedule_week_shifts) e, (SELECT count(*)::int FROM shifts WHERE id = ANY($1::uuid[])) others`, [calShift]);
    await c.query("ROLLBACK"); await c.end(); return r.rows[0];
  })();
  check("M6. Con su propia sesión de base de datos no lee entradas del calendario (borradores) ni los turnos publicados de una compañera", staffDb.e === 0 && staffDb.others === 0, staffDb);

  check("K0. Ningún error 5xx", errors500.length === 0, errors500);
  server.close(); await pool.end(); await db.end();
  await srv.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await srv.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
