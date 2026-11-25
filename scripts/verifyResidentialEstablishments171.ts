/**
 * 171 · Hogares F1: establecimientos, unidades, habitaciones, camas, ubicación de residentes, geocerca y cierre.
 * Datos FICTICIOS, base PROPIA desechable, ningún correo real (Resend interceptado). App real por HTTP como app_runtime.
 * Cubre: piezas automáticas idempotentes, habitación técnica (sin residentes, protegida, invisible en respuestas y
 * conteos), autoridad de escritura (solo administración de hogares; sin DELETE), "General", camas y ocupación,
 * traslados con historial, geocerca auditada, cierre con sus bloqueos, aislamiento entre las tres modalidades y
 * entre hogares, no regresión de agencias, y nunca un 500.
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
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });

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

async function main() {
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  const dbName = `etnara_h171_${randomBytes(4).toString("hex")}`;
  await srv.query(`CREATE DATABASE ${dbName}`);
  const u = new URL(serverUrl!); u.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: u.toString() }); await db.connect();
  { const log = console.log; console.log = () => undefined; try { await applyPendingMigrations(db, join(process.cwd(), "migrations")); } finally { console.log = log; } }
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const suErr = async (s: string, p: unknown[] = []) => { try { await q(s, p); return "OK"; } catch (e) { return (e as Error).message; } };
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const ru = new URL(u.toString()); ru.username = "app_runtime"; ru.password = runtimePassword;
  process.env.DATABASE_URL = ru.toString();
  const rt = new pg.Client({ connectionString: ru.toString() }); await rt.connect();
  /** app_runtime con el contexto de una persona y organización, en una transacción que se deshace. */
  const asRt = async (userId: string, orgId: string, stmt: string, params: unknown[] = [], extra = "") => {
    try {
      await rt.query("BEGIN");
      await rt.query(`SELECT set_config('app.current_user_id', $1, true), set_config('app.current_org_id', $2, true), set_config('app.is_superadmin', 'false', true)`, [userId, orgId]);
      if (extra) await rt.query(extra);
      const r = await rt.query(stmt, params); await rt.query("ROLLBACK"); return `OK:${r.rowCount}`;
    } catch (e) { await rt.query("ROLLBACK").catch(() => undefined); return (e as Error).message; }
  };

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toLowerCase();
  const errors500: string[] = [];
  const bodies: string[] = []; // todas las respuestas, para buscar fugas de las piezas técnicas
  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await realFetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); bodies.push(text);
    let json: Json = {}; try { json = JSON.parse(text); } catch { /* vacío */ }
    if (res.status >= 500) errors500.push(`${method} ${path} ${res.status} ${text.slice(0, 120)}`);
    return { status: res.status, body: json };
  }
  const org = async (name: string, type: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2,'active') RETURNING id`, [name, type])).rows[0].id;
  const user = async (key: string) => { const email = `h171-${key}-${tag}@example.invalid`;
    return { email, id: (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id }; };
  const member = async (x: { id: string }, o: string, roles: string[]) => { const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [x.id, o])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, o, roles]); return m; };
  const login = async (x: { email: string }, o?: string) => { const t = (await call("POST", "/auth/login", "", { email: x.email, password })).body.token as string; if (o) await call("POST", "/me/active-organization", t, { organizationId: o }); return t; };

  const A = await org(`Agencia Ficticia ${tag}`, "HOME_CARE_AGENCY"), H = await org(`Hogar Ficticio ${tag}`, "RESIDENTIAL_CARE_HOME"), H2 = await org(`Otro Hogar ${tag}`, "RESIDENTIAL_CARE_HOME");
  await q(`UPDATE platform_modalities SET enabled=true WHERE code='INDEPENDENT_PROVIDER'`);
  const I = await org(`Independiente Ficticia ${tag}`, "INDEPENDENT_PROVIDER");
  await q(`UPDATE platform_modalities SET enabled=false WHERE code='INDEPENDENT_PROVIDER'`);
  const adminA = await user("admin-agencia"); await member(adminA, A, ["ORGANIZATION_ADMIN"]);
  const adminH = await user("admin-hogar"); await member(adminH, H, ["ORGANIZATION_ADMIN"]);
  const supH = await user("supervisora-hogar"); await member(supH, H, ["SUPERVISOR"]);
  const wrkH = await user("cuidadora-hogar"); await member(wrkH, H, ["WORKER"]);
  const famH = await user("familiar-hogar"); await member(famH, H, ["FAMILY_MEMBER"]);
  const adminH2 = await user("admin-otro-hogar"); await member(adminH2, H2, ["ORGANIZATION_ADMIN"]);
  const adminI = await user("independiente"); await member(adminI, I, ["ORGANIZATION_ADMIN"]);
  const central = await user("central"); await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.id]);
  const tA = await login(adminA, A), tH = await login(adminH, H), tS = await login(supH, H), tW = await login(wrkH, H), tF = await login(famH, H), tH2 = await login(adminH2, H2), tI = await login(adminI, I), tC = await login(central);
  const R = `/organizations/${H}/residential`;

  // ---- Piezas automáticas ----------------------------------------------------------------------------------------
  const e1 = await call("POST", `/organizations/${H}/establishments`, tH, { name: "Hogar Ficticio · Sede Norte", address: "Calle Ficticia 1" });
  const e2 = await call("POST", `/organizations/${H}/establishments`, tH, { name: "Hogar Ficticio · Sede Sur" });
  const eA = await call("POST", `/organizations/${A}/establishments`, tA, { name: "Agencia · Oficina" });
  const eX = await call("POST", `/organizations/${H2}/establishments`, tH2, { name: "Otro Hogar · Sede" });
  const E1 = e1.body.establishment?.id as string, E2 = e2.body.establishment?.id as string, EA = eA.body.establishment?.id as string, EX = eX.body.establishment?.id as string;
  const pieces = async (loc: string) => (await q<{ general: number; tech: number; settings: number; units: number; rooms: number; radius: number | null }>(`SELECT
    (SELECT count(*)::int FROM establishment_general_units WHERE location_id=$1) general,
    (SELECT count(*)::int FROM establishment_technical_rooms WHERE location_id=$1) tech,
    (SELECT count(*)::int FROM establishment_settings WHERE location_id=$1) settings,
    (SELECT count(*)::int FROM units WHERE location_id=$1) units,
    (SELECT count(*)::int FROM rooms r JOIN units u ON u.id=r.unit_id WHERE u.location_id=$1) rooms,
    (SELECT geofence_radius_m FROM establishment_settings WHERE location_id=$1) radius`, [loc])).rows[0];
  const p1 = await pieces(E1), pA = await pieces(EA);
  check("A1. Crear un establecimiento de hogar crea «General», la unidad y la habitación técnicas y la geocerca de 100 m",
    e1.status === 201 && p1.general === 1 && p1.tech === 1 && p1.settings === 1 && p1.units === 2 && p1.rooms === 1 && p1.radius === 100, [e1.status, p1]);
  check("A2. En una agencia no se crea nada (sin unidades, habitaciones ni configuración)", eA.status === 201 && pA.general === 0 && pA.tech === 0 && pA.settings === 0 && pA.units === 0, pA);
  await q(`SELECT app_residential_ensure_establishment($1)`, [E1]); await q(`SELECT app_residential_ensure_establishment($1)`, [E1]);
  await q(`SELECT app_residential_ensure_establishment(l.id) FROM locations l JOIN organizations o ON o.id=l.organization_id WHERE o.organization_type='RESIDENTIAL_CARE_HOME' AND l.archived_at IS NULL`);
  const p1b = await pieces(E1);
  check("A3. Repetir la creación y el relleno deja una sola «General» y una sola habitación técnica", JSON.stringify(p1b) === JSON.stringify(p1), p1b);
  const tech = (await q<{ unit_id: string; room_id: string }>(`SELECT unit_id, room_id FROM establishment_technical_rooms WHERE location_id=$1`, [E1])).rows[0];
  const tech2 = (await q<{ unit_id: string; room_id: string }>(`SELECT unit_id, room_id FROM establishment_technical_rooms WHERE location_id=$1`, [E2])).rows[0];
  const general1 = (await q<{ unit_id: string }>(`SELECT unit_id FROM establishment_general_units WHERE location_id=$1`, [E1])).rows[0].unit_id;
  const secret = [tech.unit_id, tech.room_id, tech2.unit_id, tech2.room_id, "__etnara_technical__"];
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  check("A4. Las piezas automáticas tienen identificadores UUID válidos y estables (la API acepta «General»)", [general1, tech.unit_id, tech.room_id].every((x) => v4.test(x)), [general1, tech.unit_id, tech.room_id]);

  // ---- Residentes ficticios -----------------------------------------------------------------------------------------
  const res = async (loc: string, first: string) => (await call("POST", `/organizations/${H}/establishments/${loc}/residents/manage`, tH, { firstName: first, lastName: "Ficticio" })).body.resident?.id as string;
  const r1 = await res(E1, "Ana"), r2 = await res(E1, "Berta"), r3 = await res(E1, "Carmen");

  // ---- Base de datos: habitación técnica --------------------------------------------------------------------------
  const techRes = await asRt(adminH.id, H, `UPDATE care_recipients SET room_id=$1 WHERE id=$2`, [tech.room_id, r1]);
  const techResSu = await suErr(`UPDATE care_recipients SET room_id=$1 WHERE id=$2`, [tech.room_id, r1]);
  check("T1. La habitación técnica nunca tiene residentes: falla con app_runtime y también como propietario", techRes.includes("RESIDENTIAL_TECHNICAL_ROOM_NO_RESIDENTS") && techResSu.includes("RESIDENTIAL_TECHNICAL_ROOM_NO_RESIDENTS"), [techRes, techResSu]);
  const prot = [
    await asRt(adminH.id, H, `UPDATE rooms SET name='Renombrada' WHERE id=$1`, [tech.room_id]),
    await asRt(adminH.id, H, `UPDATE rooms SET archived_at=now() WHERE id=$1`, [tech.room_id]),
    await asRt(adminH.id, H, `UPDATE rooms SET unit_id=$1 WHERE id=$2`, [general1, tech.room_id]),
    await asRt(adminH.id, H, `UPDATE units SET name='Renombrada' WHERE id=$1`, [tech.unit_id]),
    await asRt(adminH.id, H, `UPDATE units SET archived_at=now() WHERE id=$1`, [tech.unit_id]),
    await asRt(adminH.id, H, `INSERT INTO rooms (unit_id, organization_id, name) VALUES ($1,$2,'Colada')`, [tech.unit_id, H]),
  ];
  check("T2. Editar, archivar, trasladar o añadir habitaciones a las piezas técnicas falla en la base de datos", prot.every((e) => e.includes("RESIDENTIAL_TECHNICAL_PROTECTED")), prot);
  const forged = await asRt(adminH.id, H, `UPDATE rooms SET name='X' WHERE id=$1`, [tech.room_id], `SELECT set_config('app.residential_procedure','on',true)`);
  check("T3. app_runtime no puede hacerse pasar por el procedimiento de cierre (marca forjada)", forged.includes("RESIDENTIAL_TECHNICAL_PROTECTED"), forged);
  const del = [await asRt(adminH.id, H, `DELETE FROM rooms WHERE id=$1`, [tech.room_id]), await asRt(adminH.id, H, `DELETE FROM units WHERE id=$1`, [general1])];
  check("T4. app_runtime no borra unidades ni habitaciones (sin DELETE)", del.every((e) => e.includes("permission denied")), del);
  const techReg = [await suErr(`UPDATE establishment_technical_rooms SET created_at=now() WHERE location_id=$1`, [E1]), await suErr(`DELETE FROM establishment_general_units WHERE location_id=$1`, [E1])];
  check("T5. Los registros técnico y de «General» no se modifican ni borran (también como propietario)", techReg.every((e) => e.includes("RESIDENTIAL_HISTORY_APPEND_ONLY")), techReg);

  // ---- Autoridad de escritura -----------------------------------------------------------------------------------------
  const aIns = await asRt(adminA.id, A, `INSERT INTO units (location_id, organization_id, name) VALUES ($1,$2,'Unidad agencia')`, [EA, A]);
  const wIns = await asRt(wrkH.id, H, `INSERT INTO rooms (unit_id, organization_id, name) VALUES ($1,$2,'Hab cuidadora')`, [general1, H]);
  const fIns = await asRt(famH.id, H, `UPDATE units SET name='Familia' WHERE id=$1`, [general1]);
  const xIns = await asRt(adminH2.id, H2, `UPDATE rooms SET name='Ajena' WHERE id=$1`, [tech.room_id]);
  check("W1. Agencia: ni su administración escribe en units (RLS); antes cualquier miembro podía", aIns.includes("row-level security"), aIns);
  check("W2. Hogar: cuidadora y familiar no escriben; otro hogar no ve ni toca las filas", wIns.includes("row-level security") && fIns === "OK:0" && xIns === "OK:0", [wIns, fIns, xIns]);
  const sIns = await asRt(supH.id, H, `INSERT INTO units (location_id, organization_id, name) VALUES ($1,$2,'Unidad supervisora')`, [E1, H]);
  check("W3. Hogar: la supervisora (administración) sí escribe", sIns === "OK:1", sIns);

  // ---- API: estructura ---------------------------------------------------------------------------------------------
  const list = await call("GET", `${R}/establishments`, tH);
  const l1 = (list.body.establishments ?? []).find((e: Json) => e.id === E1);
  check("B1. Lista: los dos establecimientos, ocupación «Sin configurar» (sin camas registradas)", list.status === 200 && list.body.establishments?.length === 2 && l1?.occupancy?.capacityConfigured === false && l1?.occupancy?.occupancyPercent === null && l1?.occupancy?.rooms === 0, list.body);
  const nu = await call("POST", `${R}/establishments/${E1}/units`, tH, { name: "Ala Norte" });
  const dupU = await call("POST", `${R}/establishments/${E1}/units`, tH, { name: "ala norte" });
  const resv = await call("POST", `${R}/establishments/${E1}/units`, tH, { name: "__etnara_x" });
  check("B2. Unidad adicional opcional; nombre repetido 409; nombre reservado 400", nu.status === 201 && dupU.status === 409 && dupU.body.error === "RESIDENTIAL_NAME_TAKEN" && resv.status === 400, [nu.status, dupU.body, resv.status]);
  const UN = nu.body.unit?.id as string;
  const rg = await call("POST", `${R}/establishments/${E1}/rooms`, tH, { name: "101" });
  const rn = await call("POST", `${R}/establishments/${E1}/rooms`, tH, { name: "201", unitId: UN, bedCapacity: 2 });
  const rdup = await call("POST", `${R}/establishments/${E1}/rooms`, tH, { name: "101", unitId: UN });
  const rS = await call("POST", `${R}/establishments/${E2}/rooms`, tH, { name: "S-1", bedCapacity: 1 });
  check("B3. Habitaciones: directas en «General» o en una unidad; nombre repetido en el establecimiento 409",
    rg.status === 201 && rg.body.room?.unitId === general1 && rn.status === 201 && rdup.status === 409 && rS.status === 201, [rg.status, rn.status, rdup.body, rS.status]);
  const RG = rg.body.room?.id as string, RN = rn.body.room?.id as string, RS = rS.body.room?.id as string;
  const intoTech = await call("POST", `${R}/establishments/${E1}/rooms`, tH, { name: "Colada", unitId: tech.unit_id });
  const otherUnit = await call("POST", `${R}/establishments/${E2}/rooms`, tH, { name: "Cruzada", unitId: UN });
  check("B4. No se crean habitaciones en la unidad técnica ni en una unidad de otro establecimiento (404)", intoTech.status === 404 && otherUnit.status === 404, [intoTech.status, otherUnit.status]);

  // ---- Camas, ocupación y ubicación ----------------------------------------------------------------------------------
  const pl = async (rid: string, body: Json, t = tH) => call("PUT", `${R}/residents/${rid}/placement`, t, body);
  const a1 = await pl(r1, { roomId: RN, reason: "Ingreso" }), a2 = await pl(r2, { roomId: RN }), a3 = await pl(r3, { roomId: RN, reason: "Temporal" });
  check("C1. Superar las camas advierte y no bloquea (tercer residente en una habitación de 2)", a1.status === 200 && a2.status === 200 && a3.status === 200 && a2.body.placement?.overCapacity === false && a3.body.placement?.overCapacity === true, [a1.status, a2.body, a3.body]);
  const d1 = await call("GET", `${R}/establishments/${E1}`, tH);
  const occ = d1.body.establishment?.occupancy ?? {};
  check("C2. Ocupación cuadra: 1 habitación con camas (2), 3 ocupadas, 0 disponibles, 150 %, con advertencia",
    d1.status === 200 && occ.rooms === 2 && occ.bedsRegistered === 2 && occ.bedsOccupied === 3 && occ.bedsAvailable === 0 && occ.occupancyPercent === 150 && occ.overCapacity === true && occ.activeResidents === 3 && occ.residentsWithoutRoom === 0, occ);
  const units = d1.body.establishment?.units ?? [];
  check("C3. Detalle: «General» primero y marcada; sin unidad ni habitación técnicas", units[0]?.isGeneral === true && units[0]?.name === "General" && !units.some((x: Json) => x.id === tech.unit_id), units.map((x: Json) => x.name));
  const tr = await pl(r1, { roomId: RS, reason: "Traslado a Sede Sur" });
  const hist = await call("GET", `${R}/residents/${r1}/placement-history`, tH);
  const loc1 = (await q<{ location_id: string; room_id: string }>(`SELECT location_id, room_id FROM care_recipients WHERE id=$1`, [r1])).rows[0];
  check("C4. Traslado entre establecimientos: cambia establecimiento y habitación en una sola operación",
    tr.status === 200 && loc1.location_id === E2 && loc1.room_id === RS && tr.body.placement?.establishmentId === E2, [tr.body, loc1]);
  const h = hist.body.history ?? [];
  check("C5. Historial con autor, motivo y origen/destino (2 movimientos, el más reciente primero)",
    hist.status === 200 && h.length === 2 && h[0].reason === "Traslado a Sede Sur" && h[0].fromRoom === "201" && h[0].toRoom === "S-1" && h[0].toEstablishment === "Hogar Ficticio · Sede Sur" && h[0].actorEmail === adminH.email && h[1].reason === "Ingreso", h);
  const histForge = [await suErr(`UPDATE care_recipient_room_events SET reason='x' WHERE care_recipient_id=$1`, [r1]), await asRt(adminH.id, H, `INSERT INTO care_recipient_room_events (organization_id, care_recipient_id) VALUES ($1,$2)`, [H, r1])];
  check("C6. El historial es solo de anexos y la aplicación no puede escribirlo", histForge[0].includes("RESIDENTIAL_HISTORY_APPEND_ONLY") && histForge[1].includes("permission denied"), histForge);
  const toTech = await pl(r2, { roomId: tech.room_id }), toOther = await pl(r2, { roomId: (await q<{ room_id: string }>(`SELECT room_id FROM establishment_technical_rooms WHERE location_id=$1`, [EX])).rows[0].room_id });
  const mismatch = await asRt(adminH.id, H, `UPDATE care_recipients SET room_id=$1 WHERE id=$2`, [RS, r2]);
  check("C7. Ubicar en la habitación técnica o en una de otro hogar: 404; habitación de otro establecimiento sin trasladar: rechazada en la base",
    toTech.status === 404 && toOther.status === 404 && mismatch.includes("RESIDENTIAL_ROOM_LOCATION_MISMATCH"), [toTech.status, toOther.status, mismatch]);

  // ---- Reglas de archivo -----------------------------------------------------------------------------------------------
  const archRoom = await call("PATCH", `${R}/rooms/${RN}`, tH, { archived: true });
  const archGen = await call("PATCH", `${R}/units/${general1}`, tH, { archived: true });
  const renGen = await call("PATCH", `${R}/units/${general1}`, tH, { name: "Planta baja" });
  const moveRoom = await call("PATCH", `${R}/rooms/${RG}`, tH, { unitId: (await q<{ unit_id: string }>(`SELECT unit_id FROM establishment_general_units WHERE location_id=$1`, [E2])).rows[0].unit_id });
  const emptyUnit = await call("POST", `${R}/establishments/${E1}/units`, tH, { name: "Ala vacía" });
  const archEmpty = await call("PATCH", `${R}/units/${emptyUnit.body.unit?.id}`, tH, { archived: true });
  const cap = await call("PATCH", `${R}/rooms/${RG}`, tH, { bedCapacity: 3 }), capOff = await call("PATCH", `${R}/rooms/${RG}`, tH, { bedCapacity: null });
  check("D1. Habitación con residentes no se archiva; «General» con habitaciones activas no se archiva pero sí se renombra",
    archRoom.status === 409 && archRoom.body.error === "RESIDENTIAL_ROOM_HAS_RESIDENTS" && archGen.status === 409 && archGen.body.error === "RESIDENTIAL_UNIT_HAS_ACTIVE_ROOMS" && renGen.status === 200 && renGen.body.unit?.name === "Planta baja",
    [archRoom.body, archGen.body, renGen.status]);
  check("D2. Una habitación no cambia de establecimiento; una unidad vacía sí se archiva; las camas se registran y se retiran",
    moveRoom.status === 409 && moveRoom.body.error === "RESIDENTIAL_ROOM_LOCATION_IMMUTABLE" && archEmpty.status === 200 && cap.body.room?.bedCapacity === 3 && capOff.body.room?.bedCapacity === null,
    [moveRoom.body, archEmpty.status, cap.body, capOff.body]);
  const techProfile = await asRt(adminH.id, H, `INSERT INTO room_profiles (room_id, organization_id, bed_capacity) VALUES ($1,$2,4)`, [tech.room_id, H]);
  check("D3. La habitación técnica no admite camas (no cuenta como capacidad)", techProfile.includes("RESIDENTIAL_TECHNICAL_PROTECTED"), techProfile);

  // ---- Geocerca --------------------------------------------------------------------------------------------------------
  const g40 = await call("PUT", `${R}/establishments/${E1}/geofence`, tH, { radiusMeters: 40, reason: "Prueba" });
  const g400 = await call("PUT", `${R}/establishments/${E1}/geofence`, tH, { radiusMeters: 400, reason: "Prueba" });
  const gNo = await call("PUT", `${R}/establishments/${E1}/geofence`, tH, { radiusMeters: 150 });
  const gHalf = await call("PUT", `${R}/establishments/${E1}/geofence`, tH, { radiusMeters: 150, latitude: 18.4, reason: "Prueba" });
  const gOk = await call("PUT", `${R}/establishments/${E1}/geofence`, tH, { radiusMeters: 150, latitude: 18.465539, longitude: -66.105735, reason: "Edificio principal" });
  const gDirect = await asRt(adminH.id, H, `UPDATE establishment_settings SET geofence_radius_m=200 WHERE location_id=$1`, [E1]);
  const gH = await call("GET", `${R}/establishments/${E1}/geofence-history`, tH);
  check("G1. Radio fuera de 50–300 m, sin motivo o con centro incompleto: 400", g40.status === 400 && g400.status === 400 && gNo.status === 400 && gHalf.status === 400, [g40.status, g400.status, gNo.status, gHalf.status]);
  check("G2. Cambio válido de geocerca guardado y auditado (autor, motivo, radio anterior y nuevo)",
    gOk.status === 200 && gOk.body.geofence?.radiusMeters === 150 && gH.body.history?.length === 1 && gH.body.history[0].oldRadiusMeters === 100 && gH.body.history[0].newRadiusMeters === 150 && gH.body.history[0].centerChanged === true && gH.body.history[0].actorEmail === adminH.email, [gOk.body, gH.body]);
  check("G3. En la base, cambiar la geocerca sin motivo se rechaza (también directamente con app_runtime)", gDirect.includes("RESIDENTIAL_REASON_REQUIRED"), gDirect);

  // ---- Cierre del establecimiento --------------------------------------------------------------------------------------
  const ck1 = await call("GET", `${R}/establishments/${E2}/closure-check`, tH);
  const cl1 = await call("POST", `${R}/establishments/${E2}/close`, tH, { reason: "Cierre de la sede" });
  check("K1. Con residentes activos el cierre se rechaza (y la comprobación lo anticipa)", ck1.body.closure?.canClose === false && ck1.body.closure?.activeResidents === 1 && cl1.status === 409 && cl1.body.error === "RESIDENTIAL_CLOSURE_ACTIVE_RESIDENTS", [ck1.body, cl1.body]);
  await pl(r1, { roomId: null, establishmentId: E1, reason: "Regreso a Sede Norte" });
  const future = new Date(Date.now() + 86400000).toISOString(), futureEnd = new Date(Date.now() + 90000000).toISOString();
  const sh = (await q<{ id: string }>(`INSERT INTO shifts (organization_id, room_id, scheduled_start, scheduled_end) VALUES ($1,$2,$3,$4) RETURNING id`, [H, tech2.room_id, future, futureEnd])).rows[0].id;
  const cl2 = await call("POST", `${R}/establishments/${E2}/close`, tH, { reason: "Cierre de la sede" });
  check("K2. Con un turno futuro del establecimiento (sobre su habitación técnica) el cierre se rechaza", cl2.status === 409 && cl2.body.error === "RESIDENTIAL_CLOSURE_FUTURE_SHIFTS", cl2.body);
  await q(`UPDATE shifts SET status='cancelled' WHERE id=$1`, [sh]);
  const archDirect = await call("PATCH", `/organizations/${H}/establishments/${E2}`, tH, { status: "archived" });
  check("K3. Archivar un establecimiento de hogar por la vía ordinaria se rechaza: exige el procedimiento de cierre", archDirect.status === 409 && archDirect.body.error === "RESIDENTIAL_CLOSURE_REQUIRED", archDirect.body);
  const clNoReason = await call("POST", `${R}/establishments/${E2}/close`, tH, {});
  const clW = await call("POST", `${R}/establishments/${E2}/close`, tW, { reason: "Intento" });
  const cl3 = await call("POST", `${R}/establishments/${E2}/close`, tH, { reason: "Cierre de la sede" });
  const after = (await q<{ loc: string | null; open_rooms: number; open_units: number; tech_archived: boolean; closures: number }>(`SELECT
    (SELECT archived_at::text FROM locations WHERE id=$1) loc,
    (SELECT count(*)::int FROM rooms r JOIN units u ON u.id=r.unit_id WHERE u.location_id=$1 AND r.archived_at IS NULL) open_rooms,
    (SELECT count(*)::int FROM units WHERE location_id=$1 AND archived_at IS NULL) open_units,
    (SELECT r.archived_at IS NOT NULL FROM rooms r WHERE r.id=$2) tech_archived,
    (SELECT count(*)::int FROM establishment_closures WHERE location_id=$1) closures`, [E2, tech2.room_id])).rows[0];
  const kept = (await q<{ n: number }>(`SELECT count(*)::int n FROM rooms r JOIN units u ON u.id=r.unit_id WHERE u.location_id=$1`, [E2])).rows[0].n;
  check("K4. Sin motivo 400; la cuidadora no cierra (403); sin bloqueos se cierra: archiva todo (también lo técnico) sin borrar y lo registra",
    clNoReason.status === 400 && clW.status === 403 && cl3.status === 200 && cl3.body.closure?.closed === true && cl3.body.closure?.roomsArchived === 1 && after.loc !== null && after.open_rooms === 0 && after.open_units === 0 && after.tech_archived === true && after.closures === 1 && kept === 2,
    [clNoReason.status, clW.status, cl3.body, after, kept]);
  const postRoom = await call("POST", `${R}/establishments/${E2}/rooms`, tH, { name: "Nueva" });
  const postGeo = await call("PUT", `${R}/establishments/${E2}/geofence`, tH, { radiusMeters: 120, reason: "Tras el cierre" });
  const reopen = await call("PATCH", `/organizations/${H}/establishments/${E2}`, tH, { status: "active" });
  const reclose = await call("POST", `${R}/establishments/${E2}/close`, tH, { reason: "Otra vez" });
  const placeClosed = await pl(r2, { roomId: null, establishmentId: E2 });
  check("K5. Cerrado: no admite habitaciones, geocerca, reapertura ordinaria, segundo cierre ni residentes",
    postRoom.status === 409 && postGeo.status === 409 && reopen.status === 409 && reopen.body.error === "RESIDENTIAL_CLOSURE_REQUIRED" && reclose.status === 409 && placeClosed.status === 409,
    [postRoom.body, postGeo.body, reopen.body, reclose.body, placeClosed.body]);
  const closureForge = await suErr(`DELETE FROM establishment_closures WHERE location_id=$1`, [E2]);
  check("K6. El registro de cierre es solo de anexos", closureForge.includes("RESIDENTIAL_HISTORY_APPEND_ONLY"), closureForge);

  // ---- Permisos y aislamiento -------------------------------------------------------------------------------------------
  const sList = await call("GET", `${R}/establishments`, tS), wList = await call("GET", `${R}/establishments`, tW), fList = await call("GET", `${R}/establishments`, tF);
  check("P1. Supervisora 200; cuidadora y familiar 403 RESIDENTIAL_MANAGER_REQUIRED", sList.status === 200 && wList.status === 403 && wList.body.error === "RESIDENTIAL_MANAGER_REQUIRED" && fList.status === 403, [sList.status, wList.body, fList.status]);
  const aOwn = await call("GET", `/organizations/${A}/residential/establishments`, tA), iOwn = await call("GET", `/organizations/${I}/residential/establishments`, tI);
  check("P2. Agencia e independiente: las rutas de F1 responden 403 MODALITY_NOT_AVAILABLE", aOwn.status === 403 && aOwn.body.error === "MODALITY_NOT_AVAILABLE" && iOwn.status === 403 && iOwn.body.error === "MODALITY_NOT_AVAILABLE", [aOwn.body, iOwn.body]);
  const aOnH = await call("GET", `${R}/establishments`, tA), h2OnH = await call("GET", `${R}/establishments/${E1}`, tH2);
  check("P3. Quien no es miembro del hogar recibe el 403 de pertenencia (agencia u otro hogar)", aOnH.status === 403 && aOnH.body.error !== "MODALITY_NOT_AVAILABLE" && h2OnH.status === 403 && h2OnH.body.error !== "MODALITY_NOT_AVAILABLE", [aOnH.body, h2OnH.body]);
  const h2Own = [await call("PATCH", `/organizations/${H2}/residential/rooms/${RN}`, tH2, { name: "Robada" }), await call("GET", `/organizations/${H2}/residential/establishments/${E1}`, tH2), await call("PUT", `/organizations/${H2}/residential/residents/${r2}/placement`, tH2, { roomId: null })];
  check("P4. Otro hogar con ids de este hogar por su propia ruta: 404, sin cambios", h2Own.every((r) => r.status === 404) && (await q<{ name: string }>(`SELECT name FROM rooms WHERE id=$1`, [RN])).rows[0].name === "201", h2Own.map((r) => r.status));

  // ---- Piezas técnicas invisibles ------------------------------------------------------------------------------------------
  await call("GET", `/organizations/${H}/establishments`, tH);
  await call("GET", `/organizations/${H}/establishments/${E1}/workspace`, tH);
  const plat = await call("GET", `/platform/organizations/${H}/establishments/${E1}`, tC);
  await call("GET", `/me`, tH);
  await call("GET", `${R}/overview`, tH);
  await call("GET", `${R}/establishments`, tH); await call("GET", `${R}/establishments/${E1}`, tH); await call("GET", `${R}/establishments/${E2}`, tH);
  const leaks = bodies.filter((b) => secret.some((s) => b.includes(s)));
  check("V1. Ninguna respuesta (hogar, establecimientos, espacio de trabajo, Central, /me, panel) contiene la unidad, la habitación ni el nombre técnicos", leaks.length === 0 && bodies.length > 80, `${leaks.length} de ${bodies.length}: ${leaks[0]?.slice(0, 160) ?? ""}`);
  const pe = plat.body.establishment ?? {};
  check("V2. Central: los conteos excluyen las piezas técnicas (2 unidades visibles activas, 2 habitaciones)", plat.status === 200 && pe.units_count === 2 && pe.rooms_count === 2, [plat.status, pe.units_count, pe.rooms_count]);

  // ---- No regresión de agencias -----------------------------------------------------------------------------------------------
  const aArch = await call("PATCH", `/organizations/${A}/establishments/${EA}`, tA, { status: "archived" });
  const aReopen = await call("PATCH", `/organizations/${A}/establishments/${EA}`, tA, { status: "active" });
  const aWs = await call("GET", `/organizations/${A}/establishments/${EA}/workspace`, tA);
  const aRes = await call("POST", `/organizations/${A}/establishments/${EA}/residents/manage`, tA, { firstName: "Luis", lastName: "Agencia" });
  check("N1. Agencia: crear, archivar, reabrir y su espacio de trabajo funcionan igual; sus residentes sin cambios", aArch.status === 200 && aReopen.status === 200 && aWs.status === 200 && aRes.status === 201, [aArch.status, aReopen.status, aWs.status, aRes.status]);
  const aRoomFree = await suErr(`UPDATE care_recipients SET room_id=NULL WHERE id=$1`, [aRes.body.resident?.id]);
  check("N2. Agencia: las guardas de hogar no intervienen en sus residentes", aRoomFree === "OK", aRoomFree);
  const { readFileSync } = await import("node:fs");
  const rb = await suErr(readFileSync(join(process.cwd(), "ops/171_residential_establishments_rooms.rollback.sql"), "utf8"));
  await q("ROLLBACK").catch(() => undefined);
  const stillThere = (await q<{ ok: boolean }>(`SELECT to_regclass('public.establishment_technical_rooms') IS NOT NULL AS ok`)).rows[0].ok;
  check("R1. Con datos de hogar (habitaciones, camas, historial, cierres) la reversión se niega y no deja nada a medias", rb.includes("ROLLBACK_171_REFUSED") && stillThere, rb);
  check("Z1. Nunca un 500 en todo el recorrido", errors500.length === 0, errors500);

  server.close(); await pool.end(); await rt.end(); await db.end();
  await srv.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await srv.end();
}

main().then(() => {
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 900)}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
