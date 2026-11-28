/**
 * 177 · Hogares F5: informes y portales (plan §4, §6 F5, §11 F5; D5, D8, D9 y D10).
 * Datos FICTICIOS, base PROPIA desechable, aplicación real por HTTP como app_runtime. Ningún correo real, ninguna
 * salida de red. Cubre: conversación familiar solo con la administración (decisión de Rafa del 26-nov) en API y RLS;
 * portal familiar según D5 (solo su familiar, hogar y habitación, actividades con autor, puesto, fecha y hora; nunca
 * turnos, horarios, ponches, asistencia, ubicación, credenciales ni otros residentes); actividades no clínicas del
 * cuidador solo para sus residentes asignados; informe de asistencia (cuadra con los ponches, validadas y pendientes por
 * separado, rango libre de 1 a 31 días); informe de asignaciones; panel completo por interruptor; centro operacional sin
 * turnos de la habitación técnica; Central con residentes activos únicos sin nombres, alerta al pasar de 10 sin
 * bloquear y Hogar Demo excluido; agencias sin cambios; nunca un 500.
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
  const dbName = `etnara_f5_${randomBytes(4).toString("hex")}`;
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
    const email = `f5-${key}-${tag}@example.invalid`;
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



  const H = await org(`Hogar Portales ${tag}`, "RESIDENTIAL_CARE_HOME"), H2 = await org(`Hogar Sin Ponches ${tag}`, "RESIDENTIAL_CARE_HOME");
  const HB = await org(`Hogar Grande ${tag}`, "RESIDENTIAL_CARE_HOME"), HD = await org(`Hogar Demo Ficticio ${tag}`, "RESIDENTIAL_CARE_HOME");
  const A = await org(`Agencia Ficticia ${tag}`, "HOME_CARE_AGENCY");
  for (const o of [H, H2, HB, HD, A]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'Ficticia') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
    await q(`INSERT INTO organization_care_event_types (organization_id,care_event_type_id,is_enabled) SELECT $1,id,true FROM care_event_types WHERE code IN ('MOOD','MEAL','NOTE') ON CONFLICT DO NOTHING`, [o]);
  }
  const feature = async (o: string, f: string) => q(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,$2,true)`, [o, f]);
  for (const f of ["HOGAR_CALENDARIO", "HOGAR_ASIGNACIONES", "HOGAR_PONCHES"]) await feature(H, f);
  await feature(H2, "HOGAR_ASIGNACIONES"); await feature(HD, "DEMO_ENVIRONMENT");
  const loc = async (o: string, n: string) => (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,$2) RETURNING id`, [o, n])).rows[0].id;
  const L = await loc(H, "Casa Portales"), L2 = await loc(H2, "Casa Dos"), LB = await loc(HB, "Casa Grande"), LD = await loc(HD, "Casa Demo Ficticia");
  const tech = async (l: string) => (await q<{ room_id: string }>(`SELECT room_id FROM establishment_technical_rooms WHERE location_id=$1`, [l])).rows[0].room_id;
  const resident = async (o: string, l: string, n: string, status = "active") => (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,location_id,first_name,last_name,status) VALUES ($1,$2,$3,'Ficticio',$4) RETURNING id`, [o, l, n, status])).rows[0].id;
  const [R1, R2, R3] = [await resident(H, L, "Rosa"), await resident(H, L, "Ramón"), await resident(H, L, "Rita")];
  const R4 = await resident(H2, L2, "Rufino");
  for (let i = 0; i < 11; i++) await resident(HB, LB, `Grande${i}`);
  await resident(HB, LB, "Inactiva", "archived");
  for (let i = 0; i < 12; i++) await resident(HD, LD, `Demo${i}`);
  const adminH = await person(H, "admin-h", ["ORGANIZATION_ADMIN"]), adminH2 = await person(H2, "admin-h2", ["ORGANIZATION_ADMIN"]);
  const w1 = await person(H, "w1", ["WORKER"], true), w2 = await person(H, "w2", ["WORKER"], true);
  const famR1 = await person(H, "fam-r1", ["FAMILY"]), famR4 = await person(H2, "fam-r4", ["FAMILY"]);
  for (const [f, o, r] of [[famR1, H, R1], [famR4, H2, R4]] as const)
    await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [f.userId, o, r]);
  const adminA = await person(A, "admin-a", ["ORGANIZATION_ADMIN"]), wA = await person(A, "wa", ["WORKER"], true), famA = await person(A, "fam-a", ["FAMILY"]);
  for (const k of [w1, w2]) await q(`INSERT INTO establishment_worker_assignments (organization_id,location_id,organization_worker_membership_id) VALUES ($1,$2,$3)`, [H, L, k.owm]);
  const central = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [`f5-central-${tag}@example.invalid`, hash])).rows[0].id;
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central]);
  const tC = (await call("POST", "/auth/login", "", { email: `f5-central-${tag}@example.invalid`, password })).body.token as string;

  // Habitación visible y ubicación de Rosa (F1).
  const room = await call("POST", `/organizations/${H}/residential/establishments/${L}/rooms`, adminH.token, { name: "Habitación 101", bedCapacity: 2 });
  await call("PUT", `/organizations/${H}/residential/residents/${R1}/placement`, adminH.token, { roomId: room.body.room?.id, reason: "Ingreso" });
  const shift = async (o: string, l: string, startMin: number, endMin: number, people: P[]) => {
    const s = (await q<{ id: string }>(`INSERT INTO shifts (organization_id, room_id, scheduled_start, scheduled_end, required_role)
      VALUES ($1,$2, date_trunc('minute', now()) + make_interval(mins => $3), date_trunc('minute', now()) + make_interval(mins => $4), 'Cuidador/a') RETURNING id`, [o, await tech(l), startMin, endMin])).rows[0].id;
    for (const p of people) await q(`INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, response_status, responded_at) VALUES ($1,$2,$3,'accepted',now())`, [o, s, p.owm]);
    return s;
  };
  const S1 = await shift(H, L, -60, 420, [w1, w2]);
  const SPAST = await shift(H, L, -26 * 60, -18 * 60, [w1]);
  await shift(H, L, 24 * 60, 32 * 60, []);  // futuro sin cubrir: nunca debe aparecer en el centro operacional del hogar
  await call("POST", `/organizations/${H}/residential/assignments/shifts/${S1}/residents`, adminH.token, { membershipId: w1.owm, careRecipientIds: [R1] });
  await call("POST", `/organizations/${H}/residential/assignments/shifts/${S1}/residents`, adminH.token, { membershipId: w2.owm, careRecipientIds: [R2] });
  // Agencia: turno con persona atendida y cuidadora aceptada (en curso).
  const RA = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Cliente','Agencia','active') RETURNING id`, [A])).rows[0].id;
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hijo','active')`, [famA.userId, A, RA]);
  const SA = (await q<{ id: string }>(`INSERT INTO shifts (organization_id, care_recipient_id, scheduled_start, scheduled_end, required_role, status) VALUES ($1,$2, now() - interval '10 minutes', now() + interval '3 hours', 'caregiver', 'confirmed') RETURNING id`, [A, RA])).rows[0].id;
  await q(`INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, care_recipient_id, response_status, responded_at) VALUES ($1,$2,$3,$4,'accepted',now())`, [A, SA, wA.owm, RA]);

  const canMsg = async (p: P, o: string, r: string) => (await q<{ ok: boolean }>(`SELECT app_user_can_message_recipient($1,$2,$3) ok`, [p.userId, o, r])).rows[0].ok;
  const asUser = async <T = Json>(p: P, o: string, s: string, args: unknown[] = []) => {
    await rtClient.query("BEGIN");
    await rtClient.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin','false',true)`, [p.userId, o]);
    try { return (await rtClient.query(s, args)).rows as T[]; } catch (e) { return [{ error: (e as Error).message }] as T[]; } finally { await rtClient.query("ROLLBACK"); }
  };

  // ---- M. Conversación familiar solo con la administración --------------------------------------------------------
  const conv = await call("POST", `/organizations/${H}/care-recipients/${R1}/conversation`, famR1.token, {});
  const tid = conv.body.conversation?.id;
  const parts = (await q<{ user_id: string }>(`SELECT user_id FROM message_thread_participants WHERE message_thread_id=$1`, [tid])).rows.map((r) => r.user_id);
  const famSend = await call("POST", `/organizations/${H}/conversations/${tid}/messages`, famR1.token, { body: "Hola, ¿cómo pasó la mañana?" });
  const adminRead = await call("GET", `/organizations/${H}/conversations/${tid}/messages`, adminH.token);
  const adminSend = await call("POST", `/organizations/${H}/conversations/${tid}/messages`, adminH.token, { body: "Muy bien, gracias." });
  const w1Open = await call("POST", `/organizations/${H}/care-recipients/${R1}/conversation`, w1.token, {});
  const w1Read = await call("GET", `/organizations/${H}/conversations/${tid}/messages`, w1.token);
  const w1Send = await call("POST", `/organizations/${H}/conversations/${tid}/messages`, w1.token, { body: "intento" });
  const w1List = await call("GET", `/organizations/${H}/conversations`, w1.token);
  const forged = await asUser(w1, H, `INSERT INTO message_thread_participants (organization_id,message_thread_id,user_id,can_write) VALUES ($1,$2,$3,true)`, [H, tid, w1.userId]);
  check("M1. Hogar: la conversación del residente es solo familia y administración; el cuidador asignado no entra, no lee, no escribe ni se añade por la base",
    conv.status === 200 && parts.includes(famR1.userId) && parts.includes(adminH.userId) && !parts.includes(w1.userId) && !parts.includes(w2.userId)
    && famSend.status === 201 && adminRead.status === 200 && adminSend.status === 201 && w1Open.status >= 400 && w1Read.status >= 400 && w1Send.status >= 400
    && !JSON.stringify(w1List.body).includes(tid ?? "x") && (await canMsg(w1, H, R1)) === false && /error/.test(JSON.stringify(forged)),
    { conv: conv.status, parts: parts.length, famSend: famSend.status, w1Open: w1Open.status, w1Read: w1Read.status, w1Send: w1Send.status, forged });
  const famOther = await call("POST", `/organizations/${H}/care-recipients/${R2}/conversation`, famR1.token, {});
  const famCross = await call("POST", `/organizations/${H2}/care-recipients/${R4}/conversation`, famR1.token, {});
  const agencyWindow = await canMsg(wA, A, RA);
  check("M2. La familia no abre la conversación de otro residente ni de otro hogar; en una agencia la cuidadora conserva su ventana (132 sin cambios)",
    famOther.status >= 400 && famOther.status < 500 && famCross.status >= 400 && famCross.status < 500 && agencyWindow === true, { famOther: famOther.status, famCross: famCross.status, agencyWindow });

  // ---- C. Actividades no clínicas del cuidador ------------------------------------------------------------------------
  const ev = await call("POST", `/organizations/${H}/shifts/${S1}/care-events`, w1.token, { typeCode: "MOOD", careRecipientId: R1, payload: { mood: "Tranquilo" } });
  const evMeal = await call("POST", `/organizations/${H}/shifts/${S1}/care-events`, w1.token, { typeCode: "MEAL", careRecipientId: R1, payload: { mealType: "Almuerzo", amountConsumed: "Todo" } });
  const evNo = await call("POST", `/organizations/${H}/shifts/${S1}/care-events`, w1.token, { typeCode: "MOOD", careRecipientId: R2, payload: { mood: "Tranquilo" } });
  const evOld = await call("POST", `/organizations/${H}/shifts/${SPAST}/care-events`, w1.token, { typeCode: "MOOD", careRecipientId: R1, payload: { mood: "Tranquilo" } });
  const evRow = (await q<{ created_by: string | null; occurred_at: Date }>(`SELECT organization_worker_membership_id AS created_by, occurred_at FROM care_events WHERE id=$1`, [ev.body.event?.id])).rows[0];
  check("C1. El cuidador registra actividades solo de sus residentes asignados ahora; queda con autor, fecha y hora; no en un turno pasado ni de un residente ajeno",
    ev.status === 201 && evMeal.status === 201 && evNo.status >= 400 && evNo.status < 500 && evOld.status >= 400 && evOld.status < 500 && evRow?.created_by === w1.owm && !!evRow.occurred_at,
    { ev: ev.status, evMeal: evMeal.status, evNo: [evNo.status, evNo.body.error], evOld: [evOld.status, evOld.body.error] });

  // ---- F. Portal familiar según D5 --------------------------------------------------------------------------------------
  const famBodies: string[] = [];
  const fcall = async (method: string, path: string, p: P, body?: Json) => { const r = await call(method, path, p.token, body); famBodies.push(JSON.stringify(r.body)); return r; };
  const mine = await fcall("GET", "/me/care-recipients", famR1);
  const one = await fcall("GET", `/me/care-recipients/${R1}`, famR1);
  const tl = await fcall("GET", `/organizations/${H}/care-recipients/${R1}/timeline`, famR1);
  const fshifts = await fcall("GET", `/organizations/${H}/care-recipients/${R1}/family-shifts`, famR1);
  const tlOther = await fcall("GET", `/organizations/${H}/care-recipients/${R2}/timeline`, famR1);
  const oneOther = await fcall("GET", `/me/care-recipients/${R2}`, famR1);
  const item = (tl.body.items as Json[] | undefined)?.find((i) => i.id === ev.body.event?.id);
  const meal = (tl.body.items as Json[] | undefined)?.find((i) => i.id === evMeal.body.event?.id);
  check("F1. La familia ve a su familiar con hogar y habitación (nunca la técnica) y sus actividades con autor, puesto, fecha, hora y campos traducibles",
    mine.status === 200 && mine.body.recipients?.length === 1 && one.status === 200 && one.body.recipient?.residence?.establishment === "Casa Portales"
    && one.body.recipient?.residence?.room === "Habitación 101" && tl.status === 200 && item?.caregiver?.displayName === "Ficticia w1" && item?.caregiver?.role === "caregiver"
    && !!item?.occurredAt && item?.fields?.mood === "Tranquilo" && meal?.fields?.mealType === "Almuerzo" && meal?.fields?.amountConsumed === "Todo",
    { mine: mine.body.recipients?.length, residence: one.body.recipient?.residence, item, meal: meal?.fields });
  check("F2. La familia no ve a otro residente (404) ni turnos del hogar (lista vacía, sin horarios ni credenciales del personal)",
    tlOther.status === 404 && oneOther.status === 404 && fshifts.status === 200 && Array.isArray(fshifts.body.shifts) && fshifts.body.shifts.length === 0,
    { tlOther: tlOther.status, oneOther: oneOther.status, fshifts: fshifts.body });
  // Un turno directo con el residente (si una vía lo crease) tampoco se muestra a la familia en un hogar.
  let direct = "creado";
  try { await q(`INSERT INTO shifts (organization_id, care_recipient_id, scheduled_start, scheduled_end, required_role) VALUES ($1,$2, now() + interval '2 days', now() + interval '2 days 8 hours', 'caregiver')`, [H, R1]); }
  catch (e) { direct = (e as Error).message.slice(0, 80); }
  const fshifts2 = await fcall("GET", `/organizations/${H}/care-recipients/${R1}/family-shifts`, famR1);
  check("F3. Aunque existiera un turno directo con su familiar, en un hogar la familia no ve turnos", fshifts2.body.shifts?.length === 0, { direct, n: fshifts2.body.shifts?.length });
  const rlsTables = ["attendance_punches", "attendance_alerts", "attendance_codes", "shift_resident_assignments", "shift_substitutions", "shift_coverage_alerts", "schedule_weeks", "schedule_week_shifts", "credentials", "assignments", "shifts", "workers", "organization_worker_memberships", "worker_unavailability_periods", "establishment_worker_assignments", "establishment_settings", "establishment_technical_rooms"];
  const leaks: string[] = [];
  for (const t of rlsTables) {
    const r = await asUser<{ n?: number; error?: string }>(famR1, H, `SELECT count(*)::int AS n FROM ${t}`);
    if (r[0]?.n && r[0].n > 0) leaks.push(`${t}=${r[0].n}`);
  }
  const crCount = (await asUser<{ n: number }>(famR1, H, `SELECT count(*)::int AS n FROM care_recipients`))[0]?.n;
  const famText = famBodies.join("\n");
  const forbidden = ["scheduled_start", "scheduledStart", "punch", "latitude", "longitude", "geofence", "credential", "membershipId", "effective_from", "assignment", "f5-w1-", w2.userId, R2, R3, "Ramón", "Rita"];
  const found = forbidden.filter((k) => famText.includes(k));
  check("F4. API y RLS: la familia no lee ponches, alertas, asignaciones, sustituciones, calendario, credenciales, disponibilidad ni geocerca; solo ve a su familiar; ninguna respuesta lleva esos datos",
    leaks.length === 0 && crCount === 1 && found.length === 0, { leaks, crCount, found });
  // Varios roles y membresías: familiar que además es cuidadora del mismo hogar conserva lo de cuidadora; familiar de un
  // hogar que es administradora de una agencia conserva todo en la agencia; la administración del hogar no pierde nada.
  const famWorker = await person(H, "fam-worker", ["FAMILY", "WORKER"], true);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'nieta','active')`, [famWorker.userId, H, R3]);
  const SFW = await shift(H, L, 3 * 24 * 60, 3 * 24 * 60 + 480, [famWorker]);
  const fwShifts = (await asUser<{ n: number }>(famWorker, H, `SELECT count(*)::int AS n FROM shifts`))[0]?.n ?? 0;
  const fwOwn = (await asUser<{ n: number }>(famWorker, H, `SELECT count(*)::int AS n FROM organization_worker_memberships WHERE id = $1`, [famWorker.owm]))[0]?.n ?? 0;
  const famAgencyAdmin = await person(H, "fam-agency-admin", ["FAMILY"]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hijo','active')`, [famAgencyAdmin.userId, H, R2]);
  const mAgency = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [famAgencyAdmin.userId, A])).rows[0].id;
  await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='ORGANIZATION_ADMIN'`, [mAgency, A]);
  const inHome = (await asUser<{ n: number }>(famAgencyAdmin, H, `SELECT count(*)::int AS n FROM credentials`))[0]?.n ?? -1;
  const inAgency = (await asUser<{ n: number }>(famAgencyAdmin, A, `SELECT count(*)::int AS n FROM assignments`))[0]?.n ?? -1;
  const usersSeen = (await asUser<{ n: number }>(famR1, H, `SELECT count(*)::int AS n FROM users`))[0]?.n ?? -1;
  const adminSees = await Promise.all(["credentials", "shifts", "assignments", "workers", "organization_worker_memberships", "establishment_settings", "users"]
    .map(async (t) => (await asUser<{ n: number }>(adminH, H, `SELECT count(*)::int AS n FROM ${t}`))[0]?.n ?? 0));
  const w1Sees = (await asUser<{ n: number }>(w1, H, `SELECT count(*)::int AS n FROM shifts`))[0]?.n ?? 0;
  const famRole = (await asUser<{ f: boolean }>(famR1, H, `SELECT app_residential_family_only() AS f`))[0]?.f;
  const famAgency = (await asUser<{ f: boolean }>(famA, A, `SELECT app_residential_family_only() AS f`))[0]?.f;
  check("F4b. Varios roles: familiar y cuidadora a la vez conserva sus turnos; familiar de hogar y administradora de agencia: cerrado en el hogar, intacto en la agencia; la familia solo ve su propio usuario; administración y cuidadores sin pérdida; en agencias la restricción no aplica",
    fwShifts > 0 && fwOwn === 1 && inHome === 0 && inAgency > 0 && usersSeen === 1 && adminSees.every((n) => n > 0) && w1Sees > 0 && famRole === true && famAgency === false,
    { fwShifts, fwOwn, inHome, inAgency, usersSeen, adminSees, w1Sees, famRole, famAgency });
  const aOne = await call("GET", `/me/care-recipients/${RA}`, famA.token);
  check("F5. Agencia sin cambios: su familia no recibe «residence» y sus turnos siguen visibles como antes",
    aOne.status === 200 && aOne.body.recipient && !("residence" in aOne.body.recipient)
    && (await call("GET", `/organizations/${A}/care-recipients/${RA}/family-shifts`, famA.token)).body.shifts?.length === 1, aOne.body);

  // F6 (auditoría GPT 28-nov): los campos estructurados y la función de autores son SOLO de hogares. En una agencia el
  // historial familiar queda exactamente como antes (sin «fields», que podrían llevar un número que el resumen omite) y
  // la función no devuelve nada aunque la llame una familia con relación activa.
  const evA = (await q<{ id: string }>(`INSERT INTO care_events (organization_id, shift_id, care_recipient_id, organization_worker_membership_id, care_event_type_id, occurred_at, structured_data)
    SELECT $1,$2,$3,$4,t.id,now() - interval '5 minutes','{"amount": 250}'::jsonb FROM care_event_types t WHERE t.code='HYDRATION' RETURNING id`, [A, SA, RA, wA.owm])).rows[0].id;
  const tlA = await call("GET", `/organizations/${A}/care-recipients/${RA}/timeline`, famA.token);
  const itA = (tlA.body.items as Json[] | undefined)?.find((i) => i.id === evA);
  const authorsA = await asUser<{ n: number }>(famA, A, `SELECT count(*)::int AS n FROM app_family_activity_authors($1)`, [RA]);
  const authorsH = await asUser<{ n: number }>(famR1, H, `SELECT count(*)::int AS n FROM app_family_activity_authors($1)`, [R1]);
  check("F6. Agencias e independientes sin novedades: el historial familiar de la agencia no lleva «fields» y conserva su autor por la vía anterior; app_family_activity_authors no devuelve nada fuera de un hogar y sigue funcionando en el hogar",
    tlA.status === 200 && !!itA && !("fields" in itA) && itA.summary === "Hidratación registrada" && itA.caregiver?.displayName === "Ficticia wa"
    && authorsA[0]?.n === 0 && (authorsH[0]?.n ?? 0) >= 1 && !!item?.fields,
    { tlA: tlA.status, itA, authorsA, authorsH });

  // ---- R. Informe de asistencia --------------------------------------------------------------------------------------------
  const PUN = `/organizations/${H}/residential/attendance`;
  const t0 = Date.now();
  const mp = (shiftId: string, p: P, type: string, minAgo: number) => call("POST", `${PUN}/punches/manual`, adminH.token, { shiftId, membershipId: p.owm, type, at: new Date(t0 - minAgo * 60_000).toISOString(), reason: "Registro de prueba ficticio" });
  await mp(SPAST, w1, "in", 26 * 60); await mp(SPAST, w1, "out", 18 * 60);
  await mp(S1, w1, "in", 55);
  // w2: ponches sin conexión (como los envía el teléfono): quedan pendientes de revisión, nunca validados solos.
  const offline = async (type: "in" | "out", minAgo: number, sessionIn: string | null = null, who: P = w2) => {
    await db.query("BEGIN");
    await db.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [who.userId, H]);
    const id = (await q<{ id: string }>(`INSERT INTO attendance_punches
    (organization_id, location_id, shift_id, organization_worker_membership_id, user_id, punch_type, client_event_id, origin, declared_at, effective_at,
     code_method, code_status, location_status, initial_validation, session_in_punch_id, created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,gen_random_uuid(),'offline',$7,$7,'pin','invalid','unavailable','pending_review',$8,$5) RETURNING id`,
    [H, L, S1, who.owm, who.userId, type, new Date(t0 - minAgo * 60_000).toISOString(), sessionIn])).rows[0].id;
    await db.query("COMMIT"); return id;
  };
  const w2in = await offline("in", 50); await offline("out", 20, w2in);
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000 - 4 * 3_600_000).toISOString().slice(0, 10);
  const rep = await call("GET", `${PUN}/establishments/${L}/report?from=${day(-2)}&to=${day(0)}`, adminH.token);
  const rows = (rep.body.report?.rows ?? []) as Json[];
  const sumV = rows.reduce((n, r) => n + r.validatedMinutes, 0), sumP = rows.reduce((n, r) => n + r.pendingMinutes, 0);
  const pw1 = (rep.body.report?.people as Json[] | undefined)?.find((p) => p.membershipId === w1.owm);
  const pw2 = (rep.body.report?.people as Json[] | undefined)?.find((p) => p.membershipId === w2.owm);
  const pastRow = rows.find((r) => r.shiftId === SPAST);
  check("R1. El informe cuadra con los ponches: 8 h justificadas (validadas) del turno pasado, 30 min pendientes de w2 (sin conexión) y la sesión abierta de w1; totales = suma de filas; validadas y pendientes separadas",
    rep.status === 200 && pastRow?.validatedMinutes === 480 && pastRow?.pendingMinutes === 0 && pw2?.pendingMinutes === 30 && pw2?.validatedMinutes === 0
    && pw1?.openSessions === 1 && rep.body.report.totals.validatedMinutes === sumV && rep.body.report.totals.pendingMinutes === sumP
    && rep.body.report.totals.shifts === rows.length && rep.body.report.days === 3,
    { status: rep.status, pastRow: pastRow && { v: pastRow.validatedMinutes, p: pastRow.pendingMinutes }, pw1, pw2, totals: rep.body.report?.totals });
  const week = await call("GET", `${PUN}/establishments/${L}/weeks/${rep.body.report ? (() => { const d = new Date(`${day(0)}T00:00:00Z`); const wd = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - wd * 86_400_000).toISOString().slice(0, 10); })() : day(0)}`, adminH.token);
  const wkS1 = (week.body.week?.rows as Json[] | undefined)?.filter((r) => r.shiftId === S1).map((r) => [r.membershipId, r.validatedMinutes, r.pendingMinutes]).sort();
  const repS1 = rows.filter((r) => r.shiftId === S1).map((r) => [r.membershipId, r.validatedMinutes, r.pendingMinutes]).sort();
  check("R2. Mismo cálculo que la asistencia semanal de F4 (las filas del turno coinciden)", JSON.stringify(wkS1) === JSON.stringify(repS1), { wkS1, repS1 });
  const r32 = await call("GET", `${PUN}/establishments/${L}/report?from=${day(-31)}&to=${day(0)}`, adminH.token);
  const r31 = await call("GET", `${PUN}/establishments/${L}/report?from=${day(-30)}&to=${day(0)}`, adminH.token);
  const rInv = await call("GET", `${PUN}/establishments/${L}/report?from=${day(0)}&to=${day(-1)}`, adminH.token);
  const rBad = await call("GET", `${PUN}/establishments/${L}/report?from=2026-02-30&to=2026-03-01`, adminH.token);
  const rOff = await call("GET", `/organizations/${H2}/residential/attendance/establishments/${L2}/report?from=${day(0)}&to=${day(0)}`, adminH2.token);
  const rW = await call("GET", `${PUN}/establishments/${L}/report?from=${day(0)}&to=${day(0)}`, w1.token);
  const rX = await call("GET", `${PUN}/establishments/${L2}/report?from=${day(0)}&to=${day(0)}`, adminH.token);
  const rA = await call("GET", `/organizations/${A}/residential/attendance/establishments/${L}/report?from=${day(0)}&to=${day(0)}`, adminA.token);
  check("R3. Rango libre de 1 a 31 días (32 → 400), fechas inválidas o invertidas 400; sin HOGAR_PONCHES 404; el personal 403; otro hogar 404; agencia 403",
    r31.status === 200 && r32.status === 400 && r32.body.error === "RESIDENTIAL_REPORT_RANGE_INVALID" && rInv.status === 400 && rBad.status === 400
    && rOff.status === 404 && rW.status === 403 && rX.status === 404 && rA.status === 403,
    { r31: r31.status, r32: [r32.status, r32.body.error], rInv: rInv.status, rBad: rBad.status, rOff: rOff.status, rW: rW.status, rX: rX.status, rA: rA.status });

  // ---- S. Informe de asignaciones -----------------------------------------------------------------------------------------
  await call("POST", `/organizations/${H}/residential/assignments/shifts/${S1}/redistribute`, adminH.token, { moves: [{ careRecipientId: R2, fromMembershipId: w2.owm, toMembershipId: null }], confirmUncovered: true, uncoveredReason: "Salida familiar autorizada" });
  const arep = await call("GET", `/organizations/${H}/residential/assignments/establishments/${L}/report?from=${day(-2)}&to=${day(1)}`, adminH.token);
  const aS1 = (arep.body.report?.shifts as Json[] | undefined)?.find((s) => s.shiftId === S1);
  const aOff = await call("GET", `/organizations/${HB}/residential/assignments/establishments/${LB}/report?from=${day(0)}&to=${day(0)}`, adminH.token);
  const a32 = await call("GET", `/organizations/${H}/residential/assignments/establishments/${L}/report?from=${day(-31)}&to=${day(0)}`, adminH.token);
  check("S1. Informe de asignaciones: por turno personal, residentes, periodos y alertas; detalle de alertas con motivo; rango ≤ 31 días; otro hogar u hogar sin el interruptor no",
    arep.status === 200 && aS1?.staff === 2 && aS1?.residents === 2 && aS1?.periods >= 2 && aS1?.coverageAlerts === 1
    && (arep.body.report.coverageAlerts as Json[]).some((a) => a.reason === "Salida familiar autorizada") && arep.body.report.totals.openCoverageAlerts === 1
    && a32.status === 400 && aOff.status >= 400, { arep: arep.status, aS1, totals: arep.body.report?.totals, a32: a32.status, aOff: aOff.status });

  // ---- P. Panel completo ----------------------------------------------------------------------------------------------------
  const ov = await call("GET", `/organizations/${H}/residential/overview`, adminH.token);
  const panel = ov.body.overview?.panel;
  const ov2 = await call("GET", `/organizations/${H2}/residential/overview`, adminH2.token);
  const ovW = await call("GET", `/organizations/${H}/residential/overview`, w1.token);
  check("P1. Panel: ocupación (habitaciones, camas, residentes), presentes (w1 con sesión abierta; w2 ya salió), ponches por revisar, alertas y residentes sin cobertura ahora",
    ov.status === 200 && panel?.occupancy?.rooms === 1 && panel.occupancy.bedsRegistered === 2 && panel.occupancy.bedsOccupied === 1 && panel.occupancy.activeResidents === 3
    && panel.attendance?.present?.length === 1 && panel.attendance.present[0].workerName === "Ficticia w1" && panel.attendance.pendingReview === 2
    && panel.assignments?.ongoingShifts === 1 && panel.assignments.uncovered.map((u: Json) => u.name).sort().join() === ["Ramón Ficticio", "Rita Ficticio"].sort().join()
    && panel.assignments.openCoverageAlerts === 1,
    { occ: panel?.occupancy && { ...panel.occupancy, establishments: undefined }, att: panel?.attendance, asg: panel?.assignments });
  check("P2. Cada parte del panel solo con su interruptor (sin HOGAR_PONCHES la asistencia es null); el personal no ve el panel (403)",
    ov2.status === 200 && ov2.body.overview.panel.attendance === null && ov2.body.overview.panel.assignments !== null && ovW.status === 403, [ov2.body.overview?.panel?.attendance, ovW.status]);

  // P3 (auditoría GPT 28-nov): presentes = solo entradas confirmadas (validadas o justificadas). Una entrada pendiente de
  // revisión no es presencia confirmada (cuenta en «por revisar»). Una salida no reconocida no cierra una sesión válida;
  // una salida pendiente sí la cierra (la persona declaró que salió), como en el cálculo de horas de F4.
  const w2open = await offline("in", 10);
  const w1in = (await q<{ id: string }>(`SELECT id FROM attendance_punches WHERE shift_id=$1 AND organization_worker_membership_id=$2 AND punch_type='in'`, [S1, w1.owm])).rows[0].id;
  const w1badOut = await offline("out", 5, w1in, w1);
  const rv = await call("POST", `${PUN}/punches/review`, adminH.token, { punchIds: [w1badOut], decision: "not_recognized", reason: "Salida ficticia no reconocida" });
  const ov3 = await call("GET", `/organizations/${H}/residential/overview`, adminH.token);
  const att3 = ov3.body.overview?.panel?.attendance;
  const rep3 = await call("GET", `${PUN}/establishments/${L}/report?from=${day(0)}&to=${day(0)}`, adminH.token);
  const w1rows = ((rep3.body.report?.rows ?? []) as Json[]).filter((r) => r.shiftId === S1 && r.membershipId === w1.owm);
  check("P3. Panel: una entrada pendiente de revisión no aparece como presente (sigue en «por revisar») y una salida no reconocida no cierra la sesión válida (w1 sigue presente, igual que en el informe)",
    rv.status === 200 && ov3.status === 200 && att3?.present?.length === 1 && att3.present[0].workerName === "Ficticia w1" && !att3.present.some((x: Json) => x.workerName === "Ficticia w2")
    && att3.pendingReview === 3 && w1rows.length === 1 && w1rows[0].openSession === true,
    { rv: rv.status, att3, w1rows: w1rows.map((r) => r.openSession), w2open: !!w2open });
  const w1goodOut = await mp(S1, w1, "out", 2);
  const ov4 = await call("GET", `/organizations/${H}/residential/overview`, adminH.token);
  check("P4. Una salida válida sí cierra la sesión: w1 deja de estar presente",
    w1goodOut.status === 201 && ov4.status === 200 && ov4.body.overview?.panel?.attendance?.present?.length === 0, { out: w1goodOut.status, att: ov4.body.overview?.panel?.attendance });

  // ---- O. Centro operacional --------------------------------------------------------------------------------------------------
  const opsH = await call("GET", `/organizations/${H}/operations/center`, adminH.token);
  const opsA = await call("GET", `/organizations/${A}/operations/center`, adminA.token);
  const hShiftIds = (await q<{ id: string }>(`SELECT s.id FROM shifts s JOIN establishment_technical_rooms t ON t.room_id = s.room_id WHERE s.organization_id=$1`, [H])).rows.map((r) => r.id);
  const opsHText = JSON.stringify(opsH.body);
  check("O1. Centro operacional: en el hogar ningún turno de la habitación técnica aparece como turno sin cubrir o sin entrada; la agencia conserva su turno",
    opsH.status === 200 && hShiftIds.length >= 3 && hShiftIds.every((id) => !opsHText.includes(id)) && opsA.status === 200,
    { opsH: opsH.status, ids: hShiftIds.length, opsA: opsA.status });

  // ---- Z. Central ----------------------------------------------------------------------------------------------------------
  const list = await call("GET", "/platform/organizations", tC);
  const row = (id: string) => (list.body.organizations as Json[] | undefined)?.find((o) => o.id === id);
  const ovB = await call("GET", `/platform/organizations/${HB}/overview`, tC), ovD = await call("GET", `/platform/organizations/${HD}/overview`, tC);
  const ovH = await call("GET", `/platform/organizations/${H}/overview`, tC), ovA = await call("GET", `/platform/organizations/${A}/overview`, tC);
  const centralText = JSON.stringify([list.body, ovB.body, ovD.body, ovH.body]);
  const direct2 = await asUser<{ n: number | null }>(adminH, H, `SELECT app_platform_residential_active_residents($1) AS n`, [H]);
  check("Z1. Central: residentes activos únicos (11, sin la inactiva) con alerta al pasar de 10, sin bloquear; Hogar Demo (12) excluido de la alerta; agencias sin el campo",
    list.status === 200 && row(HB)?.residentialSubscription?.activeResidents === 11 && row(HB)?.residentialSubscription?.overLimit === true
    && row(HD)?.residentialSubscription?.demo === true && row(HD)?.residentialSubscription?.overLimit === false && row(H)?.residentialSubscription?.activeResidents === 3
    && row(H)?.residentialSubscription?.overLimit === false && !!row(A) && !("residentialSubscription" in (row(A) ?? {}))
    && ovB.body.counts?.residents === 11 && ovB.body.residentialSubscription?.overLimit === true && ovD.body.residentialSubscription?.overLimit === false
    && ovA.status === 200 && !("residentialSubscription" in ovA.body),
    { HB: row(HB)?.residentialSubscription, HD: row(HD)?.residentialSubscription, H: row(H)?.residentialSubscription, ovB: ovB.body.counts });
  const hbBlocked = await call("POST", `/organizations/${HB}/residential/establishments/${LB}/rooms`, (await person(HB, "admin-hb", ["ORGANIZATION_ADMIN"])).token, { name: "Habitación 1" });
  check("Z2. Central no recibe nombres (solo el número) y la función agregada solo responde a ETNARA central; pasar de 10 no bloquea nada",
    !/Grande\d|Demo\d|Rosa|Inactiva/.test(centralText) && direct2[0]?.n === null && hbBlocked.status === 201, { names: centralText.match(/Grande\d|Demo\d|Rosa/)?.[0], direct2, hbBlocked: hbBlocked.status });

  const techRoom = await tech(L);
  check("Z3. Ninguna respuesta contiene la habitación técnica", !bodies.some((b) => b.includes(techRoom)) && bodies.length > 50, bodies.length);
  check("Z4. Nunca un 500 en todo el recorrido", errors500.length === 0, errors500);

  server.close(); await pool.end(); await rtClient.end(); await db.end();
  await srv.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await srv.end();
  void runAttendanceJob; void headers; void R3; void SFW;
}

main().then(() => {
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 1500)}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 1500)}`}`); console.error(e); process.exit(1); });
