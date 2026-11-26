/**
 * F6 · Hogares: ensayo integral en un entorno aislado (plan §6 F6 y §11). Datos FICTICIOS, base PROPIA desechable,
 * aplicación real por HTTP como app_runtime. Sustituye al recorrido en Hogar Demo hasta que exista en producción:
 * un hogar con la operación representativa de D9 (10 residentes, 6 habitaciones, 12 camas, 15 empleados, plantillas de
 * día, tarde y noche, semana publicada, asignaciones, una sustitución, ponches dentro, fuera del perímetro, sin conexión
 * y manual, actividades e informes) recorrido por Central, la administración, el personal y la familia, de F0 a F5.
 * Incluye la regresión mínima de una agencia en la misma base. Nunca un 500 ni la habitación técnica en una respuesta.
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
  const dbName = `etnara_f6_${randomBytes(4).toString("hex")}`;
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




  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const prLocal = (d: Date) => new Date(d.getTime() - 4 * 3_600_000).toISOString().slice(0, 16);  // Puerto Rico (UTC−4, sin horario de verano)
  const mondayOf = (d: Date) => { const l = new Date(d.getTime() - 4 * 3_600_000); const wd = (l.getUTCDay() + 6) % 7; return new Date(l.getTime() - wd * 86_400_000).toISOString().slice(0, 10); };
  const central = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [`f6-central-${tag}@example.invalid`, hash])).rows[0].id;
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central]);
  const tC = (await call("POST", "/auth/login", "", { email: `f6-central-${tag}@example.invalid`, password })).body.token as string;

  // ---- F0 · Central: alta del hogar e interruptores -------------------------------------------------------------------
  const created = await call("POST", "/platform/organizations", tC, { name: `Hogar Ensayo Ficticio ${tag}`, organizationType: "RESIDENTIAL_CARE_HOME", status: "active" });
  const H = created.body.organization?.id as string;
  const switches = [];
  for (const f of ["HOGAR_CALENDARIO", "HOGAR_ASIGNACIONES", "HOGAR_PONCHES", "DEMO_ENVIRONMENT"])
    switches.push((await call("PUT", `/platform/organizations/${H}/features/${f}`, tC, { enabled: true, reason: "Ensayo integral F6 con datos ficticios" })).status);
  const forbidden = await call("PUT", `/platform/organizations/${H}/features/FINANZAS`, tC, { enabled: true, reason: "No debe permitirse en hogares" });
  check("F0. Central crea el hogar, enciende HOGAR_* y DEMO_ENVIRONMENT con motivo y no permite módulos denegados (Finanzas)",
    created.status === 201 && switches.every((s) => s === 200) && forbidden.status >= 400 && forbidden.status < 500, { created: created.status, switches, forbidden: forbidden.status });
  const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'Ficticia') RETURNING id`, [H])).rows[0].id;
  await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  await q(`INSERT INTO organization_care_event_types (organization_id,care_event_type_id,is_enabled) SELECT $1,id,true FROM care_event_types ON CONFLICT DO NOTHING`, [H]);
  const admin = await person(H, "admin", ["ORGANIZATION_ADMIN"]);
  const ov0 = await call("GET", `/organizations/${H}/residential/overview`, admin.token);
  const fin = await call("GET", `/organizations/${H}/finance/summary`, admin.token);
  check("F0b. Panel del hogar con los módulos encendidos; Finanzas cerrada para el hogar (403)",
    ov0.status === 200 && ov0.body.overview.features.filter((f: Json) => f.enabled).length === 4 && fin.status === 403, { ov: ov0.status, fin: fin.status });

  // ---- F1 · Establecimiento, 6 habitaciones, 12 camas, 10 residentes, geocerca ----------------------------------------------
  const L = (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,'Casa Ensayo') RETURNING id`, [H])).rows[0].id;
  const R = `/organizations/${H}/residential`;
  const rooms: string[] = [];
  for (let i = 1; i <= 6; i++) rooms.push((await call("POST", `${R}/establishments/${L}/rooms`, admin.token, { name: `Habitación ${100 + i}`, bedCapacity: 2 })).body.room?.id);
  const geo = await call("PUT", `${R}/establishments/${L}/geofence`, admin.token, { radiusMeters: 100, latitude: 18.401234, longitude: -66.051234, reason: "Centro ficticio para el ensayo" });
  const names = ["Ana", "Benito", "Carmen", "Daniel", "Elena", "Félix", "Gloria", "Héctor", "Irma", "Julio"];
  const residents: string[] = [];
  for (const n of names) residents.push((await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,location_id,first_name,last_name,status) VALUES ($1,$2,$3,'Ficticio','active') RETURNING id`, [H, L, n])).rows[0].id);
  const placed = [];
  for (let i = 0; i < 9; i++) placed.push((await call("PUT", `${R}/residents/${residents[i]}/placement`, admin.token, { roomId: rooms[Math.floor(i / 2)], reason: "Ingreso ficticio" })).status);
  const est = await call("GET", `${R}/establishments`, admin.token);
  const occ = est.body.establishments?.[0]?.occupancy;
  check("F1. 6 habitaciones con 12 camas; 9 residentes ubicados y 1 sin habitación; ocupación 9/12; geocerca configurada",
    rooms.every(Boolean) && geo.status === 200 && placed.every((s) => s === 200) && occ?.rooms === 6 && occ?.bedsRegistered === 12 && occ?.bedsOccupied === 9 && occ?.residentsWithoutRoom === 1,
    { rooms: rooms.filter(Boolean).length, geo: geo.status, placed, occ });

  // ---- Personal: 15 empleados (uno sin credenciales) ---------------------------------------------------------------
  const staff: P[] = [];
  for (let i = 1; i <= 15; i++) staff.push(await person(H, `e${i}`, ["WORKER"], true, { eligible: i !== 15 }));
  for (const s of staff) await q(`INSERT INTO establishment_worker_assignments (organization_id,location_id,organization_worker_membership_id) VALUES ($1,$2,$3)`, [H, L, s.owm]);

  // ---- F2 · Plantillas de día, tarde y noche; semana siguiente publicada ------------------------------------------------
  const S = `${R}/schedule`;
  const now = new Date(), thisWeek = mondayOf(now), nextWeek = mondayOf(new Date(now.getTime() + 7 * 86_400_000));
  const slots = [1, 2, 3, 4, 5, 6, 7].flatMap((weekday) => [
    { weekday, startTime: "07:00", durationMinutes: 480, headcount: 2, label: "Día" },
    { weekday, startTime: "15:00", durationMinutes: 480, headcount: 2, label: "Tarde" },
    { weekday, startTime: "23:00", durationMinutes: 480, headcount: 1, label: "Noche" },
  ]);
  const tpl = await call("POST", `${S}/establishments/${L}/templates`, admin.token, { name: "Día, tarde y noche", slots });
  const applied = await call("POST", `${S}/establishments/${L}/weeks/${nextWeek}/apply-template`, admin.token, { templateId: tpl.body.template?.id });
  const wk = await call("GET", `${S}/establishments/${L}/weeks/${nextWeek}`, admin.token);
  const entries = (wk.body.schedule?.entries ?? []) as Json[];
  let k = 0; const patched = [];
  for (const e of entries.slice(0, 12)) patched.push((await call("PATCH", `${S}/entries/${e.id}`, admin.token, { membershipId: staff[k++ % 14].owm })).status);
  const pub = await call("POST", `${S}/establishments/${L}/weeks/${nextWeek}/publish`, admin.token, {});
  const nextShifts = (await q<{ n: number }>(`SELECT count(*)::int n FROM schedule_week_shifts e JOIN schedule_weeks w ON w.id=e.week_id WHERE w.week_start=$1 AND w.organization_id=$2 AND e.shift_id IS NOT NULL`, [nextWeek, H])).rows[0].n;
  const notices = (await q<{ n: number }>(`SELECT count(*)::int n FROM notifications WHERE organization_id=$1 AND related_entity_type='schedule_week'`, [H])).rows[0].n;
  check("F2. Plantilla de día, tarde y noche aplicada a la semana siguiente (35 turnos), 12 asignados y publicada con versión y avisos",
    tpl.status === 201 && applied.status === 200 && entries.length === 35 && patched.every((s) => s === 200) && pub.status === 200 && nextShifts === 35 && notices > 0,
    { tpl: tpl.status, applied: applied.status, entries: entries.length, pub: [pub.status, pub.body.error], nextShifts, notices });

  // ---- Turno de hoy: empieza en ~2 minutos, tres personas, publicado ------------------------------------------------------
  const start = new Date(Math.ceil((Date.now() + 90_000) / 60_000) * 60_000);
  const todayIds = [];
  for (const s of staff.slice(0, 3)) todayIds.push((await call("POST", `${S}/establishments/${L}/weeks/${mondayOf(start)}/entries`, admin.token, { startsAt: prLocal(start), durationMinutes: 480, membershipId: s.owm, label: "Ensayo" })).body.entry?.id);
  const pubToday = await call("POST", `${S}/establishments/${L}/weeks/${mondayOf(start)}/publish`, admin.token, {});
  const todayShifts = (await q<{ shift_id: string; membership_id: string }>(`SELECT e.shift_id, e.organization_worker_membership_id AS membership_id FROM schedule_week_shifts e WHERE e.id = ANY($1::uuid[])`, [todayIds])).rows;
  const shiftOf = (s: P) => todayShifts.find((x) => x.membership_id === s.owm)!.shift_id;
  // El personal acepta su turno publicado desde su portal.
  const accepted = [];
  for (const s of staff.slice(0, 3)) accepted.push((await call("POST", `/organizations/${H}/me/shifts/${shiftOf(s)}/respond`, s.token, { decision: "accepted" })).status);
  const acc = (await q<{ n: number }>(`SELECT count(*)::int n FROM assignments WHERE shift_id = ANY($1::uuid[]) AND response_status='accepted'`, [todayShifts.map((x) => x.shift_id)])).rows[0].n;
  check("F2b. Turnos de hoy publicados (uno por persona, en el establecimiento) y aceptados por el personal desde su portal",
    pubToday.status === 200 && todayShifts.length === 3 && todayShifts.every((x) => !!x.shift_id) && accepted.every((x) => x === 200) && acc === 3,
    { pub: [pubToday.status, pubToday.body.error], shifts: todayShifts.length, accepted, acc, thisWeek });

  // ---- F3 · Asignaciones y una sustitución antes del inicio ------------------------------------------------------------------
  const A = `${R}/assignments`;
  const [e1, e2, e3, e4] = staff;
  const as1 = await call("POST", `${A}/shifts/${shiftOf(e1)}/residents`, admin.token, { membershipId: e1.owm, careRecipientIds: residents.slice(0, 4) });
  const as2 = await call("POST", `${A}/shifts/${shiftOf(e2)}/residents`, admin.token, { membershipId: e2.owm, careRecipientIds: residents.slice(4, 8) });
  const as3 = await call("POST", `${A}/shifts/${shiftOf(e3)}/residents`, admin.token, { membershipId: e3.owm, careRecipientIds: residents.slice(8, 10) });
  const prev = await call("POST", `${R}/substitutions/shifts/${shiftOf(e3)}/preview`, admin.token, { originalMembershipId: e3.owm, substituteMembershipId: e4.owm });
  const blocked = await call("POST", `${R}/substitutions/shifts/${shiftOf(e3)}/preview`, admin.token, { originalMembershipId: e3.owm, substituteMembershipId: staff[14].owm });
  const sub = await call("POST", `${R}/substitutions/shifts/${shiftOf(e3)}`, admin.token, { originalMembershipId: e3.owm, substituteMembershipId: e4.owm, reasonCode: "schedule_change",
    transfers: residents.slice(8, 10).map((r) => ({ careRecipientId: r, toMembershipId: e4.owm })) });
  check("F3. Asignaciones 4/4/2; la sustitución bloquea a quien no tiene credenciales y la completa a una persona elegible transfiere sus 2 residentes",
    [as1, as2, as3].every((x) => x.status === 201) && prev.body.preview?.blocks.length === 0 && prev.body.preview.fullReplacement === true
    && blocked.body.preview?.blocks.includes("not_eligible") && sub.status === 201, { as: [as1.status, as2.status, as3.status], prev: prev.body.preview, blocked: blocked.body.preview?.blocks, sub: [sub.status, sub.body.error] });

  // ---- F4 · Código de la semana, ponches dentro, fuera, sin conexión y manual ---------------------------------------------------
  const PUN = `${R}/attendance`;
  const print = await call("POST", `${PUN}/establishments/${L}/codes/print`, admin.token, { weekStart: mondayOf(start) });
  const pin = print.body.print?.pin as string;
  for (const s of [e1, e2, e4]) await call("PUT", `${PUN}/me/consent`, s.token, { version: "geo-1", accept: true });
  const punch = (s: P, body: Json, shiftId: string) => call("POST", `${PUN}/me/punch`, s.token, { clientEventId: randomUUID(), shiftId, type: "in", method: "pin", pin, ...body });
  const pIn = await punch(e1, { location: { latitude: 18.401534, longitude: -66.051234, accuracy: 15 } }, shiftOf(e1));
  const pOut = await punch(e2, { location: { latitude: 18.409876, longitude: -66.051234, accuracy: 12 } }, shiftOf(e2));
  const pOff = await punch(e4, { offline: true, declaredAt: new Date().toISOString() }, shiftOf(e3));
  const manual = await call("POST", `${PUN}/punches/manual`, admin.token, { shiftId: shiftOf(e1), membershipId: e1.owm, type: "break_start", at: new Date().toISOString(), reason: "Descanso anotado en la hoja ficticia" });
  check("F4. Código de 6 dígitos; dentro del perímetro → validado; fuera → pendiente (nunca impedido); sin conexión → pendiente; manual → justificado",
    /^\d{6}$/.test(pin ?? "") && pIn.body.punch?.validation?.effective === "validated" && pOut.body.punch?.validation?.effective === "pending_review"
    && pOff.body.punch?.validation?.effective === "pending_review" && manual.status === 201,
    { pin: !!pin, pIn: pIn.body.punch?.validation ?? pIn.body, pOut: pOut.body.punch?.validation, pOff: pOff.body.punch?.validation ?? pOff.body, manual: manual.status });

  // Esperar al inicio del turno (el acceso a residentes empieza exactamente a esa hora).
  const wait = start.getTime() - Date.now() + 3_000; if (wait > 0) await sleep(wait);

  // ---- Acceso y actividades del personal --------------------------------------------------------------------------------------
  const mine = async (s: P) => ((await call("GET", `${A}/me`, s.token)).body.residents ?? []).length;
  const counts = { e1: await mine(e1), e2: await mine(e2), e3: await mine(e3), e4: await mine(e4), e5: await mine(staff[4]) };
  const act = await call("POST", `/organizations/${H}/shifts/${shiftOf(e1)}/care-events`, e1.token, { typeCode: "MEAL", careRecipientId: residents[0], payload: { mealType: "Almuerzo", amountConsumed: "Todo" } });
  const actNo = await call("POST", `/organizations/${H}/shifts/${shiftOf(e1)}/care-events`, e1.token, { typeCode: "MOOD", careRecipientId: residents[5], payload: { mood: "Tranquilo" } });
  const act2 = await call("POST", `/organizations/${H}/shifts/${shiftOf(e3)}/care-events`, e4.token, { typeCode: "MOOD", careRecipientId: residents[9], payload: { mood: "Contento" } });
  check("F3b. Cada persona ve solo a sus residentes (4/4/0 la sustituida/2 la sustituta; nadie más) y registra actividades solo de ellos",
    counts.e1 === 4 && counts.e2 === 4 && counts.e3 === 0 && counts.e4 === 2 && counts.e5 === 0 && act.status === 201 && actNo.status >= 400 && actNo.status < 500 && act2.status === 201,
    { counts, act: act.status, actNo: actNo.status, act2: act2.status });

  // ---- F5 · Familia, informes, panel y Central -----------------------------------------------------------------------------------
  const fam = await person(H, "familia", ["FAMILY"]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [fam.userId, H, residents[0]]);
  const fOne = await call("GET", `/me/care-recipients/${residents[0]}`, fam.token);
  const fTl = await call("GET", `/organizations/${H}/care-recipients/${residents[0]}/timeline`, fam.token);
  const fSh = await call("GET", `/organizations/${H}/care-recipients/${residents[0]}/family-shifts`, fam.token);
  const fOther = await call("GET", `/organizations/${H}/care-recipients/${residents[1]}/timeline`, fam.token);
  const conv = await call("POST", `/organizations/${H}/care-recipients/${residents[0]}/conversation`, fam.token, {});
  const msg = await call("POST", `/organizations/${H}/conversations/${conv.body.conversation?.id}/messages`, fam.token, { body: "Hola, gracias por el cuidado." });
  const parts = (await q<{ user_id: string }>(`SELECT user_id FROM message_thread_participants WHERE message_thread_id=$1`, [conv.body.conversation?.id])).rows.map((r) => r.user_id);
  const item = (fTl.body.items as Json[] | undefined)?.find((i) => i.id === act.body.event?.id);
  check("F5a. Familia (D5): hogar y habitación, la actividad con autor y puesto, sin turnos, sin otro residente y conversación solo con la administración",
    fOne.body.recipient?.residence?.room === "Habitación 101" && item?.caregiver?.displayName === "Ficticia e1" && item?.fields?.mealType === "Almuerzo"
    && fSh.body.shifts?.length === 0 && fOther.status === 404 && msg.status === 201 && parts.includes(admin.userId) && !staff.some((s) => parts.includes(s.userId)),
    { residence: fOne.body.recipient?.residence, item: item?.caregiver, shifts: fSh.body.shifts?.length, other: fOther.status, msg: msg.status });
  const day = prLocal(new Date()).slice(0, 10);
  const rep = await call("GET", `${PUN}/establishments/${L}/report?from=${day}&to=${day}`, admin.token);
  const arep = await call("GET", `${A}/establishments/${L}/report?from=${day}&to=${day}`, admin.token);
  const ov = await call("GET", `/organizations/${H}/residential/overview`, admin.token);
  check("F5b. Informes: asistencia del día con validadas y pendientes por separado; asignaciones con la sustitución; panel con presentes, ponches por revisar y sin residentes sin cobertura",
    rep.status === 200 && rep.body.report.rows.length === 3 && arep.status === 200 && arep.body.report.totals.substitutions === 1
    && ov.body.overview.panel.attendance.present.length === 3 && ov.body.overview.panel.attendance.pendingReview === 2 && ov.body.overview.panel.assignments.uncovered.length === 0
    && ov.body.overview.panel.occupancy.bedsRegistered === 12,
    { rep: [rep.status, rep.body.report?.rows?.length], arep: arep.body.report?.totals, panel: ov.body.overview?.panel && { att: ov.body.overview.panel.attendance, asg: ov.body.overview.panel.assignments } });
  await q(`INSERT INTO care_recipients (organization_id,location_id,first_name,last_name,status) VALUES ($1,$2,'Kevin','Ficticio','active')`, [H, L]);
  const list = await call("GET", "/platform/organizations", tC);
  const row = (list.body.organizations as Json[] | undefined)?.find((o) => o.id === H);
  check("F5c. Central: 11 residentes activos, pero Hogar Demo (DEMO_ENVIRONMENT) queda fuera de la alerta comercial; sin nombres",
    row?.residentialSubscription?.activeResidents === 11 && row.residentialSubscription.demo === true && row.residentialSubscription.overLimit === false && !JSON.stringify(list.body).includes("Kevin"),
    row?.residentialSubscription);

  // ---- Regresión mínima de agencia en la misma base ------------------------------------------------------------------------------
  const AG = await org(`Agencia Regresión ${tag}`, "HOME_CARE_AGENCY");
  const adminA = await person(AG, "admin-a", ["ORGANIZATION_ADMIN"]);
  const agOps = await call("GET", `/organizations/${AG}/operations/center`, adminA.token);
  const agRes = await call("GET", `/organizations/${AG}/residential/overview`, adminA.token);
  check("R1. Agencia en la misma base: centro operacional disponible y /residential cerrado (403)", agOps.status === 200 && agRes.status === 403, [agOps.status, agRes.status]);

  const techRoom = (await q<{ room_id: string }>(`SELECT room_id FROM establishment_technical_rooms WHERE location_id=$1`, [L])).rows[0].room_id;
  check("Z1. Ninguna respuesta contiene la habitación técnica", !bodies.some((b) => b.includes(techRoom)) && bodies.length > 80, bodies.length);
  check("Z2. Nunca un 500 en todo el recorrido", errors500.length === 0, errors500);
  server.close(); await pool.end(); await rtClient.end(); await db.end();
  await srv.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await srv.end();
  void runAttendanceJob; void headers; void bls;
}

main().then(() => {
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 1500)}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 1500)}`}`); console.error(e); process.exit(1); });
