/**
 * 173–175 · Hogares F4: ponches con QR y código de 6 dígitos, geocerca, revisión, correcciones y alertas.
 * Datos FICTICIOS, base PROPIA desechable, aplicación real por HTTP como app_runtime. Ningún correo real, ninguna
 * salida de red. Cubre los ataques del plan (§12): reutilización de códigos, fuerza bruta, otro establecimiento,
 * repetición sin conexión, idempotencia, desfase de reloj, transición y revocación; privacidad del esquema;
 * aislamiento entre organizaciones, establecimientos y modalidades; y que nadie se revisa a sí mismo.
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
  const dbName = `etnara_att_${randomBytes(4).toString("hex")}`;
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
  const person = async (orgId: string, key: string, roles: string[], worker = false): Promise<P> => {
    const email = `at-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let owm: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Ficticia ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
    }
    const t = (await call("POST", "/auth/login", "", { email, password })).body.token as string;
    await call("POST", "/me/active-organization", t, { organizationId: orgId });
    return { userId, token: t, owm };
  };

  const H = await org(`Hogar Ponches ${tag}`, "RESIDENTIAL_CARE_HOME"), H2 = await org(`Hogar Dos ${tag}`, "RESIDENTIAL_CARE_HOME");
  const H3 = await org(`Hogar Sin Ponches ${tag}`, "RESIDENTIAL_CARE_HOME"), A = await org(`Agencia Ficticia ${tag}`, "HOME_CARE_AGENCY");
  await q(`SELECT app_ops_authorize_modality_activation('INDEPENDENT_PROVIDER','verificador local','Prueba local con datos ficticios (163: candado)',5)`);
  await q(`UPDATE platform_modalities SET enabled=true WHERE code='INDEPENDENT_PROVIDER'`);
  const I = await org(`Independiente Ficticia ${tag}`, "INDEPENDENT_PROVIDER");
  await q(`UPDATE platform_modalities SET enabled=false WHERE code='INDEPENDENT_PROVIDER'`);
  for (const o of [H, H2, H3, A]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'Ficticia') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  }
  const loc = async (o: string, n: string) => (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,$2) RETURNING id`, [o, n])).rows[0].id;
  const L = await loc(H, "Casa Ponches"), L2 = await loc(H, "Casa Ponches B"), LH2 = await loc(H2, "Casa Dos"), LH3 = await loc(H3, "Casa Tres");
  await q("BEGIN"); await q(`SELECT set_config('app.residential_change_reason','Centro ficticio de la prueba',true)`);
  await q(`UPDATE establishment_settings SET geofence_latitude=$2, geofence_longitude=$3, geofence_radius_m=100 WHERE location_id=$1`, [L, CENTER.lat, CENTER.lng]); await q("COMMIT");
  const tech = async (l: string) => (await q<{ room_id: string }>(`SELECT room_id FROM establishment_technical_rooms WHERE location_id=$1`, [l])).rows[0].room_id;
  const adminH = await person(H, "admin-h", ["ORGANIZATION_ADMIN"], true);
  const w1 = await person(H, "w1", ["WORKER"], true), w2 = await person(H, "w2", ["WORKER"], true), w3 = await person(H, "w3", ["WORKER"], true);
  const adminH2 = await person(H2, "admin-h2", ["ORGANIZATION_ADMIN"]), wH2 = await person(H2, "wh2", ["WORKER"], true);
  const adminH3 = await person(H3, "admin-h3", ["ORGANIZATION_ADMIN"]), wH3 = await person(H3, "wh3", ["WORKER"], true);
  const adminA = await person(A, "admin-a", ["ORGANIZATION_ADMIN"]), adminI = await person(I, "admin-i", ["ORGANIZATION_ADMIN"]);
  for (const o of [H, H2]) await q(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'HOGAR_PONCHES',true)`, [o]);

  const shift = async (o: string, l: string, startMin: number, endMin: number, people: P[]) => {
    const s = (await q<{ id: string }>(`INSERT INTO shifts (organization_id, room_id, scheduled_start, scheduled_end, required_role)
      VALUES ($1,$2, now() + make_interval(mins => $3), now() + make_interval(mins => $4), 'Cuidador/a') RETURNING id`, [o, await tech(l), startMin, endMin])).rows[0].id;
    for (const p of people) await q(`INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, response_status, responded_at) VALUES ($1,$2,$3,'accepted',now())`, [o, s, p.owm]);
    return s;
  };
  const S1 = await shift(H, L, -30, 450, [w1, w2, adminH]);
  const S2 = await shift(H, L2, -20, 460, [w3]);
  const SH2 = await shift(H2, LH2, -30, 450, [wH2]);
  const SH3 = await shift(H3, LH3, -30, 450, [wH3]);
  const SPEND = await shift(H, L, 600, 1000, [w3]);
  await q(`INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, response_status) VALUES ($1,$2,$3,'pending')`, [H, SPEND, w2.owm]);
  const AT = (o: string) => `/organizations/${o}/residential/attendance`;
  const punchBody = (shiftId: string, type: string, extra: Json) => ({ clientEventId: randomUUID(), shiftId, type, ...extra });

  // ---- Interruptor, modalidades y roles ---------------------------------------------------------------------------
  const off = await call("GET", `${AT(H3)}/establishments`, adminH3.token);
  const offW = await call("POST", `${AT(H3)}/me/punch`, wH3.token, punchBody(SH3, "in", { method: "pin", pin: "123456" }));
  check("A1. Hogar con HOGAR_PONCHES apagado: los ponches no existen ni para la administración ni para el personal (404 FEATURE_NOT_ENABLED)",
    off.status === 404 && off.body.error === "FEATURE_NOT_ENABLED" && offW.status === 404 && offW.body.error === "FEATURE_NOT_ENABLED", [off, offW]);
  const ag = await call("GET", `${AT(A)}/establishments`, adminA.token), ind = await call("GET", `${AT(I)}/me`, adminI.token);
  check("A2. Agencia e independiente: no existen para ellas (403 MODALITY_NOT_AVAILABLE)", ag.status === 403 && ag.body.error === "MODALITY_NOT_AVAILABLE" && ind.status === 403 && ind.body.error === "MODALITY_NOT_AVAILABLE", [ag, ind]);
  const wAdmin = await call("GET", `${AT(H)}/establishments/${L}/codes`, w1.token), nonMember = await call("GET", `${AT(H)}/me`, adminH2.token);
  check("A3. El personal no entra a la administración (403) y un no miembro no entra a nada (403)", wAdmin.status === 403 && nonMember.status === 403, [wAdmin, nonMember]);

  // ---- Códigos: metadatos, impresión, privacidad ------------------------------------------------------------------
  const codes = await call("GET", `${AT(H)}/establishments/${L}/codes`, adminH.token);
  const cols = (await q<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'attendance%'`)).rows;
  const badCols = cols.filter((c) => /(^|_)(lat|lng|latitude|longitude|coord|coords|coordinates|token|pin|secret|qr)($|_)/i.test(c.column_name));
  check("C1. La pantalla del QR crea, idempotente, el código de la semana y el de la siguiente; el esquema no tiene columnas de token, código, secreto ni coordenadas",
    codes.status === 200 && codes.body.codes.current?.version === 1 && codes.body.codes.next?.version === 1 && badCols.length === 0
    && (await q(`SELECT 1 FROM attendance_codes WHERE location_id=$1`, [L])).rows.length === 2, { s: codes.status, current: codes.body.codes?.current, badCols });
  const codes2 = await call("GET", `${AT(H)}/establishments/${L}/codes`, adminH.token);
  const week = codes.body.codes.current.weekStart as string;
  const printed = await call("POST", `${AT(H)}/establishments/${L}/codes/print`, adminH.token, { weekStart: week });
  const QR = printed.body.print?.qr as string, PIN = printed.body.print?.pin as string;
  const dump = JSON.stringify((await q(`SELECT (SELECT json_agg(t) FROM attendance_codes t) a, (SELECT json_agg(t) FROM attendance_code_events t) b, (SELECT json_agg(t) FROM notifications t) c`)).rows);
  check("C2. Imprimir deriva el QR y el código en el momento: sin caché, queda en el historial y NI el token ni el código aparecen en la base",
    printed.status === 200 && /^EA1\.k1\./.test(QR) && /^\d{6}$/.test(PIN) && printed.cache.includes("no-store") && codes2.body.codes.versions.length === 2
    && !dump.includes(QR.split(".")[5]) && !dump.includes(`"${PIN}"`)
    && (await q(`SELECT 1 FROM attendance_code_events WHERE location_id=$1 AND event_type='downloaded'`, [L])).rows.length === 1, { s: printed.status, cache: printed.cache });
  const nextAvail = new Date(codes.body.codes.next.availableFrom).getTime() <= Date.now();
  const printNext = await call("POST", `${AT(H)}/establishments/${L}/codes/print`, adminH.token, { weekStart: codes.body.codes.next.weekStart });
  check("C3. El código de la semana siguiente solo se imprime desde su «disponible desde» (72 h antes del lunes)",
    nextAvail ? printNext.status === 200 : printNext.status === 409 && printNext.body.error === "ATTENDANCE_CODE_NOT_AVAILABLE", { nextAvail, printNext });
  const otherHome = await call("GET", `${AT(H)}/establishments/${LH2}/codes`, adminH.token), otherPrint = await call("POST", `${AT(H2)}/establishments/${L}/codes/print`, adminH2.token, { weekStart: week });
  check("C4. La administración de un hogar no ve ni imprime el código de otro hogar (404)", otherHome.status === 404 && otherPrint.status === 404, [otherHome, otherPrint]);

  // ---- Ponchar: validado, idempotencia, máquina de estados ----------------------------------------------------------
  const me = await call("GET", `${AT(H)}/me`, w1.token);
  const consent = await call("PUT", `${AT(H)}/me/consent`, w1.token, { version: "geo-1", accept: true });
  await call("PUT", `${AT(H)}/me/consent`, w2.token, { version: "geo-1", accept: true });
  check("P1. «Ponchar» muestra solo los turnos propios del establecimiento (no los pendientes ni de otros) y el consentimiento es propio y versionado",
    me.status === 200 && me.body.attendance.shifts.map((s: Json) => s.shiftId).join() === S1 && me.body.attendance.consent.accepted === false && consent.status === 200, me.body);
  const inBody = punchBody(S1, "in", { method: "qr", qr: QR, location: INSIDE });
  const in1 = await call("POST", `${AT(H)}/me/punch`, w1.token, inBody);
  const p1 = in1.body.punch;
  check("P2. Entrada en línea con QR vigente, dentro del perímetro → validada; cuatro dimensiones; distancia redondeada a 10 m",
    in1.status === 201 && p1.validation.initial === "validated" && p1.code.status === "current" && p1.location.status === "inside" && p1.origin === "online"
    && p1.location.distanceM % 10 === 0 && p1.location.distanceM <= 100 && p1.flags.length === 0, p1);
  const again = await call("POST", `${AT(H)}/me/punch`, w1.token, inBody);
  const second = await call("POST", `${AT(H)}/me/punch`, w1.token, punchBody(S1, "in", { method: "pin", pin: PIN, location: INSIDE }));
  const nIn = (await q(`SELECT count(*)::int n FROM attendance_punches WHERE user_id=$1 AND punch_type='in'`, [w1.userId])).rows[0].n;
  check("P3. Idempotencia: el mismo client_event_id devuelve el mismo ponche; una segunda entrada con la sesión abierta devuelve la existente",
    again.status === 200 && again.body.duplicate && again.body.punch.id === p1.id && second.status === 200 && second.body.punch.id === p1.id && nIn === 1, [again.status, second.status, nIn]);
  const bs = await call("POST", `${AT(H)}/me/punch`, w1.token, punchBody(S1, "break_start", { method: "pin", pin: PIN, location: INSIDE }));
  const be = await call("POST", `${AT(H)}/me/punch`, w1.token, punchBody(S1, "break_end", { method: "pin", pin: PIN, location: INSIDE }));
  const be2 = await call("POST", `${AT(H)}/me/punch`, w1.token, punchBody(S1, "break_end", { method: "pin", pin: PIN, location: INSIDE }));
  const out1 = await call("POST", `${AT(H)}/me/punch`, w1.token, punchBody(S1, "out", { method: "pin", pin: PIN, location: INSIDE }));
  check("P4. Descanso y salida con el código de 6 dígitos → validados y ligados a la sesión; un fin de descanso sin descanso abierto → orden imposible, pendiente",
    bs.body.punch?.validation.initial === "validated" && be.body.punch?.validation.initial === "validated" && out1.body.punch?.validation.initial === "validated"
    && be2.body.punch?.validation.initial === "pending_review" && be2.body.punch.flags.includes("impossible_order"), [bs.body, be2.body, out1.body]);
  // P5 (27-nov). Concurrencia: el teléfono reenvía el mismo ponche a la vez (cola sin conexión + reintento) y la misma
  // persona entra dos veces a la vez desde dos pantallas. Nunca un 500, un solo ponche y una sola sesión abierta.
  {
    const w4 = await person(H, "w4", ["WORKER"], true), w5 = await person(H, "w5", ["WORKER"], true);
    const S4 = await shift(H, L, -30, 450, [w4]), S5 = await shift(H, L, -30, 450, [w5]);
    const same = punchBody(S4, "in", { method: "pin", pin: PIN, location: INSIDE });
    const sameRuns = await Promise.all(Array.from({ length: 6 }, () => call("POST", `${AT(H)}/me/punch`, w4.token, same)));
    const sameRows = (await q(`SELECT count(*)::int n FROM attendance_punches WHERE user_id=$1 AND client_event_id=$2`, [w4.userId, same.clientEventId])).rows[0].n;
    const sameIds = new Set(sameRuns.map((r) => r.body.punch?.id));
    // La salida y el descanso no tienen «sesión abierta» que devolver: es donde el reenvío simultáneo podía fallar.
    const sameOut = punchBody(S4, "out", { method: "pin", pin: PIN, location: INSIDE });
    const outRuns = await Promise.all(Array.from({ length: 6 }, () => call("POST", `${AT(H)}/me/punch`, w4.token, sameOut)));
    const outRows = (await q(`SELECT count(*)::int n FROM attendance_punches WHERE user_id=$1 AND client_event_id=$2`, [w4.userId, sameOut.clientEventId])).rows[0].n;
    const outIds = new Set(outRuns.map((r) => r.body.punch?.id));
    const diffRuns = await Promise.all(Array.from({ length: 6 }, () => call("POST", `${AT(H)}/me/punch`, w5.token, punchBody(S5, "in", { method: "pin", pin: PIN, location: INSIDE }))));
    const diffIn = (await q(`SELECT count(*)::int n FROM attendance_punches WHERE user_id=$1 AND shift_id=$2 AND punch_type='in'`, [w5.userId, S5])).rows[0].n;
    // El descanso usa la sesión abierta por esas entradas.
    const sameBreak = punchBody(S5, "break_start", { method: "pin", pin: PIN, location: INSIDE });
    const brRuns = await Promise.all(Array.from({ length: 6 }, () => call("POST", `${AT(H)}/me/punch`, w5.token, sameBreak)));
    const brRows = (await q(`SELECT count(*)::int n FROM attendance_punches WHERE user_id=$1 AND client_event_id=$2`, [w5.userId, sameBreak.clientEventId])).rows[0].n;
    // Cliente defectuoso: el mismo client_event_id para dos turnos distintos a la vez (bloqueos distintos) → un ponche;
    // el otro envío devuelve ese mismo ponche (200) o un conflicto del cliente (409), nunca un 500.
    const S4b = await shift(H, L, 500, 900, [w4]);
    const crossOut: Json[] = []; let crossRows = 0;
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      const r = await Promise.all([
        call("POST", `${AT(H)}/me/punch`, w4.token, { ...punchBody(S4, "break_start", { method: "pin", pin: PIN, location: INSIDE }), clientEventId: id }),
        call("POST", `${AT(H)}/me/punch`, w4.token, { ...punchBody(S4b, "in", { method: "pin", pin: PIN, location: INSIDE }), clientEventId: id }),
      ]);
      crossRows += (await q(`SELECT count(*)::int n FROM attendance_punches WHERE user_id=$1 AND client_event_id=$2`, [w4.userId, id])).rows[0].n;
      crossOut.push(r.map((x) => [x.status, x.body.error ?? null]));
    }
    const crossOk = crossRows === 3 && crossOut.every((pair) => (pair as [number, string | null][]).filter(([st]) => st === 201).length === 1
      && (pair as [number, string | null][]).every(([st, er]) => st === 201 || st === 200 || (st === 409 && er === "ATTENDANCE_DUPLICATE_EVENT")));
    const okRuns = (runs: { status: number }[]) => runs.every((r) => r.status === 200 || r.status === 201) && runs.filter((r) => r.status === 201).length === 1;
    const diffIds = new Set(diffRuns.map((r) => r.body.punch?.id));
    check("P5. Concurrencia: 6 envíos simultáneos del mismo ponche (entrada, salida y descanso) → nunca un 500, un solo ponche y todos devuelven el mismo; 6 entradas simultáneas distintas de la misma persona → una sola entrada y una sola sesión; el mismo identificador para dos turnos a la vez → un ponche y 200/409, nunca 500",
      okRuns(sameRuns) && sameRows === 1 && sameIds.size === 1 && okRuns(outRuns) && outRows === 1 && outIds.size === 1
      && okRuns(brRuns) && brRows === 1 && new Set(brRuns.map((r) => r.body.punch?.id)).size === 1
      && diffRuns.every((r) => r.status === 200 || r.status === 201) && diffIn === 1 && diffIds.size === 1 && crossOk,
      { crossOut, crossRows, same: sameRuns.map((r) => [r.status, r.body.error]), sameRows, out: outRuns.map((r) => [r.status, r.body.error]), outRows,
        brk: brRuns.map((r) => [r.status, r.body.error]), brRows, diffs: diffRuns.map((r) => [r.status, r.body.error]), diffIn });
  }

  // ---- Ubicación: fuera, precisión baja, sin consentimiento; sin coordenadas guardadas ----------------------------------
  const outIn = await call("POST", `${AT(H)}/me/punch`, w2.token, punchBody(S1, "in", { method: "qr", qr: QR, location: OUTSIDE }));
  const alert1 = (await q(`SELECT kind FROM attendance_alerts WHERE punch_id=$1`, [outIn.body.punch?.id])).rows;
  const notice = (await q(`SELECT 1 FROM notifications WHERE user_id=$1 AND notification_type='ATTENDANCE_REVIEW_NEEDED'`, [adminH.userId])).rows.length;
  check("G1. Fuera del perímetro: el ponche NO se impide, queda pendiente de revisión, crea una alerta y avisa a la administración (sin datos personales)",
    outIn.status === 201 && outIn.body.punch.location.status === "outside" && outIn.body.punch.validation.initial === "pending_review"
    && alert1.some((a) => a.kind === "outside_perimeter") && notice >= 1, [outIn.body, alert1, notice]);
  const fuzzy = await call("POST", `${AT(H)}/me/punch`, w2.token, punchBody(S1, "out", { method: "qr", qr: QR, location: FUZZY }));
  await call("PUT", `${AT(H)}/me/consent`, w2.token, { version: "geo-1", accept: false });
  const noConsent = await call("POST", `${AT(H)}/me/punch`, w2.token, punchBody(S1, "in", { method: "qr", qr: QR, location: INSIDE }));
  const allPunches = JSON.stringify((await q(`SELECT json_agg(t) j FROM attendance_punches t`)).rows[0].j);
  const coordLeak = [INSIDE, OUTSIDE, FUZZY].some((p) => allPunches.includes(String(p.latitude)) || allPunches.includes(String(p.longitude))) || allPunches.includes(String(CENTER.lat));
  check("G2. Precisión baja → «precisión baja» y pendiente; sin consentimiento vigente la ubicación no se usa («no disponible»); ninguna coordenada se guarda",
    fuzzy.body.punch?.location.status === "low_accuracy" && fuzzy.body.punch.validation.initial === "pending_review"
    && noConsent.body.punch?.location.status === "unavailable" && noConsent.body.punch.flags.includes("no_consent") && noConsent.body.punch.location.distanceM === null && !coordLeak,
    [fuzzy.body.punch?.location, noConsent.body.punch, coordLeak]);

  // ---- Sin conexión ------------------------------------------------------------------------------------------------
  const declared = new Date(Date.now() - 5 * 60_000).toISOString();
  const off1 = await call("POST", `${AT(H)}/me/punch`, w2.token, punchBody(S1, "out", { method: "qr", qr: QR, offline: true, declaredAt: declared, location: INSIDE }));
  const future = await call("POST", `${AT(H)}/me/punch`, w2.token, punchBody(S1, "out", { method: "pin", pin: PIN, offline: true, declaredAt: new Date(Date.now() + 3_600_000).toISOString(), deviceNow: new Date(Date.now() + 3_600_000).toISOString() }));
  const offRow = (await q<{ declared_at: Date; server_received_at: Date; location_status: string }>(`SELECT declared_at, server_received_at, location_status FROM attendance_punches WHERE id=$1`, [off1.body.punch?.id])).rows[0];
  const replay = await call("POST", `${AT(H)}/me/punch`, w2.token, { ...punchBody(S1, "out", { method: "qr", qr: QR, offline: true, declaredAt: declared }), clientEventId: off1.body.punch ? (await q(`SELECT client_event_id FROM attendance_punches WHERE id=$1`, [off1.body.punch.id])).rows[0].client_event_id : randomUUID() });
  check("O1. Sin conexión: con código vigente y dentro, igual queda pendiente; hora declarada y hora del servidor por separado; la ubicación no se usa; repetir el envío no duplica",
    off1.status === 201 && off1.body.punch.origin === "offline" && off1.body.punch.validation.initial === "pending_review" && offRow.location_status === "unavailable"
    && Math.abs(new Date(offRow.declared_at).getTime() - new Date(declared).getTime()) < 1000 && offRow.server_received_at.getTime() > offRow.declared_at.getTime()
    && replay.status === 200 && replay.body.duplicate, [off1.body, replay.status]);
  check("O2. Sin conexión con hora en el futuro y reloj desfasado: se guarda con sus marcas (futuro, desfase), nunca validado",
    future.status === 201 && future.body.punch.flags.includes("declared_in_future") && future.body.punch.flags.includes("clock_skew") && future.body.punch.validation.initial === "pending_review", future.body);

  // ---- Códigos no vigentes, otro establecimiento, otro hogar, fuerza bruta ------------------------------------------------
  const otherLoc = (await call("POST", `${AT(H)}/establishments/${L2}/codes/print`, adminH.token, { weekStart: week })).body.print;
  const wrongLoc = await call("POST", `${AT(H)}/me/punch`, w3.token, punchBody(S2, "in", { method: "qr", qr: QR }));
  const goodL2 = await call("POST", `${AT(H)}/me/punch`, w3.token, punchBody(S2, "out", { method: "pin", pin: otherLoc.pin }));
  const attempt = (await q<{ outcome: string }>(`SELECT outcome FROM attendance_code_attempts WHERE user_id=$1 ORDER BY attempted_at LIMIT 1`, [w3.userId])).rows[0];
  check("K1. El QR de otro establecimiento no vale (intento «otro establecimiento»): se guarda como declaración pendiente, nunca validada",
    wrongLoc.status === 201 && wrongLoc.body.punch.code.status === "invalid" && wrongLoc.body.punch.flags.includes("code_invalid") && attempt?.outcome === "other_location"
    && wrongLoc.body.punch.validation.initial === "pending_review" && goodL2.body.punch?.code.status === "current", [wrongLoc.body, attempt, goodL2.body]);
  const crossHome = await call("POST", `${AT(H)}/me/punch`, w1.token, punchBody(SH2, "in", { method: "qr", qr: QR }));
  const tampered = QR.slice(0, -2) + (QR.endsWith("AA") ? "BB" : "AA");
  check("K2. Nadie poncha en un turno de otro hogar ni en uno sin asignación aceptada (403); un QR alterado es «incorrecto»",
    crossHome.status === 403 && (await call("POST", `${AT(H)}/me/punch`, w2.token, punchBody(SPEND, "in", { method: "pin", pin: PIN }))).status === 403
    && (await call("POST", `${AT(H)}/me/punch`, w3.token, punchBody(S2, "in", { method: "qr", qr: tampered }))).body.punch?.code.status === "invalid", crossHome);
  // Fuerza bruta con w3 (ya lleva 2 fallidos: otro establecimiento y QR alterado): al 5.º fallido, lo siguiente se bloquea.
  const guesses: number[] = [];
  for (let i = 0; i < 4; i++) guesses.push((await call("POST", `${AT(H)}/me/punch`, w3.token, punchBody(S2, "in", { method: "pin", pin: String(100000 + i) }))).status);
  const blockedOk = await call("POST", `${AT(H)}/me/punch`, w3.token, punchBody(S2, "in", { method: "pin", pin: otherLoc.pin }));
  const blockedAlert = (await q(`SELECT 1 FROM attendance_alerts WHERE kind='attempts_blocked' AND user_id=$1`, [w3.userId])).rows.length;
  check("K3. Fuerza bruta: tras 5 intentos fallidos en 15 minutos, el siguiente se bloquea (429) aunque el código sea correcto, se registra y alerta",
    guesses.join() === "200,200,200,429" && blockedOk.status === 429 && blockedOk.body.error === "ATTENDANCE_TOO_MANY_ATTEMPTS" && blockedAlert === 1
    && (await q(`SELECT 1 FROM attendance_code_attempts WHERE user_id=$1 AND outcome='blocked'`, [w3.userId])).rows.length === 2
    && (await q(`SELECT count(*)::int n FROM attendance_code_attempts WHERE user_id=$1 AND outcome NOT IN ('current','transition','blocked')`, [w3.userId])).rows[0].n === 5, { guesses, blockedOk });

  // ---- Revocación y transición ---------------------------------------------------------------------------------------
  const revoke = await call("POST", `${AT(H)}/establishments/${L}/codes/revoke`, adminH.token, { weekStart: week, reason: "QR fotografiado por terceros" });
  const oldQr = await call("POST", `${AT(H)}/me/punch`, w1.token, punchBody(S1, "in", { method: "qr", qr: QR, location: INSIDE }));
  const oldPin = await call("POST", `${AT(H)}/me/punch`, w1.token, punchBody(S1, "out", { method: "pin", pin: PIN, location: INSIDE }));
  const reprint = await call("POST", `${AT(H)}/establishments/${L}/codes/print`, adminH.token, { weekStart: week });
  const lastAttempt = (await q<{ outcome: string }>(`SELECT outcome FROM attendance_code_attempts WHERE user_id=$1 AND method='qr' ORDER BY attempted_at DESC LIMIT 1`, [w1.userId])).rows[0];
  check("R1. Revocar es inmediato: el QR y el código anteriores dejan de valer (intento «revocado»), se crea la versión 2 y la nueva impresión es otra",
    revoke.status === 200 && revoke.body.revocation.newVersion === 2 && oldQr.body.punch?.code.status === "invalid" && lastAttempt?.outcome === "revoked"
    && oldPin.body.punch?.code.status === "invalid" && reprint.body.print?.pin !== PIN && reprint.body.print?.code.version === 2, [revoke.body, oldQr.body.punch?.code, lastAttempt]);
  // Transición (en la base, con instantes simulados): código de la semana anterior en su ventana.
  const prevWeek = new Date(`${week}T12:00:00Z`); prevWeek.setUTCDate(prevWeek.getUTCDate() - 7);
  const pw = prevWeek.toISOString().slice(0, 10);
  await q(`INSERT INTO attendance_codes (organization_id, location_id, week_start, version, key_id, transition_hours, available_from, valid_from, valid_until)
    VALUES ($1,$2,$3,1,'k1',8, now(), now(), now() + interval '1 second')`, [H, L2, pw]);
  const winAt = async (iso: string) => {
    await rtClient.query("BEGIN");
    await rtClient.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [w3.userId, H]);
    const r = (await rtClient.query(`SELECT role FROM app_attendance_code_window($1, $2::timestamptz) ORDER BY role`, [L2, iso])).rows.map((x) => x.role).join(",");
    await rtClient.query("ROLLBACK"); return r;
  };
  const monday0 = new Date(`${week}T04:00:00Z`);
  const w2h = await winAt(new Date(monday0.getTime() + 2 * 3_600_000).toISOString()), w9h = await winAt(new Date(monday0.getTime() + 9 * 3_600_000).toISOString());
  await q(`UPDATE attendance_codes SET revoked_at=now(), revoked_by_user_id=$3, revoke_reason='prueba' WHERE location_id=$1 AND week_start=$2`, [L2, pw, adminH.userId]);
  const wRev = await winAt(new Date(monday0.getTime() + 2 * 3_600_000).toISOString());
  check("R2. Transición: a las 2 h del lunes el código anterior sigue (solo para cerrar), a las 9 h ya no; revocado no tiene transición (la revocación prevalece)",
    w2h === "current,transition" && w9h === "current" && wRev === "current", { w2h, w9h, wRev });

  // ---- Base de datos: falsificaciones con app_runtime directo ---------------------------------------------------------
  const err = async (s: string, p: unknown[], who: P, orgId = H) => {
    await rtClient.query("BEGIN");
    await rtClient.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [who.userId, orgId]);
    try { await rtClient.query(s, p); return "OK"; } catch (e) { return (e as Error).message; } finally { await rtClient.query("ROLLBACK"); }
  };
  const base1 = `INSERT INTO attendance_punches (organization_id, location_id, shift_id, organization_worker_membership_id, user_id, punch_type, client_event_id, origin, declared_at, effective_at, code_method, code_status, code_id, location_status, initial_validation, created_by_user_id)`;
  const codeId = (await q<{ id: string }>(`SELECT id FROM attendance_codes WHERE location_id=$1 AND week_start=$2 AND version=2`, [L, week])).rows[0].id;
  const f1 = await err(`${base1} VALUES ($1,$2,$3,$4,$5,'in',gen_random_uuid(),'offline',now(),now(),'qr','current',$6,'inside','validated',$5)`, [H, L, S1, w1.owm, w1.userId, codeId], w1);
  const f2 = await err(`${base1} VALUES ($1,$2,$3,$4,$5,'in',gen_random_uuid(),'online',NULL,now(),'qr','transition',$6,'inside','validated',$5)`, [H, L, S1, w1.owm, w1.userId, codeId], w1);
  const f3 = await err(`${base1} VALUES ($1,$2,$3,$4,$5,'in',gen_random_uuid(),'online',NULL,now(),'qr','current',$6,'inside','validated',$5)`, [H, L, S1, w2.owm, w2.userId, codeId], w1);
  const f4 = await err(`${base1} VALUES ($1,$2,$3,$4,$5,'in',gen_random_uuid(),'online',NULL,now(),'qr','current',$6,'inside','validated',$5)`, [H, L2, S2, w1.owm, w1.userId, codeId], w1);
  const f5 = await err(`UPDATE attendance_punches SET initial_validation='validated' WHERE id=$1`, [outIn.body.punch.id], adminH);
  const f6 = await err(`DELETE FROM attendance_punches WHERE id=$1`, [outIn.body.punch.id], adminH);
  const f7 = await err(`INSERT INTO attendance_punches (organization_id, location_id, shift_id, organization_worker_membership_id, user_id, punch_type, origin, declared_at, effective_at, code_method, code_status, location_status, initial_validation, manual_reason, created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,'in','manual',now(),now(),'none','none','unavailable','justified','me lo invento',$5)`, [H, L, S1, w1.owm, w1.userId], w1);
  const f8 = await err(`INSERT INTO attendance_alerts (organization_id, location_id, kind, alert_key) VALUES ($1,$2,'recidivism','x')`, [H, L], adminH);
  const f9 = await err(`UPDATE attendance_codes SET valid_until = valid_until + interval '30 days' WHERE id=$1`, [codeId], adminH);
  const f10 = await err(`SELECT * FROM attendance_codes`, [], w1);
  check("D1. Con app_runtime directo: sin conexión «validado», transición para entrar, ponche por otra persona, en otro establecimiento, editar o borrar un ponche, ponche manual del personal, alertas inventadas y alargar un código: todo rechazado",
    f1.includes("check constraint") && f2.includes("check constraint") && /ATTENDANCE_NOT_AUTHORIZED|row-level security/.test(f3) && /ATTENDANCE_SHIFT_MISMATCH|ATTENDANCE_NOT_AUTHORIZED/.test(f4)
    && /ATTENDANCE_IMMUTABLE|permission denied/.test(f5) && /ATTENDANCE_IMMUTABLE|permission denied/.test(f6) && /row-level security|ATTENDANCE_NOT_AUTHORIZED/.test(f7)
    && /permission denied|row-level security/.test(f8) && f9.includes("ATTENDANCE_IMMUTABLE") && f10 === "OK"
    && (await (async () => { await rtClient.query("BEGIN"); await rtClient.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [w1.userId, H]);
         const n = (await rtClient.query(`SELECT count(*)::int n FROM attendance_codes`)).rows[0].n; await rtClient.query("ROLLBACK"); return n === 0; })()),
    { f1, f2, f3, f4, f5, f6, f7, f8, f9 });

  // ---- Revisión, correcciones y ponches manuales ---------------------------------------------------------------------
  const ownIn = await call("POST", `${AT(H)}/me/punch`, adminH.token, punchBody(S1, "in", { method: "pin", pin: reprint.body.print.pin }));
  const selfReview = await call("POST", `${AT(H)}/punches/review`, adminH.token, { punchIds: [ownIn.body.punch.id], decision: "validated", reason: "Revisado" });
  const noReason = await call("POST", `${AT(H)}/punches/review`, adminH.token, { punchIds: [outIn.body.punch.id], decision: "validated" });
  const pendingIds = (await call("GET", `${AT(H)}/punches?status=pending_review&locationId=${L}`, adminH.token)).body.result.punches
    .filter((p: Json) => p.membershipId === w2.owm).map((p: Json) => p.id);
  const bulk = await call("POST", `${AT(H)}/punches/review`, adminH.token, { punchIds: pendingIds, decision: "justified", reason: "Verificado con la supervisora de turno" });
  const hist = await call("GET", `${AT(H)}/punches/${outIn.body.punch.id}`, adminH.token);
  const crossReview = await call("POST", `${AT(H2)}/punches/review`, adminH2.token, { punchIds: [p1.id], decision: "not_recognized", reason: "Intento cruzado" });
  const crossList = await call("GET", `${AT(H2)}/punches`, adminH2.token);
  check("V1. Revisión: nadie revisa sus propios ponches (403), el motivo es obligatorio, en bloque con auditoría; el original no cambia; otro hogar no ve ni revisa",
    selfReview.status === 403 && selfReview.body.error === "ATTENDANCE_SELF_REVIEW" && noReason.status === 400 && bulk.status === 200 && bulk.body.review.reviewed === pendingIds.length && pendingIds.length >= 4
    && hist.body.history.punch.validation.initial === "pending_review" && hist.body.history.punch.validation.effective === "justified" && hist.body.history.reviews.length === 1
    && crossReview.status === 404 && crossList.status === 200 && crossList.body.result.punches.length === 0, { selfReview, noReason, bulk: bulk.body, n: pendingIds.length, crossReview });
  const corr = await call("POST", `${AT(H)}/me/corrections`, w1.token, { shiftId: S1, punchId: be2.body.punch.id, type: "break_end", requestedAt: new Date(Date.now() - 60_000).toISOString(), reason: "Olvidé ponchar el fin del descanso" });
  const missing = await call("POST", `${AT(H)}/me/corrections`, w2.token, { shiftId: S1, type: "meal_start", requestedAt: new Date().toISOString(), reason: "Sin señal al ir a almorzar" });
  const foreignCorr = await call("POST", `${AT(H)}/me/corrections`, w1.token, { shiftId: S2, type: "in", requestedAt: new Date().toISOString(), reason: "No es mi turno" });
  const workerDecide = await call("POST", `${AT(H)}/corrections/${corr.body.correction.id}/decision`, w2.token, { approve: true, reason: "Aprobado" });
  const approve = await call("POST", `${AT(H)}/corrections/${corr.body.correction.id}/decision`, adminH.token, { approve: true, reason: "Confirmado con el registro de turno" });
  const twice = await call("POST", `${AT(H)}/corrections/${corr.body.correction.id}/decision`, adminH.token, { approve: false, reason: "Otra vez" });
  const reject = await call("POST", `${AT(H)}/corrections/${missing.body.correction.id}/decision`, adminH.token, { approve: false, reason: "No consta" });
  const manualRow = (await q<{ origin: string; initial_validation: string; created_by_user_id: string }>(`SELECT origin, initial_validation, created_by_user_id FROM attendance_punches WHERE id=$1`, [approve.body.correction?.resultingPunchId])).rows[0];
  const origEff = (await call("GET", `${AT(H)}/punches/${be2.body.punch.id}`, adminH.token)).body.history.punch.validation.effective;
  const myC = await call("GET", `${AT(H)}/me/corrections`, w2.token);
  check("V2. Correcciones: solo sobre turnos propios; el personal no decide; aprobar crea un ponche manual justificado y el original queda «no reconocido» (se conserva); se decide una sola vez",
    corr.status === 201 && foreignCorr.status === 403 && workerDecide.status === 403 && approve.status === 200 && manualRow?.origin === "manual" && manualRow.initial_validation === "justified"
    && manualRow.created_by_user_id === adminH.userId && origEff === "not_recognized" && twice.status === 409 && reject.body.correction?.status === "rejected"
    && myC.body.corrections.length === 1 && myC.body.corrections[0].status === "rejected", { corr: corr.status, foreignCorr: foreignCorr.status, workerDecide: workerDecide.status, approve: approve.body, twice: twice.status, origEff });
  const manual = await call("POST", `${AT(H)}/punches/manual`, adminH.token, { shiftId: S1, membershipId: w2.owm, type: "out", at: new Date().toISOString(), reason: "Caída del servicio: hoja de contingencia" });
  const manualSelf = await call("POST", `${AT(H)}/punches/manual`, adminH.token, { shiftId: S1, membershipId: adminH.owm, type: "out", at: new Date().toISOString(), reason: "Para mí" });
  const manualNoReason = await call("POST", `${AT(H)}/punches/manual`, adminH.token, { shiftId: S1, membershipId: w2.owm, type: "out", at: new Date().toISOString() });
  check("V3. Ponche manual de la administración: con motivo queda justificado; para sí misma 403; sin motivo 400",
    manual.status === 201 && manualSelf.status === 403 && manualNoReason.status === 400, [manual, manualSelf, manualNoReason]);

  // ---- Alertas: reincidencia, sesión de 16 h, marcar vistas ----------------------------------------------------------
  await call("PUT", `${AT(H)}/me/consent`, w1.token, { version: "geo-1", accept: true });
  for (let i = 0; i < 3; i++) {
    await call("POST", `${AT(H)}/me/punch`, w1.token, punchBody(S1, "in", { method: "pin", pin: reprint.body.print.pin, location: OUTSIDE }));
    await call("POST", `${AT(H)}/me/punch`, w1.token, punchBody(S1, "out", { method: "pin", pin: reprint.body.print.pin, location: OUTSIDE }));
  }
  const recid = (await q(`SELECT count(*)::int n FROM attendance_alerts WHERE kind='recidivism' AND user_id=$1`, [w1.userId])).rows[0].n;
  await call("POST", `${AT(H)}/me/punch`, w1.token, punchBody(S1, "in", { method: "pin", pin: reprint.body.print.pin, location: INSIDE }));
  const longNow = await runAttendanceJob(new Date(Date.now() + 17 * 3_600_000));
  const longAgain = await runAttendanceJob(new Date(Date.now() + 17 * 3_600_000));
  const alerts = await call("GET", `${AT(H)}/alerts`, adminH.token);
  const ack = await call("POST", `${AT(H)}/alerts/${alerts.body.alerts[0].id}/acknowledge`, adminH.token);
  const ack2 = await call("POST", `${AT(H)}/alerts/${alerts.body.alerts[0].id}/acknowledge`, adminH.token);
  const stillOpen = (await q<{ n: number }>(`SELECT count(*)::int n FROM attendance_punches WHERE user_id=$1 AND punch_type='out' AND origin='manual' AND shift_id=$2`, [w1.userId, S1])).rows[0].n;
  check("L1. Reincidencia con 3 fuera del perímetro en 7 días (una alerta por día, no es prueba de fraude); sesión abierta 16 h → alerta sin cierre automático; idempotente; marcar vista una vez",
    recid === 1 && longNow.longSessions >= 1 && longAgain.longSessions === 0 && alerts.body.alerts.some((a: Json) => a.kind === "long_session")
    && ack.status === 200 && ack2.status === 404 && stillOpen === 0, { recid, longNow, longAgain, kinds: alerts.body.alerts.map((a: Json) => a.kind) });

  // ---- Política y asistencia de la semana ----------------------------------------------------------------------------
  const pol = await call("PUT", `${AT(H)}/establishments/${L}/policy`, adminH.token, { transitionHours: 4, lateToleranceMinutes: 5, earlyLeaveToleranceMinutes: 5, absenceAfterMinutes: 30, reason: "Ajuste acordado con la dirección" });
  const polBad = await call("PUT", `${AT(H)}/establishments/${L}/policy`, adminH.token, { transitionHours: 13, lateToleranceMinutes: 5, earlyLeaveToleranceMinutes: 5, absenceAfterMinutes: 30, reason: "Fuera de rango" });
  const trans = (await q<{ transition_hours: number }>(`SELECT transition_hours FROM attendance_codes WHERE location_id=$1 AND week_start=$2 AND version=2`, [L, week])).rows[0].transition_hours;
  const wk = await call("GET", `${AT(H)}/establishments/${L}/weeks/${week}`, adminH.token);
  const w1row = wk.body.week?.rows.find((r: Json) => r.membershipId === w1.owm);
  const w3wk = await call("GET", `${AT(H)}/establishments/${L2}/weeks/${week}`, adminH.token);
  check("W1. Política versionada (0–12 h de transición) aplicada a los códigos en uso; tardanza de la semana como dato administrativo; minutos validados y pendientes por separado",
    pol.status === 200 && pol.body.policy.version === 1 && polBad.status === 400 && trans === 4 && wk.status === 200 && w1row && w1row.lateMinutes >= 25
    && typeof w1row.validatedMinutes === "number" && typeof w1row.pendingMinutes === "number" && w3wk.status === 200, { pol: pol.body, trans, w1row });

  // ---- Trabajo programado: idempotente y solo con el interruptor ----------------------------------------------------------
  // (Su primera ejecución fue en L1: creó los códigos que faltaban, entre ellos los del Hogar 2.)
  const before = (await q(`SELECT count(*)::int n FROM attendance_codes`)).rows[0].n;
  const h2Available = (await q(`SELECT count(*)::int n FROM attendance_codes WHERE location_id=$1 AND available_from <= now() + interval '17 hours' AND revoked_at IS NULL`, [LH2])).rows[0].n;
  const job1 = await runAttendanceJob(new Date());
  const job2 = await runAttendanceJob(new Date());
  const h3codes = (await q(`SELECT count(*)::int n FROM attendance_codes WHERE organization_id=$1`, [H3])).rows[0].n;
  const h2codes = (await q(`SELECT count(*)::int n FROM attendance_codes WHERE location_id=$1`, [LH2])).rows[0].n;
  // Una sola vez por código: tantos avisos como códigos ya disponibles (la ejecución de L1 simuló el viernes 00:00+).
  const avail = (await q(`SELECT count(DISTINCT related_entity_id)::int n FROM notifications WHERE user_id=$1 AND notification_type='ATTENDANCE_CODE_AVAILABLE'`, [adminH2.userId])).rows[0].n;
  const availTotal = (await q(`SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND notification_type='ATTENDANCE_CODE_AVAILABLE'`, [adminH2.userId])).rows[0].n;
  check("J1. El trabajo programado crea solo lo que falta (idempotente), nunca en hogares con el interruptor apagado, y avisa una sola vez de cada código disponible",
    longNow.created >= 2 && longAgain.created === 0 && job1.created === 0 && job2.created === 0 && h3codes === 0 && h2codes === 2
    && avail === h2Available && availTotal === avail && avail >= 1 && job1.notified === 0 && job2.notified === 0 && before >= 4, { longNow, job1, job2, h3codes, h2codes, avail, h2Available });

  // ---- Respuestas y no regresión ------------------------------------------------------------------------------------------
  const noStore = headers.filter((h, i) => bodies[i] && /"(punch|codes|print|result|history)"/.test(bodies[i])).every((h) => (h["cache-control"] ?? "").includes("no-store"));
  const qrLeak = bodies.filter((b) => b.includes(reprint.body.print.pin) && !b.includes('"print"')).length;
  check("Z1. Respuestas sin caché; el código vigente solo aparece en la respuesta de impresión", noStore && qrLeak === 0, { noStore, qrLeak });
  const recA = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Cliente','Ficticio') RETURNING id`, [A])).rows[0].id;
  const agencyShift = await call("POST", `/organizations/${A}/shifts`, adminA.token, { careRecipientId: recA, scheduledStart: new Date(Date.now() + 9 * 86_400_000).toISOString(), scheduledEnd: new Date(Date.now() + 9 * 86_400_000 + 3_600_000).toISOString() });
  check("Z2. Agencia sin cambios: crea y lista sus turnos como antes", agencyShift.status === 201 && (await call("GET", `/organizations/${A}/shifts`, adminA.token)).status === 200, agencyShift.status);
  check("Z3. Nunca un 500 en todo el recorrido", errors500.length === 0, errors500);
  // Reversión con datos de personas: se niega (y en orden: 175 → 174 → 173).
  const { readFileSync } = await import("node:fs");
  const tryRollback = async (n: string) => { try { await db.query(readFileSync(join(process.cwd(), "ops", n), "utf8")); return "OK"; } catch (e) { await db.query("ROLLBACK").catch(() => undefined); return (e as Error).message; } };
  const r175 = await tryRollback("175_residential_attendance_review.rollback.sql");
  const r174 = await tryRollback("174_residential_attendance_punches.rollback.sql");
  const r173 = await tryRollback("173_residential_attendance_codes.rollback.sql");
  const still = (await q(`SELECT count(*)::int n FROM schema_migrations WHERE filename LIKE '17_\\_residential_attendance%'`)).rows[0].n;
  check("Z4. Con registros de asistencia las reversiones se niegan (175 por sus datos; 174 y 173 porque la siguiente sigue aplicada) y no se borra nada",
    r175.includes("ROLLBACK_175_REFUSED") && r174.includes("ROLLBACK_174_REFUSED") && r173.includes("ROLLBACK_173_REFUSED") && still === 3, { r175, r174, r173, still });

  server.close(); await pool.end(); await rtClient.end(); await db.end();
  await srv.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await srv.end();
}

main().then(() => {
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 1500)}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 1500)}`}`); console.error(e); process.exit(1); });
