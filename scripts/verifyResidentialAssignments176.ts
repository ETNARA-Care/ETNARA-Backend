/**
 * 176 · Hogares F3: asignación de residentes por turno y sustitución administrativa (D7).
 * Datos FICTICIOS, base PROPIA desechable, aplicación real por HTTP como app_runtime. Ningún correo real, ninguna
 * salida de red. Cubre los criterios del plan (§11 F3, §12): cero residentes sin asignación y exactamente los asignados
 * (API y RLS); el acceso cambia en la siguiente consulta al redistribuir, cancelar, trasladar o sustituir, sin dos
 * accesos a la vez; transferencias total y selectiva; sin cobertura con confirmación, motivo y alerta; eventos de cuidado
 * y mensajes solo con residentes asignados; bloqueos de la sustitución que no se pueden anular (elegibilidad y
 * credenciales, puesto, autorización en el establecimiento, solape real con sustituciones parciales); disponibilidad
 * como advertencia; motivo sin datos de salud; atomicidad con fallo inyectado; ponches conservados y horas sin
 * duplicar; interruptores (403 con cualquiera apagado); aislamiento entre organizaciones y establecimientos.
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
const SECRET = randomBytes(32).toString("hex");
process.env.ATTENDANCE_CODE_SECRET = SECRET;
process.env.ATTENDANCE_CODE_KEY_ID = "k1";
process.env.ATTENDANCE_JOB = "off";

// Centro ficticio de la geocerca y puntos de prueba (no corresponden a ningún hogar real).
const CENTER = { lat: 18.401234, lng: -66.051234 };
const INSIDE = { latitude: 18.401534, longitude: -66.051234, accuracy: 15 };     // ≈ 33 m
const OUTSIDE = { latitude: 18.409876, longitude: -66.051234, accuracy: 12 };    // ≈ 960 m
const FUZZY = { latitude: 18.401300, longitude: -66.051200, accuracy: 450 };     // precisión baja

async function main() {
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  const dbName = `etnara_f3_${randomBytes(4).toString("hex")}`;
  await srv.query(`CREATE DATABASE ${dbName}`);
  const su = new URL(serverUrl!); su.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: su.toString() }); await db.connect();
  { const log = console.log; console.log = () => undefined; try { await applyPendingMigrations(db, join(process.cwd(), "migrations")); } finally { console.log = log; } }
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const rt = new URL(su.toString()); rt.username = "app_runtime"; rt.password = runtimePassword;
  process.env.DATABASE_URL = rt.toString();
  const rtClient = new pg.Client({ connectionString: rt.toString() }); await rtClient.connect();

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const { runAttendanceJob } = await import("../src/modules/residential/attendance.worker.js");
  const { resetFeatureWriteLimitForTests } = await import("../src/middleware/featureWriteLimit.js").catch(() => ({ resetFeatureWriteLimitForTests: () => undefined }));
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const errors500: string[] = [];
  const bodies: string[] = [];
  const headers: Record<string, string>[] = [];
  const call = async (method: string, path: string, token: string, body?: Json) => {
    (resetFeatureWriteLimitForTests as () => void)();
    const res = await realFetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); bodies.push(text); headers.push(Object.fromEntries(res.headers.entries()));
    let json: Json = {}; try { json = JSON.parse(text); } catch { /* vacío */ }
    if (res.status >= 500 && json.error !== "ATTENDANCE_UNAVAILABLE") errors500.push(`${method} ${path} ${res.status} ${json.error ?? ""}`);
    return { status: res.status, body: json, cache: res.headers.get("cache-control") ?? "" };
  };
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toLowerCase();
  const org = async (n: string, t: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2,'active') RETURNING id`, [n, t])).rows[0].id;
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types ORDER BY code LIMIT 1`)).rows[0].id;
  type P = { userId: string; token: string; owm?: string };
  const person = async (orgId: string, key: string, roles: string[], worker = false, opts: { role?: string; eligible?: boolean } = {}): Promise<P> => {
    const email = `f3-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let owm: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Ficticia ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active',$3) RETURNING id`, [workerId, orgId, opts.role ?? 'caregiver'])).rows[0].id;
      if (opts.eligible !== false) await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
    }
    const t = (await call("POST", "/auth/login", "", { email, password })).body.token as string;
    await call("POST", "/me/active-organization", t, { organizationId: orgId });
    return { userId, token: t, owm };
  };


  const H = await org(`Hogar Asignaciones ${tag}`, "RESIDENTIAL_CARE_HOME"), H2 = await org(`Hogar Dos ${tag}`, "RESIDENTIAL_CARE_HOME");
  const H3 = await org(`Hogar Sin Calendario ${tag}`, "RESIDENTIAL_CARE_HOME"), H4 = await org(`Hogar Sin Asignaciones ${tag}`, "RESIDENTIAL_CARE_HOME");
  const A = await org(`Agencia Ficticia ${tag}`, "HOME_CARE_AGENCY");
  for (const o of [H, H2, H3, H4, A]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'Ficticia') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
    await q(`INSERT INTO organization_care_event_types (organization_id,care_event_type_id,is_enabled) SELECT $1,id,true FROM care_event_types WHERE code='MOOD' ON CONFLICT DO NOTHING`, [o]);
  }
  const feature = async (o: string, f: string) => q(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,$2,true)`, [o, f]);
  for (const f of ["HOGAR_CALENDARIO", "HOGAR_ASIGNACIONES", "HOGAR_PONCHES"]) await feature(H, f);
  for (const f of ["HOGAR_CALENDARIO", "HOGAR_ASIGNACIONES"]) await feature(H2, f);
  await feature(H3, "HOGAR_ASIGNACIONES"); await feature(H4, "HOGAR_CALENDARIO");
  const loc = async (o: string, n: string) => (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,$2) RETURNING id`, [o, n])).rows[0].id;
  const L = await loc(H, "Casa Asignaciones"), L2 = await loc(H, "Casa Asignaciones B"), LH2 = await loc(H2, "Casa Dos"), LH3 = await loc(H3, "Casa Tres"), LH4 = await loc(H4, "Casa Cuatro");
  const tech = async (l: string) => (await q<{ room_id: string; unit_id: string }>(`SELECT room_id, unit_id FROM establishment_technical_rooms WHERE location_id=$1`, [l])).rows[0];
  const resident = async (o: string, l: string, n: string) => (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,location_id,first_name,last_name,status) VALUES ($1,$2,$3,'Ficticio','active') RETURNING id`, [o, l, n])).rows[0].id;
  const [R1, R2, R3, R4, R5] = [await resident(H, L, "Rosa"), await resident(H, L, "Ramón"), await resident(H, L, "Rita"), await resident(H, L, "Raúl"), await resident(H, L, "Reina")];
  const R6 = await resident(H, L2, "Rocío"), R7 = await resident(H2, LH2, "Rufino");
  const adminH = await person(H, "admin-h", ["ORGANIZATION_ADMIN"]);
  const w = {} as Record<string, P>;
  for (const k of ["w1", "w2", "w3", "w4", "w7", "w8", "w9", "w10"]) w[k] = await person(H, k, ["WORKER"], true);
  w.w5 = await person(H, "w5", ["WORKER"], true, { eligible: false });
  w.w6 = await person(H, "w6", ["WORKER"], true, { role: "nurse" });
  const adminH2 = await person(H2, "admin-h2", ["ORGANIZATION_ADMIN"]), wH2 = await person(H2, "wh2", ["WORKER"], true);
  const adminH3 = await person(H3, "admin-h3", ["ORGANIZATION_ADMIN"]), adminH4 = await person(H4, "admin-h4", ["ORGANIZATION_ADMIN"]);
  const adminA = await person(A, "admin-a", ["ORGANIZATION_ADMIN"]), wA = await person(A, "wa", ["WORKER"], true);
  // Autorización en el establecimiento: todos menos w4 (L) y w9/w10 también en L2.
  for (const k of ["w1", "w2", "w3", "w5", "w6", "w7", "w8", "w9"]) await q(`INSERT INTO establishment_worker_assignments (organization_id,location_id,organization_worker_membership_id) VALUES ($1,$2,$3)`, [H, L, w[k].owm]);
  for (const k of ["w9", "w10", "w7"]) await q(`INSERT INTO establishment_worker_assignments (organization_id,location_id,organization_worker_membership_id) VALUES ($1,$2,$3)`, [H, L2, w[k].owm]);
  await q(`INSERT INTO worker_unavailability_periods (organization_id, organization_worker_membership_id, starts_at, ends_at, reason) VALUES ($1,$2, now() + interval '1 hour', now() + interval '3 hours', NULL)`, [H, w.w8.owm]);
  const shift = async (o: string, l: string, startMin: number, endMin: number, people: P[]) => {
    const s = (await q<{ id: string }>(`INSERT INTO shifts (organization_id, room_id, scheduled_start, scheduled_end, required_role)
      VALUES ($1,$2, date_trunc('minute', now()) + make_interval(mins => $3), date_trunc('minute', now()) + make_interval(mins => $4), 'Cuidador/a') RETURNING id`, [o, (await tech(l)).room_id, startMin, endMin])).rows[0].id;
    for (const p of people) await q(`INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, response_status, responded_at) VALUES ($1,$2,$3,'accepted',now())`, [o, s, p.owm]);
    return s;
  };
  const S1 = await shift(H, L, -30, 450, [w.w1, w.w2]);
  const S0 = await shift(H, L, 600, 1080, [w.w3]);                 // futuro: sustitución completa
  const SOTHER = await shift(H, L2, -60, 300, [w.w7]);              // solapa con S1
  const SPART = await shift(H, L2, -60, 120, [w.w9]);               // solapa con S1 hasta que w9 sea sustituida
  const SCANCEL = await shift(H, L, -10, 400, [w.w10]);
  await q(`INSERT INTO establishment_worker_assignments (organization_id,location_id,organization_worker_membership_id) VALUES ($1,$2,$3)`, [H, L, w.w10.owm]);
  const SH2 = await shift(H2, LH2, -30, 450, [wH2]);
  await shift(H3, LH3, -30, 450, []); await shift(H4, LH4, -30, 450, []);
  // Semana publicada del calendario (F2) que contiene S1, para comprobar la versión tras la sustitución.
  const s1row = (await q<{ week: string; starts: Date; ends: Date }>(`SELECT to_char(date_trunc('week', scheduled_start AT TIME ZONE 'America/Puerto_Rico'), 'YYYY-MM-DD') AS week, scheduled_start AS starts, scheduled_end AS ends FROM shifts WHERE id=$1`, [S1])).rows[0];
  const weekId = (await q<{ id: string }>(`INSERT INTO schedule_weeks (organization_id, location_id, week_start, status, version, published_at) VALUES ($1,$2,$3,'published',1,now()) RETURNING id`, [H, L, s1row.week])).rows[0].id;
  await q(`INSERT INTO schedule_week_shifts (week_id, organization_id, starts_at, ends_at, organization_worker_membership_id, shift_id) VALUES ($1,$2,$3,$4,$5,$6)`, [weekId, H, s1row.starts, s1row.ends, w.w1.owm, S1]);
  await q(`INSERT INTO schedule_week_publications (week_id, organization_id, version, shift_count) VALUES ($1,$2,1,1)`, [weekId, H]);
  // Agencia (regresión de la 030): turno con persona atendida y cuidadora aceptada.
  const RA = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Cliente','Agencia','active') RETURNING id`, [A])).rows[0].id;
  const SA = (await q<{ id: string }>(`INSERT INTO shifts (organization_id, care_recipient_id, scheduled_start, scheduled_end, required_role) VALUES ($1,$2, now() - interval '10 minutes', now() + interval '3 hours', 'caregiver') RETURNING id`, [A, RA])).rows[0].id;
  await q(`INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, care_recipient_id, response_status, responded_at) VALUES ($1,$2,$3,$4,'accepted',now())`, [A, SA, wA.owm, RA]);

  const AS = (o: string) => `/organizations/${o}/residential/assignments`, SU = (o: string) => `/organizations/${o}/residential/substitutions`;
  const sees = async (p: P, orgId = H): Promise<string[]> => {
    const r = await call("GET", `/organizations/${orgId}/care-recipients`, p.token);
    if (r.status !== 200) throw new Error(`care-recipients ${r.status} ${JSON.stringify(r.body)}`);
    return (r.body.recipients as Json[]).map((x) => x.id as string).filter((id) => [R1, R2, R3, R4, R5, R6, R7, RA].includes(id)).sort();
  };
  const rlsCount = async (p: P, orgId = H) => {
    await rtClient.query("BEGIN");
    await rtClient.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [p.userId, orgId]);
    const n = (await rtClient.query(`SELECT count(*)::int n FROM care_recipients`)).rows[0].n; await rtClient.query("ROLLBACK"); return n;
  };
  const canMsg = async (p: P, r: string) => (await q<{ ok: boolean }>(`SELECT app_user_can_message_recipient($1,$2,$3) ok`, [p.userId, H, r])).rows[0].ok;
  const sorted = (...x: string[]) => [...x].sort();

  // ---- Interruptores, modalidades y roles --------------------------------------------------------------------------
  const off = await call("GET", `${AS(H4)}/establishments`, adminH4.token);
  const subOffA = await call("POST", `${SU(H3)}/shifts/${S1}/preview`, adminH3.token, { originalMembershipId: w.w1.owm, substituteMembershipId: w.w3.owm });
  const subOffB = await call("POST", `${SU(H4)}/shifts/${S1}/preview`, adminH4.token, { originalMembershipId: w.w1.owm, substituteMembershipId: w.w3.owm });
  const agency = await call("GET", `${AS(A)}/establishments`, adminA.token), agencySub = await call("POST", `${SU(A)}/shifts/${SA}`, adminA.token, {});
  const workerAdmin = await call("GET", `${AS(H)}/shifts/${S1}`, w.w1.token);
  check("F1. Sin HOGAR_ASIGNACIONES la asignación no existe (404); la sustitución responde 403 si falta cualquiera de los dos interruptores; agencias 403; el personal no administra (403)",
    off.status === 404 && off.body.error === "FEATURE_NOT_ENABLED" && subOffA.status === 403 && subOffA.body.error === "RESIDENTIAL_SUBSTITUTION_NOT_AVAILABLE"
    && subOffB.status === 403 && agency.status === 403 && agency.body.error === "MODALITY_NOT_AVAILABLE" && agencySub.status === 403 && workerAdmin.status === 403,
    [off, subOffA, subOffB, agency.status, agencySub.status, workerAdmin.status]);

  // ---- Acceso: cero sin asignación; exactamente los asignados (API y RLS) ------------------------------------------------
  const zero = await sees(w.w1), zeroRls = await rlsCount(w.w1);
  const asg = await call("POST", `${AS(H)}/shifts/${S1}/residents`, adminH.token, { membershipId: w.w1.owm, careRecipientIds: [R1, R2, R3, R4] });
  const four = await sees(w.w1), fourRls = await rlsCount(w.w1), mine = await call("GET", `${AS(H)}/me`, w.w1.token), w2zero = await sees(w.w2);
  check("A1. Un cuidador sin asignaciones ve cero residentes; con 4, ve esos 4 (API y RLS) y nadie más los ve",
    zero.length === 0 && zeroRls === 0 && asg.status === 201 && JSON.stringify(four) === JSON.stringify(sorted(R1, R2, R3, R4)) && fourRls === 4
    && mine.body.residents?.length === 4 && w2zero.length === 0, { zero, zeroRls, asg: asg.body, four, fourRls, w2zero });
  await call("POST", `${AS(H)}/shifts/${S1}/residents`, adminH.token, { membershipId: w.w2.owm, careRecipientIds: [R4] });
  const board1 = await call("GET", `${AS(H)}/shifts/${S1}`, adminH.token);
  check("A2. Compartidas, totales y cobertura en el tablero (R4 compartida; R5 sin cobertura)",
    board1.body.board?.totals.shared === 1 && board1.body.board.totals.uncovered === 1 && board1.body.board.residents.find((r: Json) => r.id === R5).uncovered
    && board1.body.board.staff.find((s: Json) => s.membershipId === w.w1.owm).residentCount === 4, board1.body.board?.totals);
  const otherEst = await call("POST", `${AS(H)}/shifts/${S1}/residents`, adminH.token, { membershipId: w.w1.owm, careRecipientIds: [R6] });
  const notOnShift = await call("POST", `${AS(H)}/shifts/${S1}/residents`, adminH.token, { membershipId: w.w3.owm, careRecipientIds: [R5] });
  const dup = await call("POST", `${AS(H)}/shifts/${S1}/residents`, adminH.token, { membershipId: w.w1.owm, careRecipientIds: [R1] });
  const back = await call("POST", `${AS(H)}/shifts/${S1}/residents`, adminH.token, { membershipId: w.w1.owm, careRecipientIds: [R5], effectiveAt: new Date(Date.now() - 3_600_000).toISOString() });
  const err = async (s: string, p: unknown[], who: P, orgId = H) => {
    await rtClient.query("BEGIN");
    await rtClient.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [who.userId, orgId]);
    try { await rtClient.query(s, p); return "OK"; } catch (e) { return (e as Error).message; } finally { await rtClient.query("ROLLBACK"); }
  };
  const selfAssign = await err(`INSERT INTO shift_resident_assignments (organization_id, location_id, shift_id, organization_worker_membership_id, care_recipient_id, effective_from, created_by_user_id) VALUES ($1,$2,$3,$4,$5,now(),$6)`, [H, L, S1, w.w1.owm, R5, w.w1.userId], w.w1);
  const sraId = (await q<{ id: string }>(`SELECT id FROM shift_resident_assignments WHERE care_recipient_id=$1 AND organization_worker_membership_id=$2`, [R1, w.w1.owm])).rows[0].id;
  const del = await err(`DELETE FROM shift_resident_assignments WHERE id=$1`, [sraId], adminH);
  const extend = await err(`UPDATE shift_resident_assignments SET effective_from = effective_from - interval '1 hour' WHERE id=$1`, [sraId], adminH);
  check("A3. Guardas: residente de otro establecimiento, persona sin asignación en el turno, duplicado, fechas hacia atrás; el personal no se asigna residentes; no se borra ni se reescribe",
    otherEst.body.error === "RESIDENTIAL_ASSIGNMENT_RESIDENT_NOT_HERE" && notOnShift.body.error === "RESIDENTIAL_ASSIGNMENT_STAFF_NOT_ASSIGNED"
    && dup.body.error === "RESIDENTIAL_ASSIGNMENT_DUPLICATE" && back.body.error === "RESIDENTIAL_ASSIGNMENT_RETROACTIVE"
    && /row-level security|permission denied/.test(selfAssign) && /RESIDENTIAL_ASSIGNMENT_IMMUTABLE|permission denied/.test(del) && extend.includes("RESIDENTIAL_ASSIGNMENT_IMMUTABLE"),
    { otherEst: otherEst.body, notOnShift: notOnShift.body, dup: dup.body, back: back.body, selfAssign, del, extend });

  // ---- Redistribución: cierre y apertura a la misma hora; sin cobertura con motivo y alerta --------------------------------
  const red = await call("POST", `${AS(H)}/shifts/${S1}/redistribute`, adminH.token, { moves: [{ careRecipientId: R1, fromMembershipId: w.w1.owm, toMembershipId: w.w2.owm }] });
  const after1 = await sees(w.w1), after2 = await sees(w.w2);
  const pair = (await q<{ until: Date; from: Date }>(`SELECT a.effective_until AS until, b.effective_from AS from FROM shift_resident_assignments a, shift_resident_assignments b
    WHERE a.care_recipient_id=$1 AND a.organization_worker_membership_id=$2 AND b.care_recipient_id=$1 AND b.organization_worker_membership_id=$3`, [R1, w.w1.owm, w.w2.owm])).rows[0];
  check("A4. Redistribuir: el acceso cambia en la siguiente consulta y la hora de cierre es exactamente la de apertura (nunca dos accesos a la vez)",
    red.status === 200 && !after1.includes(R1) && after2.includes(R1) && pair && pair.until.getTime() === pair.from.getTime(), { red: red.body, after1, after2, pair });
  const noConfirm = await call("POST", `${AS(H)}/shifts/${S1}/redistribute`, adminH.token, { moves: [{ careRecipientId: R2, fromMembershipId: w.w1.owm, toMembershipId: null }] });
  const confirmed = await call("POST", `${AS(H)}/shifts/${S1}/redistribute`, adminH.token, { moves: [{ careRecipientId: R2, fromMembershipId: w.w1.owm, toMembershipId: null }], confirmUncovered: true, uncoveredReason: "Visita familiar autorizada" });
  const alertsList = await call("GET", `${AS(H)}/coverage-alerts`, adminH.token);
  check("A5. Dejar a un residente sin cobertura exige confirmación y motivo, y crea una alerta pendiente",
    noConfirm.status === 409 && noConfirm.body.error === "RESIDENTIAL_UNCOVERED_CONFIRMATION_REQUIRED" && noConfirm.body.details?.uncovered?.[0] === R2
    && confirmed.status === 200 && alertsList.body.alerts?.some((a: Json) => a.reason === "Visita familiar autorizada") && !(await sees(w.w1)).includes(R2),
    [noConfirm.body, confirmed.body, alertsList.body.alerts?.length]);

  // ---- Eventos de cuidado y mensajes: solo residentes asignados -----------------------------------------------------------
  const evOk = await call("POST", `/organizations/${H}/shifts/${S1}/care-events`, w.w1.token, { typeCode: "MOOD", careRecipientId: R3, payload: { mood: "Tranquilo" } });
  const evNo = await call("POST", `/organizations/${H}/shifts/${S1}/care-events`, w.w1.token, { typeCode: "MOOD", careRecipientId: R1, payload: { mood: "Tranquilo" } });
  const evOther = await call("POST", `/organizations/${H}/shifts/${S1}/care-events`, w.w1.token, { typeCode: "MOOD", careRecipientId: R5, payload: { mood: "Tranquilo" } });
  const m3 = await canMsg(w.w1, R3), m1 = await canMsg(w.w1, R1), m1b = await canMsg(w.w2, R1);
  check("A6. Eventos de cuidado: aceptan solo a los residentes asignados AHORA (sin verificación de visita en hogares); mensajes: solo durante la asignación (sin las 24 h de gracia)",
    evOk.status === 201 && evNo.status >= 400 && evNo.status < 500 && evOther.status >= 400 && evOther.status < 500 && m3 && !m1 && m1b,
    { evOk: evOk.status, evNo: [evNo.status, evNo.body.error], evOther: evOther.status, m3, m1, m1b });

  // ---- Traslado del residente y cancelación del turno ---------------------------------------------------------------------
  const move = await call("PUT", `/organizations/${H}/residential/residents/${R3}/placement`, adminH.token, { roomId: null, establishmentId: L2, reason: "Traslado a la casa B" });
  const closedByTransfer = (await q<{ close_reason: string }>(`SELECT close_reason FROM shift_resident_assignments WHERE care_recipient_id=$1 AND organization_worker_membership_id=$2`, [R3, w.w1.owm])).rows[0];
  await call("POST", `${AS(H)}/shifts/${SCANCEL}/residents`, adminH.token, { membershipId: w.w10.owm, careRecipientIds: [R5] });
  const beforeCancel = await sees(w.w10);
  // La API mantiene su regla (solo se cancela un turno que no ha empezado); cualquier vía que lo cancele deja sin acceso.
  const cancel = await call("POST", `/organizations/${H}/shifts/${SCANCEL}/cancel`, adminH.token, {});
  await q(`UPDATE shifts SET status='cancelled' WHERE id=$1`, [SCANCEL]);
  const afterCancel = await sees(w.w10);
  const keptRows = (await q(`SELECT 1 FROM shift_resident_assignments WHERE shift_id=$1`, [SCANCEL])).rows.length;
  check("A7. Traslado: sus asignaciones se cierran en la misma transacción; un turno empezado no se cancela por la API (regla existente) y, cancelado por cualquier vía, el acceso cae por la RLS y el historial se conserva",
    move.status === 200 && closedByTransfer?.close_reason === "transfer" && !(await sees(w.w1)).includes(R3)
    && beforeCancel.includes(R5) && cancel.status === 409 && cancel.body.error === "SHIFT_CANNOT_BE_CANCELLED" && !afterCancel.includes(R5) && keptRows === 1, { move: move.status, closedByTransfer, beforeCancel, cancel: [cancel.status, cancel.body], afterCancel });

  // ---- Sustitución: bloqueos que no se pueden anular ----------------------------------------------------------------------
  const tryPreview = async (sub: P, extra: Json = {}) => (await call("POST", `${SU(H)}/shifts/${S1}/preview`, adminH.token, { originalMembershipId: w.w1.owm, substituteMembershipId: sub.owm, ...extra })).body.preview;
  const bAuth = await tryPreview(w.w4), bElig = await tryPreview(w.w5), bRole = await tryPreview(w.w6), bOver = await tryPreview(w.w7), bDup = await tryPreview(w.w2);
  const forced = await call("POST", `${SU(H)}/shifts/${S1}`, adminH.token, { originalMembershipId: w.w1.owm, substituteMembershipId: w.w7.owm, reasonCode: "operational", override: true });
  const blocked = await call("POST", `${SU(H)}/shifts/${S1}`, adminH.token, { originalMembershipId: w.w1.owm, substituteMembershipId: w.w7.owm, reasonCode: "operational" });
  check("B1. Bloqueos: sin autorización en el establecimiento, no elegible (credenciales), otro puesto, solape real y ya asignada; no existe forma de anularlos",
    bAuth?.blocks.includes("not_authorized_in_establishment") && bElig?.blocks.includes("not_eligible") && bRole?.blocks.includes("role_mismatch")
    && bOver?.blocks.includes("schedule_overlap") && bDup?.blocks.includes("already_assigned") && forced.status === 400
    && blocked.status === 409 && blocked.body.error === "RESIDENTIAL_SUBSTITUTION_BLOCKED" && blocked.body.details.blocks.includes("schedule_overlap"),
    { bAuth, bElig, bRole, bOver, bDup, forced: forced.status, blocked: blocked.body });
  const bAvail = await tryPreview(w.w8);
  const avail = await call("POST", `${SU(H)}/shifts/${S1}`, adminH.token, { originalMembershipId: w.w1.owm, substituteMembershipId: w.w8.owm, reasonCode: "operational" });
  const noReason = await call("POST", `${SU(H)}/shifts/${S1}`, adminH.token, { originalMembershipId: w.w1.owm, substituteMembershipId: w.w3.owm });
  const longNote = await call("POST", `${SU(H)}/shifts/${S1}`, adminH.token, { originalMembershipId: w.w1.owm, substituteMembershipId: w.w3.owm, reasonCode: "other", reasonNote: "x".repeat(301) });
  check("B2. La disponibilidad declarada es una advertencia que se confirma; el motivo es obligatorio (categoría, sin datos de salud) y la nota está limitada",
    bAvail?.availabilityWarning === true && bAvail.blocks.length === 0 && avail.status === 409 && avail.body.error === "RESIDENTIAL_SUBSTITUTION_AVAILABILITY_CONFIRMATION_REQUIRED"
    && noReason.status === 400 && longNote.status === 400, { bAvail, avail: avail.body, noReason: noReason.status, longNote: longNote.status });

  // ---- Atomicidad: fallo inyectado al final de la operación ------------------------------------------------------------------
  const snapshot = async () => JSON.stringify((await q(`SELECT (SELECT count(*) FROM shift_substitutions) s, (SELECT count(*) FROM assignments WHERE shift_id=$1) a,
    (SELECT count(*) FROM shift_resident_assignments) r, (SELECT count(*) FROM shift_resident_assignments WHERE effective_until IS NULL) ro,
    (SELECT count(*) FROM schedule_week_publications) p, (SELECT version FROM schedule_weeks WHERE id=$2) v, (SELECT count(*) FROM shift_coverage_alerts) c`, [S1, weekId])).rows[0]);
  await call("POST", `${AS(H)}/shifts/${S1}/residents`, adminH.token, { membershipId: w.w1.owm, careRecipientIds: [R5] });
  const before = await snapshot();
  await q(`CREATE FUNCTION pg_temp_fail() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.notification_type = 'SHIFT_SUBSTITUTION_RELEASED' THEN RAISE EXCEPTION 'fallo inyectado'; END IF; RETURN NEW; END $f$`);
  await q(`CREATE TRIGGER zz_fail_injection BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION pg_temp_fail()`);
  const failed = await call("POST", `${SU(H)}/shifts/${S1}`, adminH.token, { originalMembershipId: w.w1.owm, substituteMembershipId: w.w3.owm, reasonCode: "unplanned_absence",
    transfers: [{ careRecipientId: R5, toMembershipId: w.w3.owm }, { careRecipientId: R4, toMembershipId: w.w3.owm }] });
  await q(`DROP TRIGGER zz_fail_injection ON notifications`); await q(`DROP FUNCTION pg_temp_fail()`);
  const afterFail = await snapshot();
  errors500.splice(errors500.findIndex((e) => e.includes("/substitutions/")), errors500.some((e) => e.includes("/substitutions/")) ? 1 : 0);
  check("B3. Atomicidad: con un fallo inyectado en el último paso no queda nada a medias (sustitución, asignaciones, periodos, versión del calendario y alertas idénticos)",
    failed.status === 500 && before === afterFail, { failed: failed.status, before, afterFail });

  // ---- Sustitución parcial: transferencia selectiva a varias personas; ponches y horas -----------------------------------------
  const p1 = await call("POST", `/organizations/${H}/residential/attendance/punches/manual`, adminH.token, { shiftId: S1, membershipId: w.w1.owm, type: "in", at: new Date(Date.now() - 20 * 60_000).toISOString(), reason: "Entrada registrada en la hoja" });
  const subP = await call("POST", `${SU(H)}/shifts/${S1}`, adminH.token, { originalMembershipId: w.w1.owm, substituteMembershipId: w.w3.owm, reasonCode: "unplanned_absence",
    reasonNote: "Ausencia imprevista", transfers: [{ careRecipientId: R5, toMembershipId: w.w3.owm }, { careRecipientId: R4, toMembershipId: w.w2.owm }] });
  const T = new Date(subP.body.substitution?.effectiveAt);
  const w1now = await sees(w.w1), w3now = await sees(w.w3), w2now = await sees(w.w2);
  const w1asg = (await q(`SELECT 1 FROM assignments WHERE shift_id=$1 AND organization_worker_membership_id=$2`, [S1, w.w1.owm])).rows.length;
  const w3asg = (await q<{ response_status: string }>(`SELECT response_status FROM assignments WHERE shift_id=$1 AND organization_worker_membership_id=$2`, [S1, w.w3.owm])).rows[0];
  const punchKept = (await q(`SELECT 1 FROM attendance_punches WHERE id=$1`, [p1.body.punch?.id])).rows.length;
  const notes = (await q<{ t: string; u: string }>(`SELECT notification_type t, user_id u FROM notifications WHERE related_entity_type='shift_substitution'`)).rows;
  const wk = await q<{ version: number }>(`SELECT version FROM schedule_weeks WHERE id=$1`, [weekId]);
  const cal = await call("GET", `/organizations/${H}/residential/schedule/establishments/${L}/weeks/${s1row.week}`, adminH.token);
  const entry = cal.body.schedule?.entries.find((e: Json) => e.membershipId === w.w1.owm);
  check("B4. Sustitución parcial: la sustituta queda asignada; la original conserva su asignación y su ponche; transferencia selectiva a dos personas a la misma hora; el acceso cambia sin simultaneidad",
    subP.status === 201 && subP.body.substitution.fullReplacement === false && w3asg?.response_status === "accepted" && w1asg === 1 && punchKept === 1
    && !w1now.includes(R5) && !w1now.includes(R4) && w3now.includes(R5) && w2now.includes(R4) && w1now.length === 0, { subP: subP.body, w1now, w3now, w2now, w1asg, punchKept });
  const w2R4 = (await q<{ n: number }>(`SELECT count(*)::int n FROM shift_resident_assignments WHERE shift_id=$1 AND organization_worker_membership_id=$2 AND care_recipient_id=$3 AND effective_until IS NULL`, [S1, w.w2.owm, R4])).rows[0].n;
  check("B4b. Transferir a quien ya atiende al residente (compartido) no duplica ni interrumpe su periodo", w2R4 === 1 && w2now.includes(R4), { w2R4 });
  check("B5. Aviso a ambos empleados, nueva versión del calendario y la semana muestra quién cubre y desde cuándo",
    notes.some((n) => n.t === "SHIFT_SUBSTITUTION_ASSIGNED" && n.u === w.w3.userId) && notes.some((n) => n.t === "SHIFT_SUBSTITUTION_RELEASED" && n.u === w.w1.userId)
    && wk.rows[0].version === 2 && entry?.substitution?.substituteName === "Ficticia w3", { notes, version: wk.rows[0].version, entry: entry?.substitution });
  await call("POST", `/organizations/${H}/residential/attendance/punches/manual`, adminH.token, { shiftId: S1, membershipId: w.w1.owm, type: "out", at: new Date(T.getTime() + 60 * 60_000).toISOString(), reason: "Salida tardía registrada" });
  await call("POST", `/organizations/${H}/residential/attendance/punches/manual`, adminH.token, { shiftId: S1, membershipId: w.w3.owm, type: "in", at: T.toISOString(), reason: "Entrada de la sustituta" });
  await call("POST", `/organizations/${H}/residential/attendance/punches/manual`, adminH.token, { shiftId: S1, membershipId: w.w3.owm, type: "out", at: new Date(T.getTime() + 60 * 60_000).toISOString(), reason: "Salida de la sustituta" });
  const wkAtt = await call("GET", `/organizations/${H}/residential/attendance/establishments/${L}/weeks/${s1row.week}`, adminH.token);
  const r1 = wkAtt.body.week?.rows.find((r: Json) => r.shiftId === S1 && r.membershipId === w.w1.owm);
  const r3 = wkAtt.body.week?.rows.find((r: Json) => r.shiftId === S1 && r.membershipId === w.w3.owm);
  const w1min = (r1?.validatedMinutes ?? 0) + (r1?.pendingMinutes ?? 0), w3min = (r3?.validatedMinutes ?? 0) + (r3?.pendingMinutes ?? 0);
  check("B6. Sin horas duplicadas: la original cuenta hasta la hora efectiva (aunque su salida sea posterior), la sustituta desde ella; los ponches originales no cambian",
    r1 && r3 && r1.substitutedPart && r3.substitutedPart && Math.abs(w1min - 20) <= 1 && Math.abs(w3min - 60) <= 1
    && (await q(`SELECT count(*)::int n FROM attendance_punches WHERE shift_id=$1`, [S1])).rows[0].n === 4, { r1, r3, w1min, w3min });

  // ---- Solape real con sustituciones parciales y sustitución completa ----------------------------------------------------------
  const overlapW9 = await tryPreview(w.w9);
  const outOfPart = await call("POST", `${SU(H)}/shifts/${SPART}`, adminH.token, { originalMembershipId: w.w9.owm, substituteMembershipId: w.w10.owm, reasonCode: "operational" });
  const freeW9 = (await call("POST", `${SU(H)}/shifts/${S1}/preview`, adminH.token, { originalMembershipId: w.w2.owm, substituteMembershipId: w.w9.owm })).body.preview;
  const full = await call("POST", `${SU(H)}/shifts/${S0}`, adminH.token, { originalMembershipId: w.w3.owm, substituteMembershipId: w.w9.owm, reasonCode: "schedule_change" });
  const w3gone = (await q(`SELECT 1 FROM assignments WHERE shift_id=$1 AND organization_worker_membership_id=$2`, [S0, w.w3.owm])).rows.length;
  check("B7. Solape real: w9 está ocupada en otro turno hasta que la sustituyen ahí (parcial) y entonces queda libre; sustitución completa antes del inicio: la original deja de estar asignada",
    overlapW9?.blocks.includes("schedule_overlap") && outOfPart.status === 201 && freeW9 && !freeW9.blocks.includes("schedule_overlap")
    && full.status === 201 && full.body.substitution.fullReplacement === true && w3gone === 0, { overlapW9, outOfPart: outOfPart.body, freeW9, full: full.body, w3gone });

  // ---- Aislamiento, base de datos e historial -------------------------------------------------------------------------------
  const crossBoard = await call("GET", `${AS(H2)}/shifts/${S1}`, adminH2.token), crossSub = await call("POST", `${SU(H2)}/shifts/${S1}/preview`, adminH2.token, { originalMembershipId: w.w2.owm, substituteMembershipId: wH2.owm });
  const crossRes = await call("POST", `${AS(H)}/shifts/${S1}/residents`, adminH.token, { membershipId: w.w2.owm, careRecipientIds: [R7] });
  const fakeSub = await err(`SELECT app_residential_substitute_shift($1,$2,$3,$4,now(),'other',NULL,false,false,'[]'::jsonb,'[]'::jsonb,false,NULL,'Cuidador/a')`, [S1, L, w.w2.owm, w.w8.owm], w.w2);
  const editSub = await err(`UPDATE shift_substitutions SET reason_code='other'`, [], adminH);
  const hist = await call("GET", `${AS(H)}/shifts/${S1}/history`, adminH.token);
  const histText = JSON.stringify(hist.body);
  check("C1. Aislamiento: otro hogar no ve ni sustituye (404) y no se asignan residentes de otro hogar; con app_runtime directo el personal no sustituye y nadie reescribe una sustitución",
    crossBoard.status === 404 && crossSub.status === 404 && crossRes.status === 409 && /RESIDENTIAL_MANAGER_REQUIRED|row-level security|permission denied/.test(fakeSub)
    && /permission denied|RESIDENTIAL_APPEND_ONLY|append/i.test(editSub), { crossBoard: crossBoard.status, crossSub: crossSub.status, crossRes: crossRes.body, fakeSub, editSub });
  check("C2. Historial completo: cada periodo (asignación, redistribución, sustitución, traslado) y cada sustitución con su motivo; sin datos de salud",
    hist.status === 200 && hist.body.history.periods.length >= 8 && hist.body.history.substitutions.length === 1
    && hist.body.history.substitutions[0].reasonCode === "unplanned_absence" && ["redistribution", "substitution", "ended", "transfer"].every((r) => histText.includes(r))
    && !/diagn|medic|salud/i.test(Object.keys(hist.body.history.substitutions[0]).join()), { n: hist.body.history?.periods.length, subs: hist.body.history?.substitutions });

  // ---- Agencias sin cambios y respuestas --------------------------------------------------------------------------------------
  const agencySees = await sees(wA, A), agencyRls = await rlsCount(wA, A);
  check("Z1. Agencia sin cambios (regresión de la 030): la cuidadora con asignación aceptada sigue viendo a su persona atendida",
    agencySees.includes(RA) && agencyRls >= 1, { agencySees, agencyRls });
  const techRoom = (await tech(L)).room_id;
  check("Z2. Ninguna respuesta contiene la habitación técnica", !bodies.some((b) => b.includes(techRoom)) && bodies.length > 40, bodies.length);
  check("Z3. Nunca un 500 en todo el recorrido (salvo el fallo inyectado a propósito)", errors500.length === 0, errors500);
  const { readFileSync } = await import("node:fs");
  let rb = "OK"; try { await db.query(readFileSync(join(process.cwd(), "ops", "176_residential_resident_assignments.rollback.sql"), "utf8")); } catch (e) { await db.query("ROLLBACK").catch(() => undefined); rb = (e as Error).message; }
  check("Z4. Con asignaciones y sustituciones registradas, la reversión de la 176 se niega", rb.includes("ROLLBACK_176_REFUSED"), rb);

  server.close(); await pool.end(); await rtClient.end(); await db.end();
  await srv.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await srv.end();
}

main().then(() => {
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 1500)}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 1500)}`}`); console.error(e); process.exit(1); });
