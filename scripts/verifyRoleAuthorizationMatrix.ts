/**
 * Role authorization matrix (Fase 1, auditoría 26-oct-2026).
 *
 * Proves, over real HTTP, that each role only reaches what it should -- with the
 * server connected in the mode given by AUTHZ_DB_MODE:
 *   - "superuser": the app connects as the migrations superuser, so RLS does NOT
 *     apply (this is how production runs today). Only explicit code checks protect.
 *   - "app_runtime": the app connects as the restricted role, RLS applies.
 * Both modes must pass: the code must protect on its own, and RLS stays as a
 * second layer. Synthetic data only, disposable databases only.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> \
 *   AUTHZ_DB_MODE=superuser|app_runtime npx tsx scripts/verifyRoleAuthorizationMatrix.ts
 *
 * AUTHZ_REPORT_ONLY=true prints the matrix without failing (used to measure the
 * baseline before the fixes).
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
const mode = process.env.AUTHZ_DB_MODE ?? "superuser";
const reportOnly = process.env.AUTHZ_REPORT_ONLY === "true";
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");
if (mode !== "superuser" && mode !== "app_runtime") throw new Error("AUTHZ_DB_MODE must be superuser or app_runtime");

type Json = Record<string, any>;
type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];

/**
 * Legitimate flows that work today only because production bypasses RLS: with
 * app_runtime, RLS still blocks them. They are reported (never hidden) and must
 * be fixed with a migration BEFORE production switches to app_runtime.
 * In superuser mode they are ordinary checks and must pass.
 */
const KNOWN_RLS_GAPS: Record<string, string> = {
  "cg-assigned: visita terminada: su verificación": "G1: tras el check-out, RLS oculta a la cuidadora su propia verificación (018/076)",
  "cg-assigned: visita terminada: sus registros": "G2: tras el check-out, RLS oculta a la cuidadora sus propios registros (care_events_worker_assigned_only)",
  "cg-est-admin: crear turno de su establecimiento": "G3: RLS no deja ver a la administradora de establecimiento las personas de su establecimiento",
  "cg-est-admin: id del turno creado": "G3",
  "cg-assigned: nombre visible en su visita terminada": "G1: tras la visita, RLS oculta el nombre de la persona a la cuidadora",
  "cg-est-admin: asignar en su establecimiento": "G3",
  "cg-est-admin: ver asignaciones de su establecimiento": "G3",
};

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);

  if (mode === "app_runtime") {
    const runtimePassword = randomBytes(24).toString("hex");
    await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
    const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
    process.env.DATABASE_URL = u.toString();
  } else {
    process.env.DATABASE_URL = adminUrl;
  }
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const role = (await pool.query<{ u: string; s: boolean; b: boolean }>(
    `SELECT current_user AS u, r.rolsuper AS s, r.rolbypassrls AS b FROM pg_roles r WHERE r.rolname = current_user`)).rows[0];
  const bypasses = role.s || role.b;
  if ((mode === "superuser") !== bypasses) throw new Error(`Mode ${mode} but app connects as ${role.u} (bypass RLS: ${bypasses})`);

  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);

  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 80) }; }
    return { status: res.status, body: parsed, text };
  }

  // ------------------------------------------------------------------ fixtures
  const org = async (name: string) => (await q<{ id: string }>(
    `INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgA = await org(`AUTHZ A ${tag}`);
  await q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'SMARTMATCH',true)`, [orgA]);
  await q(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'AUTHZ')`, [orgA]);
  const orgB = await org(`AUTHZ B ${tag}`);

  type P = { key: string; userId: string; token: string; workerId?: string; membershipId?: string; orgMembershipId?: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `authz-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let workerId: string | undefined; let membershipId: string | undefined;
    if (worker) {
      workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Sintetica ${key}`])).rows[0].id;
      membershipId = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
    }
    const login = await call("POST", "/auth/login", "", { email, password });
    if (login.status !== 200) throw new Error(`login ${key} ${login.status}`);
    return { key, userId, token: login.body.token, workerId, membershipId, orgMembershipId: m };
  }
  const admin = await person("admin", orgA, ["ORGANIZATION_ADMIN"]);
  const sup = await person("sup", orgA, ["SUPERVISOR"]);
  const cgA = await person("cg-assigned", orgA, ["WORKER"], true);
  const cgO = await person("cg-other", orgA, ["WORKER"], true);
  const fam1 = await person("fam-r1", orgA, ["FAMILY"]);
  const fam2 = await person("fam-r2", orgA, ["FAMILY"]);
  const adminB = await person("admin-b", orgB, ["ORGANIZATION_ADMIN"]);
  const cgX = await person("cg-x", orgA, ["WORKER"], true);

  const recipient = async (o: string, last: string) => (await q<{ id: string }>(
    `INSERT INTO care_recipients (organization_id,first_name,last_name,date_of_birth,allergies) VALUES ($1,'Sintetico',$2,'1940-01-01',ARRAY['sintetica']) RETURNING id`, [o, `${last}-${tag}`])).rows[0].id;
  const r1 = await recipient(orgA, "R1");
  const r2 = await recipient(orgA, "R2");
  const rB = await recipient(orgB, "RB");
  for (const [f, r] of [[fam1, r1], [fam2, r2]] as const) {
    await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hijo','active')`, [f.userId, orgA, r]);
  }
  const shift = async (r: string) => (await q<{ id: string }>(
    `INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()+interval '1 day',now()+interval '1 day 4 hours','confirmed') RETURNING id`, [orgA, r])).rows[0].id;
  const s1 = await shift(r1);
  const s2 = await shift(r2);
  const a1 = (await q<{ id: string }>(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,role_in_shift,response_status) VALUES ($1,$2,$3,$4,'caregiver','accepted') RETURNING id`, [orgA, s1, cgA.membershipId, r1])).rows[0].id;
  const aX = (await q<{ id: string }>(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,role_in_shift,response_status) VALUES ($1,$2,$3,$4,'caregiver','accepted') RETURNING id`, [orgA, s2, cgX.membershipId, r2])).rows[0].id;
  const noteType = (await q<{ id: string }>(`SELECT id FROM care_event_types WHERE code='NOTE'`)).rows[0].id;
  const e1 = (await q<{ id: string }>(`INSERT INTO care_events (organization_id,shift_id,care_recipient_id,organization_worker_membership_id,care_event_type_id,note_text) VALUES ($1,$2,$3,$4,$5,'nota R1') RETURNING id`, [orgA, s1, r1, cgA.membershipId, noteType])).rows[0].id;
  const e2 = (await q<{ id: string }>(`INSERT INTO care_events (organization_id,shift_id,care_recipient_id,organization_worker_membership_id,care_event_type_id,note_text) VALUES ($1,$2,$3,$4,$5,'nota R2 privada') RETURNING id`, [orgA, s2, r2, cgO.membershipId, noteType])).rows[0].id;
  const i2 = (await q<{ id: string }>(`INSERT INTO incidents (organization_id,care_recipient_id,organization_worker_membership_id,severity,description,actions_taken) VALUES ($1,$2,$3,'medium','incidente R2','acciones internas') RETURNING id`, [orgA, r2, cgO.membershipId])).rows[0].id;
  await q(`INSERT INTO incident_timeline_entries (organization_id,incident_id,entry_text,created_by_user_id) VALUES ($1,$2,'seguimiento interno',$3)`, [orgA, i2, admin.userId]);
  const o2 = (await q<{ id: string }>(`INSERT INTO observations (organization_id,care_recipient_id,organization_worker_membership_id,category,description) VALUES ($1,$2,$3,'pain','observacion R2') RETURNING id`, [orgA, r2, cgO.membershipId])).rows[0].id;
  const t2 = (await q<{ id: string }>(`INSERT INTO message_threads (organization_id,care_recipient_id) VALUES ($1,$2) RETURNING id`, [orgA, r2])).rows[0].id;
  for (const u of [fam2.userId, admin.userId]) await q(`INSERT INTO message_thread_participants (organization_id,message_thread_id,user_id) VALUES ($1,$2,$3)`, [orgA, t2, u]);
  await q(`INSERT INTO messages (organization_id,message_thread_id,sender_user_id,body) VALUES ($1,$2,$3,'mensaje privado R2')`, [orgA, t2, fam2.userId]);
  await q(`INSERT INTO shift_private_instructions (shift_id,organization_id,instructions,created_by_user_id) VALUES ($1,$2,'codigo de entrada sintetico',$3)`, [s2, orgA, admin.userId]);

  // ------------------------------------------------------------------ checks
  const A = `/organizations/${orgA}`;
  const denied = (s: number) => s === 401 || s === 403 || s === 404;
  const ok = (s: number) => s >= 200 && s < 300;
  async function expectDenied(name: string, p: P, method: string, path: string, body?: Json) {
    const r = await call(method, path, p.token, body);
    results.push({ name: `${p.key}: ${name}`, pass: denied(r.status), detail: `${method} ${path.replace(A, "/org")} -> ${r.status}` });
  }
  async function expectAllowed(name: string, p: P, method: string, path: string, body?: Json) {
    const r = await call(method, path, p.token, body);
    results.push({ name: `${p.key}: ${name}`, pass: ok(r.status), detail: `${method} ${path.replace(A, "/org")} -> ${r.status}` });
    return r;
  }
  /** A list call must either be denied, or answer without the forbidden ids. */
  async function expectAbsent(name: string, p: P, path: string, forbidden: string[]) {
    const r = await call("GET", path, p.token);
    const leaked = ok(r.status) ? forbidden.filter((id) => r.text.includes(id)) : [];
    results.push({ name: `${p.key}: ${name}`, pass: denied(r.status) || (ok(r.status) && leaked.length === 0),
      detail: `GET ${path.replace(A, "/org")} -> ${r.status}${leaked.length ? ` LEAKS ${leaked.length}` : ""}` });
  }
  async function expectPresent(name: string, p: P, path: string, required: string[]) {
    const r = await call("GET", path, p.token);
    const missing = required.filter((id) => !r.text.includes(id));
    results.push({ name: `${p.key}: ${name}`, pass: ok(r.status) && missing.length === 0, detail: `GET ${path.replace(A, "/org")} -> ${r.status}${missing.length ? ` MISSING ${missing.length}` : ""}` });
  }

  // C2 -- residents
  await expectPresent("lista residentes (gestor ve todos)", admin, `${A}/care-recipients`, [r1, r2]);
  await expectPresent("lista residentes (cuidadora ve su asignado)", cgA, `${A}/care-recipients`, [r1]);
  await expectAbsent("lista residentes sin no asignados", cgA, `${A}/care-recipients`, [r2]);
  await expectAbsent("lista residentes sin asignación", cgO, `${A}/care-recipients`, [r1, r2]);
  await expectPresent("lista residentes (familiar ve el suyo)", fam1, `${A}/care-recipients`, [r1]);
  await expectAbsent("lista residentes sin otros residentes", fam1, `${A}/care-recipients`, [r2]);
  await expectDenied("ver residente ajeno", fam1, "GET", `${A}/care-recipients/${r2}`);
  await expectDenied("ver residente no asignado", cgA, "GET", `${A}/care-recipients/${r2}`);
  await expectAllowed("ver residente asignado", cgA, "GET", `${A}/care-recipients/${r1}`);
  await expectDenied("modificar residente ajeno", fam1, "PATCH", `${A}/care-recipients/${r2}`, { preferredName: "x" });
  await expectDenied("modificar su propio familiar", fam1, "PATCH", `${A}/care-recipients/${r1}`, { allergies: [] });
  await expectDenied("modificar residente asignado", cgA, "PATCH", `${A}/care-recipients/${r1}`, { allergies: [] });
  await expectDenied("crear residente", fam1, "POST", `${A}/care-recipients`, { firstName: "X", lastName: "Y" });
  await expectDenied("crear residente", cgO, "POST", `${A}/care-recipients`, { firstName: "X", lastName: "Y" });
  await expectAllowed("modificar residente", sup, "PATCH", `${A}/care-recipients/${r2}`, { preferredName: "Sinte" });

  // C2 -- care events
  await expectAbsent("eventos de residente ajeno", fam1, `${A}/care-recipients/${r2}/care-events`, [e2]);
  await expectAbsent("eventos de residente no asignado", cgA, `${A}/care-recipients/${r2}/care-events`, [e2]);
  await expectAbsent("eventos de turno ajeno", fam1, `${A}/shifts/${s2}/care-events`, [e2]);
  await expectAbsent("eventos de turno no asignado", cgA, `${A}/shifts/${s2}/care-events`, [e2]);
  await expectPresent("eventos de su turno", cgA, `${A}/shifts/${s1}/care-events`, [e1]);
  await expectPresent("eventos de residente (gestor)", admin, `${A}/care-recipients/${r2}/care-events`, [e2]);

  // C3 -- family invitations
  await expectDenied("invitarse como familiar de otro residente", fam1, "POST", `${A}/care-recipients/${r2}/family-invitations`, { email: `x-${tag}@example.invalid`, relationshipType: "hijo" });
  await expectDenied("invitarse como familiar", cgO, "POST", `${A}/care-recipients/${r2}/family-invitations`, { email: `y-${tag}@example.invalid`, relationshipType: "hijo" });
  await expectAllowed("invitar familiar", admin, "POST", `${A}/care-recipients/${r2}/family-invitations`, { email: `z-${tag}@example.invalid`, relationshipType: "hija" });

  // A1 -- messaging
  await expectDenied("leer conversación ajena", fam1, "GET", `${A}/conversations/${t2}/messages`);
  await expectDenied("leer conversación ajena", cgO, "GET", `${A}/conversations/${t2}/messages`);
  await expectAllowed("leer su conversación", fam2, "GET", `${A}/conversations/${t2}/messages`);

  // A2 -- incidents
  await expectDenied("cronología de incidente", fam1, "GET", `${A}/incidents/${i2}/timeline`);
  await expectDenied("cronología de incidente no asignado", cgA, "GET", `${A}/incidents/${i2}/timeline`);
  await expectDenied("escribir cronología", fam1, "POST", `${A}/incidents/${i2}/timeline`, { entryText: "x" });
  await expectDenied("escribir cronología no asignado", cgA, "POST", `${A}/incidents/${i2}/timeline`, { entryText: "x" });
  await expectDenied("adjuntos de incidente", fam1, "GET", `${A}/incidents/${i2}/attachments`);
  await expectDenied("adjuntos de incidente no asignado", cgA, "GET", `${A}/incidents/${i2}/attachments`);
  await expectAbsent("lista de incidentes", cgA, `${A}/incidents`, [i2]);
  await expectDenied("incidente no asignado", cgA, "GET", `${A}/incidents/${i2}`);
  await expectAllowed("cronología (gestor)", sup, "GET", `${A}/incidents/${i2}/timeline`);

  // A3 -- scheduling and assignments
  const future = { scheduledStart: new Date(Date.now() + 3 * 864e5).toISOString(), scheduledEnd: new Date(Date.now() + 3 * 864e5 + 3 * 36e5).toISOString() };
  await expectDenied("crear turno", fam1, "POST", `${A}/shifts`, { careRecipientId: r1, ...future });
  await expectDenied("crear turno", cgA, "POST", `${A}/shifts`, { careRecipientId: r1, ...future });
  await expectDenied("asignar cuidadora", fam1, "POST", `${A}/shifts/${s2}/assignments`, { organizationWorkerMembershipId: cgO.membershipId });
  await expectDenied("asignarse a turno", cgO, "POST", `${A}/shifts/${s2}/assignments`, { organizationWorkerMembershipId: cgO.membershipId });
  await expectDenied("quitar asignación", fam1, "PATCH", `${A}/shifts/${s1}/assignments/${a1}`, { action: "remove", reason: "x" });
  await expectDenied("quitar asignación ajena", cgO, "PATCH", `${A}/shifts/${s1}/assignments/${a1}`, { action: "remove", reason: "x" });
  await expectAbsent("lista de turnos", cgA, `${A}/shifts`, [s2]);
  await expectDenied("turno no asignado", cgA, "GET", `${A}/shifts/${s2}`);
  await expectAbsent("asignaciones de turno ajeno", fam1, `${A}/shifts/${s2}/assignments`, [aX]);
  await expectAbsent("asignaciones de turno no asignado", cgA, `${A}/shifts/${s2}/assignments`, [aX]);
  await expectPresent("asignaciones de su turno", cgX, `${A}/shifts/${s2}/assignments`, [aX]);

  // M3 -- observations, private instructions, verification, roster, compliance
  await expectAbsent("lista de observaciones", cgA, `${A}/observations`, [o2]);
  await expectDenied("observación no asignada", cgA, "GET", `${A}/observations/${o2}`);
  await expectDenied("instrucciones privadas", fam1, "GET", `${A}/shifts/${s2}/private-instructions`);
  await expectDenied("instrucciones privadas no asignado", cgA, "GET", `${A}/shifts/${s2}/private-instructions`);
  await expectAllowed("instrucciones privadas (gestor)", admin, "GET", `${A}/shifts/${s2}/private-instructions`);
  await expectDenied("verificación de visita ajena", fam1, "GET", `${A}/shifts/${s2}/visit-verification`);
  await expectDenied("verificación de visita no asignada", cgA, "GET", `${A}/shifts/${s2}/visit-verification`);
  await expectDenied("plantilla de cuidadoras", fam1, "GET", `${A}/workers`);
  await expectDenied("ficha de cuidadora", fam1, "GET", `${A}/workers/${cgO.membershipId}`);
  await expectDenied("cumplimiento de otra cuidadora", cgA, "GET", `${A}/workers/${cgO.membershipId}/compliance`);
  await expectDenied("cumplimiento de cuidadora", fam1, "GET", `${A}/workers/${cgO.membershipId}/compliance`);
  await expectAllowed("su propio cumplimiento", cgO, "GET", `${A}/workers/${cgO.membershipId}/compliance`);
  await expectAllowed("cumplimiento (gestor)", sup, "GET", `${A}/workers/${cgO.membershipId}/compliance`);
  await expectPresent("plantilla (gestor)", admin, `${A}/workers`, [cgO.membershipId!]);
  await expectAllowed("su propia ficha", cgO, "GET", `${A}/workers/${cgO.membershipId}`);
  await expectDenied("evaluar elegibilidad", fam1, "POST", `${A}/workers/${cgO.membershipId}/eligibility/evaluate`);
  await expectDenied("foto de evento ajeno", fam1, "GET", `${A}/care-events/${e2}/photo`);

  // Regression: legitimate access keeps working
  await expectPresent("lista de turnos (gestor)", admin, `${A}/shifts`, [s1, s2]);
  await expectPresent("lista de turnos (su turno)", cgA, `${A}/shifts`, [s1]);
  await expectAllowed("su turno", cgA, "GET", `${A}/shifts/${s1}`);
  await expectAllowed("verificación de su turno", cgA, "GET", `${A}/shifts/${s1}/visit-verification`);
  await expectDenied("verificación por API (familia usa su resumen)", fam1, "GET", `${A}/shifts/${s1}/visit-verification`);
  await expectPresent("incidentes (gestor)", sup, `${A}/incidents`, [i2]);
  await expectPresent("observaciones (gestor)", admin, `${A}/observations`, [o2]);
  await expectPresent("conversaciones (participante)", fam2, `${A}/conversations`, [t2]);
  await expectAllowed("cronología familiar", fam1, "GET", `${A}/care-recipients/${r1}/timeline`);
  await expectPresent("sus residentes (familia)", fam1, `/me/care-recipients`, [r1]);
  await expectAllowed("crear residente (gestor)", admin, "POST", `${A}/care-recipients`, { firstName: "Nueva", lastName: `Sintetica-${tag}` });
  await expectAllowed("crear turno (gestor)", admin, "POST", `${A}/shifts`, { careRecipientId: r1, ...future });
  await expectAllowed("asignar cuidadora (gestor)", sup, "POST", `${A}/shifts/${s2}/assignments`, { organizationWorkerMembershipId: cgO.membershipId });
  await expectAllowed("instrucciones privadas (cuidadora asignada)", cgX, "GET", `${A}/shifts/${s2}/private-instructions`);

  // Two caregivers on one shift: each sees only her own check-in, also after the visit ends
  const cgY = await person("cg-y", orgA, ["WORKER"], true);
  await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,role_in_shift,response_status) VALUES ($1,$2,$3,$4,'caregiver','accepted')`, [orgA, s1, cgY.membershipId, r1]);
  const pin = (await q<{ id: string }>(`SELECT id FROM verification_methods WHERE code='CAREGIVER_SESSION'`)).rows[0].id;
  const vA = (await q<{ id: string }>(`INSERT INTO verification_events (organization_id,shift_id,organization_worker_membership_id,verification_method_id,event_type) VALUES ($1,$2,$3,$4,'check_in') RETURNING id`, [orgA, s1, cgA.membershipId, pin])).rows[0].id;
  const vY = (await q<{ id: string }>(`INSERT INTO verification_events (organization_id,shift_id,organization_worker_membership_id,verification_method_id,event_type) VALUES ($1,$2,$3,$4,'check_in') RETURNING id`, [orgA, s1, cgY.membershipId, pin])).rows[0].id;
  await expectPresent("verificación: su propio registro", cgA, `${A}/shifts/${s1}/visit-verification`, [vA]);
  await expectAbsent("verificación: no ve el de otra cuidadora", cgA, `${A}/shifts/${s1}/visit-verification`, [vY]);
  await expectPresent("verificación (gestor ve ambas)", sup, `${A}/shifts/${s1}/visit-verification`, [vA, vY]);
  await q(`UPDATE shifts SET status='completed' WHERE id=$1`, [s1]);
  await expectPresent("visita terminada: su verificación", cgA, `${A}/shifts/${s1}/visit-verification`, [vA]);
  await expectPresent("visita terminada: sus registros", cgA, `${A}/shifts/${s1}/care-events`, [e1]);

  const myShifts = await call("GET", `${A}/me/shifts`, cgA.token);
  const doneRow = (myShifts.body.shifts ?? []).find((x: Json) => x.id === s1);
  results.push({ name: "cg-assigned: nombre visible en su visita terminada", pass: myShifts.status === 200 && typeof doneRow?.care_recipient_display_name === "string" && doneRow.care_recipient_display_name.length > 0,
    detail: `GET /org/me/shifts -> ${myShifts.status} name=${doneRow?.care_recipient_display_name ?? "null"}` });
  results.push({ name: "cg-assigned: /me/shifts sin datos clínicos", pass: !/allergies|date_of_birth/.test(myShifts.text), detail: "sin alergias ni fecha de nacimiento" });

  // Establishment administrator (a caregiver who runs one establishment)
  const loc = (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,$2) RETURNING id`, [orgA, `Hogar ${tag}`])).rows[0].id;
  const rE = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,location_id) VALUES ($1,'Sintetico',$2,$3) RETURNING id`, [orgA, `RE-${tag}`, loc])).rows[0].id;
  const cgE = await person("cg-est-admin", orgA, ["WORKER"], true);
  await q(`INSERT INTO establishment_admin_assignments (organization_id,location_id,organization_membership_id) VALUES ($1,$2,$3)`, [orgA, loc, cgE.orgMembershipId]);
  const estShift = await expectAllowed("crear turno de su establecimiento", cgE, "POST", `${A}/shifts`, { careRecipientId: rE, ...future });
  await expectDenied("crear turno fuera de su establecimiento", cgE, "POST", `${A}/shifts`, { careRecipientId: r1, ...future });
  const estShiftId = estShift.body.shift?.id ?? estShift.body.id;
  if (estShiftId) {
    await expectAllowed("asignar en su establecimiento", cgE, "POST", `${A}/shifts/${estShiftId}/assignments`, { organizationWorkerMembershipId: cgO.membershipId });
    await expectPresent("ver asignaciones de su establecimiento", cgE, `${A}/shifts/${estShiftId}/assignments`, [cgO.membershipId!]);
  } else results.push({ name: "cg-est-admin: id del turno creado", pass: false, detail: JSON.stringify(estShift.body).slice(0, 120) });
  await expectDenied("asignar fuera de su establecimiento", cgE, "POST", `${A}/shifts/${s2}/assignments`, { organizationWorkerMembershipId: cgO.membershipId });

  // Cross-tenant
  await expectDenied("residentes de otra agencia", adminB, "GET", `${A}/care-recipients`);
  await expectDenied("residente de otra agencia", admin, "GET", `${A.replace(orgA, orgB)}/care-recipients/${rB}`);
  const before = (await q<{ display_name: string }>(`SELECT display_name FROM workers WHERE id=$1`, [cgA.workerId])).rows[0].display_name;
  const linkTry = await call("POST", `/organizations/${orgB}/workers`, adminB.token, { workerId: cgA.workerId, displayName: "Renombrada por otra agencia", internalRole: "caregiver" });
  const after = (await q<{ display_name: string }>(`SELECT display_name FROM workers WHERE id=$1`, [cgA.workerId])).rows[0].display_name;
  results.push({ name: "admin-b: renombrar cuidadora de otra agencia", pass: before === after && denied(linkTry.status), detail: `POST /orgB/workers {workerId} -> ${linkTry.status}${before !== after ? " RENAMED" : ""}` });

  server.close();
  await pool.end();
  await db.end();
}

main()
  .then(() => {
    const gap = (r: Result) => mode === "app_runtime" && !r.pass && r.name in KNOWN_RLS_GAPS;
    const failed = results.filter((r) => !r.pass && !gap(r));
    const gaps = results.filter(gap);
    console.log(`\nMATRIZ DE AUTORIZACIÓN — modo ${mode}`);
    for (const r of results) console.log(`${r.pass ? "PASS" : gap(r) ? "GAP " : "FAIL"}  ${r.name}  [${r.detail}]${gap(r) ? `  ${KNOWN_RLS_GAPS[r.name]}` : ""}`);
    console.log(`\nAUTHZ_MATRIX mode=${mode} total=${results.length} pass=${results.length - failed.length - gaps.length} fail=${failed.length} rls_gaps=${gaps.length}`);
    if (failed.length && !reportOnly) process.exit(1);
  })
  .catch((e) => { console.error(e); process.exit(1); });
