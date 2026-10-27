/**
 * Caregiver access window (migration 132, auditoría B4, 27-oct-2026).
 *
 * Proves over real HTTP, with the app connected in the mode given by
 * AUTHZ_DB_MODE (superuser = production today, RLS bypassed; app_runtime = RLS):
 *
 * MENSAJERÍA
 *   - a caregiver starts / reads / writes the conversation about a resident only with an
 *     ACCEPTED assignment on a confirmed, in-progress or completed shift with THAT
 *     resident, until 24 h after that shift ended (her check-out, else the scheduled end);
 *   - pending, rejected and cancelled assignments never grant access;
 *   - after the window she loses the whole conversation (list, history, writing, notices);
 *   - a shift with ANOTHER resident never extends it;
 *   - several caregivers on one shift each have their own window; consecutive shifts
 *     with the same resident keep access;
 *   - managers and family keep their rules; other agencies and ETNARA Central get nothing;
 *   - "startable recipients" lists exactly the authorized people.
 * DIRECCIONES
 *   - a caregiver reads the exact address only through a shift with an ACCEPTED assignment
 *     that has not ended (or whose visit is still open); never pending, cancelled,
 *     finished or other caregivers' shifts; the legacy recipient route is managers only;
 *   - family keeps can_view_service_location (minimal fields, no coordinates);
 *   - SmartMatch opportunities shown to caregivers carry municipality, never an address.
 *
 * Synthetic data only, disposable databases only.
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> \
 *   AUTHZ_DB_MODE=superuser|app_runtime npx tsx scripts/verifyCaregiverAccessWindow.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
const mode = process.env.AUTHZ_DB_MODE ?? "superuser";
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");
if (mode !== "superuser" && mode !== "app_runtime") throw new Error("AUTHZ_DB_MODE must be superuser or app_runtime");

type Json = Record<string, any>;
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = async <T extends pg.QueryResultRow = any>(s: string, p: unknown[] = []) => (await db.query<T>(s, p)).rows;
  if (mode === "app_runtime") {
    const pw = randomBytes(24).toString("hex");
    await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${pw}'`);
    const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = pw;
    process.env.DATABASE_URL = u.toString();
  } else process.env.DATABASE_URL = adminUrl;

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);

  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: Json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    return { status: res.status, json, text };
  }

  // ------------------------------------------------------------------ fixtures
  const org = async (name: string) => (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name]))[0].id as string;
  const orgA = await org(`WINDOW A ${tag}`);
  const orgB = await org(`WINDOW B ${tag}`);
  for (const o of [orgA, orgB]) await q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'SMARTMATCH',true) ON CONFLICT DO NOTHING`, [o]);

  type P = { key: string; userId: string; token: string; owm?: string; om: string };
  async function person(key: string, orgId: string, role: string, worker = false): Promise<P> {
    const email = `window-${key}-${tag}@example.invalid`;
    const userId = (await q(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash]))[0].id;
    const om = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId]))[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [om, orgId, role]);
    let owm: string | undefined;
    if (worker) {
      const w = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Sintetica ${key}`]))[0].id;
      owm = (await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [w, orgId]))[0].id;
    }
    const login = await call("POST", "/auth/login", "", { email, password });
    if (login.status !== 200) throw new Error(`login ${key} ${login.status}`);
    return { key, userId, token: login.json.token, owm, om };
  }
  const admin = await person("admin", orgA, "ORGANIZATION_ADMIN");
  const sup = await person("sup", orgA, "SUPERVISOR");
  const fam = await person("fam", orgA, "FAMILY");
  const famOther = await person("fam-r2", orgA, "FAMILY");
  const adminB = await person("admin-b", orgB, "ORGANIZATION_ADMIN");
  const cgB = await person("cg-b", orgB, "WORKER", true);

  const recipient = async (o: string, last: string) => (await q(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Sintetico',$2) RETURNING id`, [o, `${last}-${tag}`]))[0].id as string;
  const r1 = await recipient(orgA, "R1");
  const r2 = await recipient(orgA, "R2");
  const rB = await recipient(orgB, "RB");
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_view_service_location) VALUES ($1,$2,$3,'hija','active',true)`, [fam.userId, orgA, r1]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_view_service_location) VALUES ($1,$2,$3,'hijo','active',false)`, [famOther.userId, orgA, r2]);
  const ADDRESS = `Calle Sintetica ${tag}`;
  await q(`INSERT INTO care_recipient_locations (organization_id,care_recipient_id,label,address_line,municipality,postal_code,latitude,longitude,is_primary,gps_confirmed_at,gps_confirmed_by_user_id)
           VALUES ($1,$2,'Casa',$3,'San Juan','00901',18.4655,-66.1057,true,now(),$4)`, [orgA, r1, ADDRESS, admin.userId]);
  await q(`INSERT INTO care_recipient_locations (organization_id,care_recipient_id,label,address_line,municipality,is_primary) VALUES ($1,$2,'Casa',$3,'Ponce',true)`, [orgA, r2, `Otra ${tag}`]);
  await q(`INSERT INTO care_recipient_locations (organization_id,care_recipient_id,label,address_line,municipality,is_primary) VALUES ($1,$2,'Casa',$3,'Caguas',true)`, [orgB, rB, `Rival ${tag}`]);

  const method = (await q(`SELECT id FROM verification_methods WHERE code='CAREGIVER_SESSION'`))[0].id;
  // hours relative to now
  async function shift(o: string, r: string, startH: number, endH: number, status: string) {
    return (await q(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()+make_interval(hours=>$3),now()+make_interval(hours=>$4),$5) RETURNING id`, [o, r, startH, endH, status]))[0].id as string;
  }
  async function assign(o: string, s: string, p: P, r: string, response: string) {
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,response_status) VALUES ($1,$2,$3,$4,$5)`, [o, s, p.owm, r, response]);
  }
  async function checkIn(o: string, s: string, p: P, hoursAgo: number) {
    await q(`INSERT INTO verification_events (organization_id,shift_id,organization_worker_membership_id,verification_method_id,event_type,occurred_at,created_at) VALUES ($1,$2,$3,$4,'check_in',now()-make_interval(hours=>$5),now()-make_interval(hours=>$5))`, [o, s, p.owm, method, hoursAgo]);
  }
  async function checkOut(o: string, s: string, p: P, hoursAgo: number) {
    await q(`INSERT INTO verification_events (organization_id,shift_id,organization_worker_membership_id,verification_method_id,event_type,occurred_at,created_at) VALUES ($1,$2,$3,$4,'check_out',now()-make_interval(hours=>$5),now()-make_interval(hours=>$5))`, [o, s, p.owm, method, hoursAgo]);
  }

  const cg: Record<string, P> = {};
  for (const k of ["future", "pending", "rejected", "cancelled", "open", "closedRecent", "closedOld", "otherResident", "consecutive", "inactive", "sharedPending", "unassigned"]) cg[k] = await person(`cg-${k}`, orgA, "WORKER", true);
  const S: Record<string, string> = {};
  // accepted, starts in 2 days (antes del turno)
  S.future = await shift(orgA, r1, 48, 52, "confirmed"); await assign(orgA, S.future, cg.future, r1, "accepted");
  S.pending = await shift(orgA, r1, 50, 54, "confirmed"); await assign(orgA, S.pending, cg.pending, r1, "pending");
  S.rejected = await shift(orgA, r1, 56, 60, "confirmed"); await assign(orgA, S.rejected, cg.rejected, r1, "rejected");
  S.cancelled = await shift(orgA, r1, 60, 64, "cancelled"); await assign(orgA, S.cancelled, cg.cancelled, r1, "accepted");
  // durante: visit open after its scheduled end; a second caregiver on the same shift checked out 2 h ago; a third one is still pending
  S.shared = await shift(orgA, r1, -5, -1, "in_progress");
  await assign(orgA, S.shared, cg.open, r1, "accepted"); await checkIn(orgA, S.shared, cg.open, 5);
  await assign(orgA, S.shared, cg.closedRecent, r1, "accepted"); await checkIn(orgA, S.shared, cg.closedRecent, 5); await checkOut(orgA, S.shared, cg.closedRecent, 2);
  await assign(orgA, S.shared, cg.sharedPending, r1, "pending");
  // después: finished 30 h ago
  S.old = await shift(orgA, r1, -34, -30, "completed"); await assign(orgA, S.old, cg.closedOld, r1, "accepted"); await checkIn(orgA, S.old, cg.closedOld, 34); await checkOut(orgA, S.old, cg.closedOld, 30);
  // finished with R1 30 h ago + a current accepted shift with R2 (must NOT extend R1)
  S.otherOld = await shift(orgA, r1, -34, -30, "completed"); await assign(orgA, S.otherOld, cg.otherResident, r1, "accepted"); await checkOut(orgA, S.otherOld, cg.otherResident, 30);
  S.otherNow = await shift(orgA, r2, 2, 6, "confirmed"); await assign(orgA, S.otherNow, cg.otherResident, r2, "accepted");
  // consecutive with the same resident: old one 30 h ago, new one tomorrow
  S.consOld = await shift(orgA, r1, -34, -30, "completed"); await assign(orgA, S.consOld, cg.consecutive, r1, "accepted"); await checkOut(orgA, S.consOld, cg.consecutive, 30);
  S.consNew = await shift(orgA, r1, 20, 24, "confirmed"); await assign(orgA, S.consNew, cg.consecutive, r1, "accepted");
  // accepted and current, but her caregiver membership is inactive
  S.inactive = await shift(orgA, r1, 3, 7, "confirmed"); await assign(orgA, S.inactive, cg.inactive, r1, "accepted");
  await q(`UPDATE organization_worker_memberships SET status='inactive' WHERE id=$1`, [cg.inactive.owm]);
  // agency B caregiver with her own current shift
  S.b = await shift(orgB, rB, 1, 5, "confirmed"); await assign(orgB, S.b, cgB, rB, "accepted");

  const A = `/organizations/${orgA}`;
  // the agency opens the conversation (adds every authorized party)
  const opened = await call("POST", `${A}/care-recipients/${r1}/conversation`, admin.token, {});
  check("administradora abre la conversación de R1", opened.status === 200, `${opened.status}`);
  const thread: string = opened.json.conversation?.id;
  await call("POST", `${A}/conversations/${thread}/messages`, fam.token, { body: `mensaje familiar ${tag}` });
  // a stale participant row from before 132 (old rule) for the caregiver whose window closed
  await q(`INSERT INTO message_thread_participants (organization_id,message_thread_id,user_id,can_write) VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING`, [orgA, thread, cg.closedOld.userId]);
  await q(`INSERT INTO message_thread_participants (organization_id,message_thread_id,user_id,can_write) VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING`, [orgA, thread, cg.pending.userId]);

  const participants = new Set((await q(`SELECT user_id FROM message_thread_participants WHERE message_thread_id=$1`, [thread])).map((r) => r.user_id));

  // ------------------------------------------------------------------ messaging matrix
  const expectMsg: Record<string, boolean> = {
    future: true, pending: false, rejected: false, cancelled: false, open: true, closedRecent: true,
    closedOld: false, otherResident: false, consecutive: true, inactive: false, sharedPending: false, unassigned: false,
  };
  for (const [k, allowed] of Object.entries(expectMsg)) {
    const p = cg[k];
    const list = await call("GET", `${A}/conversations`, p.token);
    const inList = (list.json.conversations ?? []).some((c: Json) => c.id === thread);
    const read = await call("GET", `${A}/conversations/${thread}/messages`, p.token);
    const start = await call("POST", `${A}/care-recipients/${r1}/conversation`, p.token, {});
    const startable = await call("GET", `${A}/conversations/startable-recipients`, p.token);
    const listsR1 = (startable.json.recipients ?? []).some((r: Json) => r.id === r1);
    if (allowed) {
      check(`cuidadora ${k}: ve la conversación en su lista`, inList || !participants.has(p.userId), `inList=${inList}`);
      check(`cuidadora ${k}: lee el historial`, read.status === 200 || (!participants.has(p.userId) && read.status === 404), `${read.status}`);
      check(`cuidadora ${k}: puede iniciar/abrir la conversación`, start.status === 200, `${start.status}`);
      const after = await call("GET", `${A}/conversations/${thread}/messages`, p.token);
      check(`cuidadora ${k}: tras abrirla, lee el historial`, after.status === 200 && (after.json.messages ?? []).length > 0, `${after.status}`);
      const write = await call("POST", `${A}/conversations/${thread}/messages`, p.token, { body: `escribe ${k}` });
      check(`cuidadora ${k}: escribe`, write.status === 201, `${write.status}`);
      check(`cuidadora ${k}: R1 está entre sus destinatarios`, startable.status === 200 && listsR1, `${startable.status}`);
    } else {
      check(`cuidadora ${k}: NO ve la conversación en su lista`, !inList, `inList=${inList}`);
      check(`cuidadora ${k}: NO lee el historial`, read.status === 404 && !read.text.includes("mensaje familiar"), `${read.status}`);
      check(`cuidadora ${k}: NO puede iniciarla`, start.status === 403, `${start.status}`);
      const write = await call("POST", `${A}/conversations/${thread}/messages`, p.token, { body: "no" });
      check(`cuidadora ${k}: NO escribe`, write.status === 404, `${write.status}`);
      check(`cuidadora ${k}: R1 NO está entre sus destinatarios`, startable.status === 200 && !listsR1, `${startable.status}`);
    }
  }
  check("otra residente: la cuidadora con turno vigente con R2 sí puede con R2",
    (await call("POST", `${A}/care-recipients/${r2}/conversation`, cg.otherResident.token, {})).status === 200);
  {
    const addedNow = new Set((await q(`SELECT user_id FROM message_thread_participants WHERE message_thread_id=$1`, [thread])).map((r) => r.user_id));
    const reopen = await call("POST", `${A}/care-recipients/${r1}/conversation`, sup.token, {});
    const afterReopen = new Set((await q(`SELECT user_id FROM message_thread_participants WHERE message_thread_id=$1`, [thread])).map((r) => r.user_id));
    const added = [...afterReopen].filter((u) => !addedNow.has(u));
    check("supervisora reabre: 200", reopen.status === 200, `${reopen.status}`);
    for (const k of ["otherResident", "rejected", "cancelled", "inactive", "unassigned"]) {
      check(`al abrir/reabrir no se añade a la cuidadora ${k}`, !afterReopen.has(cg[k].userId) && !added.includes(cg[k].userId), "");
    }
    for (const k of ["future", "open", "closedRecent", "consecutive"]) check(`participante vigente: ${k}`, afterReopen.has(cg[k].userId), "");
  }
  // notifications: a new family message notifies only those who may still read
  const before = new Date();
  await call("POST", `${A}/conversations/${thread}/messages`, fam.token, { body: `segundo mensaje ${tag}` });
  const notified = new Set((await q(`SELECT user_id FROM notifications WHERE related_entity_id=$1 AND created_at >= $2`, [thread, before])).map((r) => r.user_id));
  check("aviso: cuidadora fuera de plazo NO recibe aviso", !notified.has(cg.closedOld.userId), "");
  check("aviso: cuidadora pendiente NO recibe aviso", !notified.has(cg.pending.userId), "");
  check("aviso: cuidadora vigente sí recibe aviso", notified.has(cg.open.userId), "");
  check("aviso: administradora sí recibe aviso", notified.has(admin.userId), "");

  // managers, family, other agency, family of another resident
  check("administradora lee", (await call("GET", `${A}/conversations/${thread}/messages`, admin.token)).status === 200);
  check("supervisora lee", (await call("GET", `${A}/conversations/${thread}/messages`, sup.token)).status === 200);
  check("familiar de R1 lee", (await call("GET", `${A}/conversations/${thread}/messages`, fam.token)).status === 200);
  check("familiar de otra residente NO lee", (await call("GET", `${A}/conversations/${thread}/messages`, famOther.token)).status === 404);
  check("familiar de otra residente NO inicia la de R1", (await call("POST", `${A}/care-recipients/${r1}/conversation`, famOther.token, {})).status === 403);
  check("familia: sus destinatarios son solo su familiar",
    JSON.stringify(((await call("GET", `${A}/conversations/startable-recipients`, fam.token)).json.recipients ?? []).map((r: Json) => r.id)) === JSON.stringify([r1]));
  check("administradora: destinatarios = todas las personas activas", ((await call("GET", `${A}/conversations/startable-recipients`, admin.token)).json.recipients ?? []).length === 2);
  for (const [who, p] of [["administradora de otra agencia", adminB], ["cuidadora de otra agencia", cgB]] as const) {
    check(`${who}: NO lee (URL ajena)`, [403, 404].includes((await call("GET", `${A}/conversations/${thread}/messages`, p.token)).status));
    check(`${who}: NO inicia (URL ajena)`, [403, 404].includes((await call("POST", `${A}/care-recipients/${r1}/conversation`, p.token, {})).status));
    check(`${who}: NO inicia (su URL, id ajeno)`, [403, 404].includes((await call("POST", `/organizations/${orgB}/care-recipients/${r1}/conversation`, p.token, {})).status));
    check(`${who}: NO lee (su URL, id ajeno)`, (await call("GET", `/organizations/${orgB}/conversations/${thread}/messages`, p.token)).status === 404);
  }
  // same answer whether the person exists or not (no oracle)
  check("cuidadora sin permiso: misma respuesta para residente inexistente",
    (await call("POST", `${A}/care-recipients/${randomUUID()}/conversation`, cg.unassigned.token, {})).text === (await call("POST", `${A}/care-recipients/${r1}/conversation`, cg.unassigned.token, {})).text);

  // revocation in the middle of the window
  await q(`UPDATE organization_worker_memberships SET status='inactive' WHERE id=$1`, [cg.future.owm]);
  check("revocación: cuidadora desactivada pierde la conversación", (await call("GET", `${A}/conversations/${thread}/messages`, cg.future.token)).status === 404);
  await q(`UPDATE organization_worker_memberships SET status='active' WHERE id=$1`, [cg.future.owm]);
  await q(`UPDATE assignments SET response_status='rejected' WHERE shift_id=$1 AND organization_worker_membership_id=$2`, [S.consNew, cg.consecutive.owm]);
  check("revocación: al retirar su asignación vigente pierde la conversación", (await call("GET", `${A}/conversations/${thread}/messages`, cg.consecutive.token)).status === 404);
  await q(`UPDATE assignments SET response_status='accepted' WHERE shift_id=$1 AND organization_worker_membership_id=$2`, [S.consNew, cg.consecutive.owm]);

  // ------------------------------------------------------------------ addresses
  const addr = async (p: P, s: string) => call("GET", `${A}/shifts/${s}/service-location`, p.token);
  const hasAddress = (r: { status: number; text: string }) => r.status === 200 && r.text.includes(ADDRESS);
  check("dirección: aceptada, antes del turno → la ve", hasAddress(await addr(cg.future, S.future)));
  check("dirección: pendiente → NO", !hasAddress(await addr(cg.pending, S.pending)));
  check("dirección: rechazada → NO", !hasAddress(await addr(cg.rejected, S.rejected)));
  check("dirección: turno cancelado → NO", !hasAddress(await addr(cg.cancelled, S.cancelled)));
  check("dirección: durante la visita abierta (tras la hora de fin) → la ve", hasAddress(await addr(cg.open, S.shared)));
  check("dirección: compañera que ya salió del mismo turno → NO", !hasAddress(await addr(cg.closedRecent, S.shared)));
  check("dirección: compañera pendiente del mismo turno → NO", !hasAddress(await addr(cg.sharedPending, S.shared)));
  check("dirección: turno terminado hace 30 h → NO", !hasAddress(await addr(cg.closedOld, S.old)));
  check("dirección: turno consecutivo, el viejo → NO", !hasAddress(await addr(cg.consecutive, S.consOld)));
  check("dirección: turno consecutivo, el nuevo → la ve", hasAddress(await addr(cg.consecutive, S.consNew)));
  check("dirección: membresía inactiva → NO", !hasAddress(await addr(cg.inactive, S.inactive)));
  check("dirección: turno de otra cuidadora → NO", !hasAddress(await addr(cg.future, S.consNew)));
  check("dirección: cuidadora de otra agencia (URL ajena) → NO", !hasAddress(await addr(cgB, S.future)));
  check("dirección: cuidadora de otra agencia (su URL) → NO", !hasAddress(await call("GET", `/organizations/${orgB}/shifts/${S.future}/service-location`, cgB.token)));
  for (const k of ["future", "open", "consecutive"]) {
    check(`ruta antigua de dirección: cuidadora ${k} → 404`, (await call("GET", `${A}/care-recipients/${r1}/location`, cg[k].token)).status === 404);
  }
  check("ruta antigua de dirección: administradora → 200", (await call("GET", `${A}/care-recipients/${r1}/location`, admin.token)).status === 200);
  check("ruta antigua de dirección: supervisora → 200", (await call("GET", `${A}/care-recipients/${r1}/location`, sup.token)).status === 200);
  check("ruta antigua de dirección: familia → 404", (await call("GET", `${A}/care-recipients/${r1}/location`, fam.token)).status === 404);
  {
    const f = await call("GET", `/me/care-recipients/${r1}/service-location`, fam.token);
    check("familia con permiso ve la dirección mínima (sin coordenadas ni notas)", f.status === 200 && f.text.includes(ADDRESS) && !/latitude|longitude|accessNotes/.test(f.text), `${f.status}`);
    const g = await call("GET", `/me/care-recipients/${r2}/service-location`, famOther.token);
    check("familia sin permiso no ve la dirección", g.status === 200 && g.json.location === null, `${g.status}`);
    const h = await call("GET", `/me/care-recipients/${r1}/service-location`, famOther.token);
    check("familia de otra residente no ve la dirección de R1", h.status !== 200 || !h.text.includes(ADDRESS), `${h.status}`);
  }
  // access log: every caregiver read is recorded
  const logged = Number((await q(`SELECT count(*)::int n FROM care_recipient_location_access_log WHERE user_id=$1`, [cg.future.userId]))[0].n);
  check("dirección: cada lectura de la cuidadora queda registrada", logged >= 1, `${logged}`);

  // ------------------------------------------------------------------ SmartMatch
  const opp = await call("POST", `${A}/smartmatch/opportunities`, admin.token, {
    visibility: "INTERNAL", regionLabel: "San Juan", roleLabel: "Cuidador/a",
    startsAt: new Date(Date.now() + 72 * 36e5).toISOString(), endsAt: new Date(Date.now() + 76 * 36e5).toISOString() });
  if (opp.status === 201) {
    await call("POST", `${A}/smartmatch/opportunities/${opp.json.opportunity.id}/publish`, admin.token, {});
    const seen = await call("GET", `${A}/smartmatch/available-opportunities`, cg.unassigned.token);
    const keys = new Set<string>();
    const walk = (v: any) => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
    walk(seen.json);
    check("SmartMatch: la cuidadora ve la oportunidad con municipio", seen.status === 200 && seen.text.includes("San Juan"), `${seen.status}`);
    check("SmartMatch: sin dirección, coordenadas ni persona", ![...keys].some((k) => /address|latitude|longitude|recipient|first_?name|last_?name|access_?notes/i.test(k)) && !seen.text.includes(ADDRESS), [...keys].join(","));
  } else check("SmartMatch: crear oportunidad de prueba", false, `${opp.status} ${opp.text.slice(0, 80)}`);

  // ------------------------------------------------------------------ report
  const failed = results.filter((r) => !r.pass);
  console.log(`\nVENTANA DE ACCESO — modo ${mode}`);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
  console.log(`\nCAREGIVER_WINDOW mode=${mode} total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
  server.close(); await pool.end(); await db.end();
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
