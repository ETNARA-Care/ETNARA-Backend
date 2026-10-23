/**
 * Security & production-readiness audit (SmartMatch Gates 4-7, migration 107):
 * every fixed finding is proven here over real HTTP (server as app_runtime)
 * and with direct RLS probes. Synthetic data only.
 *
 * Disposable databases only:
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>;
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const { notifyShiftsNotEnRoute } = await import("../src/modules/verification/verification.journey.js");
  const { notifyLateShiftArrivals } = await import("../src/modules/verification/verification.arrival.js");
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
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
  }
  const org = async (name: string) =>
    (await q<{ id: string }>(`WITH o AS (INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id), f AS (INSERT INTO organization_features (organization_id,feature_code,enabled) SELECT o.id, c, true FROM o, unnest(ARRAY['SMARTMATCH','EN_CAMINO']) c) SELECT id FROM o`, [name])).rows[0].id;
  const orgA = await org(`SA A ${tag}`);
  const orgB = await org(`SA B ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  for (const o of [orgA, orgB]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'SA') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  }
  type P = { email: string; userId: string; token: string; workerId?: string; membershipId?: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `sa-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    if (roles.length) {
      const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
      await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    }
    let workerId: string | undefined; let membershipId: string | undefined;
    if (worker) {
      workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Cuidadora ${key}`])).rows[0].id;
      membershipId = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
      await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [membershipId, orgId]);
      for (let d = 0; d < 7; d++) await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,'00:00','23:59')`, [membershipId, orgId, d]);
    }
    return { email, userId, token: "", workerId, membershipId };
  }
  const A = {
    admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]),
    supervisor: await person("a-sup", orgA, ["SUPERVISOR"]),
    cg1: await person("a-cg1", orgA, ["WORKER"], true),
    cg2: await person("a-cg2", orgA, ["WORKER"], true),
    cg3: await person("a-cg3", orgA, ["WORKER"], true),
    cg4: await person("a-cg4", orgA, ["WORKER"], true),
    cg5: await person("a-cg5", orgA, ["WORKER"], true),
    family: await person("a-family", orgA, ["FAMILY"]),
    familyMuted: await person("a-family-muted", orgA, ["FAMILY"]),
    familyRevoked: await person("a-family-revoked", orgA, ["FAMILY"]),
    platform: await person("platform", orgA, []),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]), family: await person("b-family", orgB, ["FAMILY"]),
    cg: await person("b-cg", orgB, ["WORKER"], true) };
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [A.platform.userId]);
  const recipient = async (o: string, last: string) =>
    (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Sintetico',$2) RETURNING id`, [o, `${last}-${tag}`])).rows[0].id;
  const rA = await recipient(orgA, "Casa");
  const rB = await recipient(orgB, "B");
  await q(`INSERT INTO care_recipient_locations (care_recipient_id,organization_id,address_line,municipality,is_primary) VALUES ($1,$2,'Calle Luna 12','Caguas',true)`, [rA, orgA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [A.family.userId, orgA, rA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_receive_notifications) VALUES ($1,$2,$3,'hijo','active',false)`, [A.familyMuted.userId, orgA, rA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,revoked_at) VALUES ($1,$2,$3,'nieto','revoked',now())`, [A.familyRevoked.userId, orgA, rA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [B.family.userId, orgB, rB]);

  for (const [p, o] of [...Object.values(A).map((p) => [p, orgA] as const), ...Object.values(B).map((p) => [p, orgB] as const)]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${p.email} ${r.status}`);
    p.token = r.body.token;
    if (p !== A.platform) await call("POST", "/me/active-organization", p.token, { organizationId: o });
  }
  const runtime = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await runtime.connect();
  async function asRuntime<T extends pg.QueryResultRow>(userId: string, orgId: string, text: string, params: unknown[] = [], superadmin = false) {
    await runtime.query("BEGIN");
    try {
      await runtime.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`, [userId, orgId, superadmin ? "true" : "false"]);
      return (await runtime.query<T>(text, params)).rows;
    } finally { await runtime.query("ROLLBACK"); }
  }
  const tryRuntime = async (userId: string, orgId: string, text: string, params: unknown[] = []) => {
    try { await asRuntime(userId, orgId, text, params); return null; } catch (e) { return e as Error; }
  };
  const notices = async (p: P, type: string) => ((await call("GET", "/me/notifications?limit=100", p.token)).body.items ?? [] as Json[]).filter((n: Json) => n.type === type);
  const leaks = (v: unknown) => /Calle Luna|Caguas|latitude|longitude|lat"|lng"/i.test(JSON.stringify(v));
  const at = (minutesFromNow: number) => { const d = new Date(Date.now() + minutesFromNow * 60_000); d.setUTCSeconds(0, 0); return d.toISOString(); };
  /** Shift via the Turnos API, assigned to `p`; responds with `decision` unless "pending". */
  async function shift(p: P, startMin: number, durationMin: number, decision: "accepted" | "rejected" | "pending" = "accepted") {
    const s = await call("POST", `/organizations/${orgA}/shifts`, A.admin.token, { careRecipientId: rA, scheduledStart: at(startMin), scheduledEnd: at(startMin + durationMin) });
    const id = s.body.shift?.id as string;
    if (!id) throw new Error(`shift create ${s.status} ${JSON.stringify(s.body)}`);
    const asg = await call("POST", `/organizations/${orgA}/shifts/${id}/assignments`, A.admin.token, { organizationWorkerMembershipId: p.membershipId });
    if (asg.status !== 201) throw new Error(`assign ${asg.status} ${JSON.stringify(asg.body)}`);
    if (decision !== "pending") await call("POST", `/organizations/${orgA}/me/shifts/${id}/respond`, p.token, { decision, ...(decision === "rejected" ? { reason: "Prueba" } : {}) });
    return id;
  }
  const J = (id: string) => `/organizations/${orgA}/shifts/${id}/journey`;
  const familyJourney = async (p: P, id: string) =>
    ((await call("GET", `/organizations/${orgA}/care-recipients/${rA}/family-shifts`, p.token)).body.shifts ?? [] as Json[]).find((s: Json) => s.id === id);
  const rows = async (id: string, type?: string) =>
    Number((await q<{ n: string }>(`SELECT count(*) n FROM shift_journey_events WHERE shift_id=$1 ${type ? "AND event_type=$2" : ""}`, type ? [id, type] : [id])).rows[0].n);

  const touched = async (userId: string, orgId: string, text: string, params: unknown[]) => {
    try { return (await asRuntime(userId, orgId, text + " RETURNING 1", params)).length; } catch { return -1; }
  };
  try {
    // ================================================================ users (critical, pre-existing)
    const otherEmail = await touched(A.cg1.userId, orgA, `UPDATE users SET email = 'attacker@example.invalid' WHERE id = $1`, [A.admin.userId]);
    const otherPwd = await touched(A.cg1.userId, orgA, `UPDATE users SET password_hash = 'x' WHERE id = $1`, [A.admin.userId]);
    const famPwd = await touched(A.family.userId, orgA, `UPDATE users SET password_hash = 'x' WHERE id = $1`, [A.admin.userId]);
    const ownPwd = await touched(A.cg1.userId, orgA, `UPDATE users SET password_hash = password_hash WHERE id = $1`, [A.cg1.userId]);
    const ownEmail = await touched(A.cg1.userId, orgA, `UPDATE users SET email = email WHERE id = $1`, [A.cg1.userId]);
    const insertUser = await touched(A.admin.userId, orgA, `INSERT INTO users (email, password_hash, status) VALUES ('x@example.invalid','x','active')`, []);
    check("U1 no member can change another user's email or password at DB level (caregiver, relative)", otherEmail <= 0 && otherPwd <= 0 && famPwd <= 0, `${otherEmail},${otherPwd},${famPwd}`);
    check("U2 own password still updatable (reset flow); e-mail and user creation not writable by the API role", ownPwd === 1 && ownEmail === -1 && insertUser === -1, `${ownPwd},${ownEmail},${insertUser}`);
    const relogin = await call("POST", "/auth/login", "", { email: A.admin.email, password });
    check("U3 the admin can still log in (account intact)", relogin.status === 200, `status=${relogin.status}`);

    // ================================================================ shifts (high)
    const sMine = await shift(A.cg1, 300, 60);
    const patchTimes = await call("PATCH", `/organizations/${orgA}/shifts/${sMine}`, A.cg1.token, { scheduledEnd: at(60 * 24 * 365) });
    const patchStatus = await call("PATCH", `/organizations/${orgA}/shifts/${sMine}`, A.cg1.token, { status: "completed" });
    check("S1 a caregiver cannot edit their shift's times or status over HTTP (403)", patchTimes.status === 403 && patchStatus.status === 403, `${patchTimes.status},${patchStatus.status}`);
    const rOther = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Otra','Persona-${tag}') RETURNING id`, [orgA])).rows[0].id;
    const dbTimes = await touched(A.cg1.userId, orgA, `UPDATE shifts SET scheduled_end = scheduled_end + interval '365 days' WHERE id = $1`, [sMine]);
    const dbPerson = await touched(A.cg1.userId, orgA, `UPDATE shifts SET care_recipient_id = $2, service_location_id = NULL WHERE id = $1`, [sMine, rOther]);
    const dbDelete = await touched(A.cg1.userId, orgA, `DELETE FROM shifts WHERE id = $1`, [sMine]);
    check("S2 at DB level a caregiver cannot move, re-point or delete their shift", dbTimes <= 0 && dbPerson <= 0 && dbDelete <= 0, `${dbTimes},${dbPerson},${dbDelete}`);
    const accept = await call("GET", `/organizations/${orgA}/me/shifts`, A.cg1.token);
    check("S3 the caregiver still sees the shift (read unchanged)", ((accept.body.shifts ?? []) as Json[]).some((x) => x.id === sMine), `status=${accept.status}`);
    const sCancel = await shift(A.cg2, 400, 60);
    await call("POST", `/organizations/${orgA}/shifts/${sCancel}/cancel`, A.admin.token, {});
    const revive = await call("PATCH", `/organizations/${orgA}/shifts/${sCancel}`, A.admin.token, { status: "confirmed" });
    check("S4 a cancelled shift can never be revived, not even by a manager", revive.status === 409 && revive.body.error === "SHIFT_STATUS_CANCELLED_IS_FINAL", `${revive.status} ${revive.body.error}`);
    const sGo = await shift(A.cg3, 45, 60);
    await call("POST", `/organizations/${orgA}/shifts/${sGo}/journey/en-route`, A.cg3.token, {});
    const move = await call("PATCH", `/organizations/${orgA}/shifts/${sGo}`, A.admin.token, { scheduledStart: at(60 * 24), scheduledEnd: at(60 * 25) });
    check("S5 a visit whose caregiver is on the way cannot be rescheduled (cancel and recreate)", move.status === 409 && move.body.error === "SHIFT_SCHEDULE_LOCKED", `${move.status} ${move.body.error}`);

    // ================================================================ family relationships (medium)
    const rB2 = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Tercera','Persona-${tag}') RETURNING id`, [orgA])).rows[0].id;
    const otherFam = await person("a-other-family", orgA, ["FAMILY"]);
    await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hijo','active')`, [otherFam.userId, orgA, rB2]);
    const famSees = (await asRuntime<{ care_recipient_id: string }>(A.family.userId, orgA, `SELECT care_recipient_id FROM family_relationships`)).map((r) => r.care_recipient_id);
    check("F1 a relative no longer reads other families' relationships (only those of their own person)", famSees.length >= 1 && famSees.every((id) => id === rA), famSees.join(","));
    const cgSees = (await asRuntime<{ care_recipient_id: string }>(A.cg1.userId, orgA, `SELECT care_recipient_id FROM family_relationships`)).map((r) => r.care_recipient_id);
    const admSees = (await asRuntime<{ id: string }>(A.admin.userId, orgA, `SELECT id FROM family_relationships`)).length;
    check("F2 a caregiver reads only relatives of people they serve; managers read all", cgSees.every((id) => id === rA) && !cgSees.includes(rB2) && admSees >= 4, `${cgSees.length},${admSees}`);
    const selfLink = await touched(otherFam.userId, orgA, `INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'x','active')`, [otherFam.userId, orgA, rA]);
    check("F3 a relative can never link themself to another person", selfLink <= 0, `${selfLink}`);

    // ================================================================ Tower / platform (medium)
    const towerNotices = await asRuntime(A.platform.userId, orgA, `SELECT id FROM notifications WHERE user_id <> $1`, [A.platform.userId], true);
    const towerSm = await asRuntime(A.platform.userId, orgA, `SELECT 1 FROM smartmatch_opportunities UNION ALL SELECT 1 FROM smartmatch_applications`, [], true);
    const denies = (await q(`SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE p.polname = 'platform_phi_deny' AND NOT p.polpermissive
      AND c.relname IN ('notifications','smartmatch_opportunities','smartmatch_applications','smartmatch_application_events','smartmatch_location_preferences')`)).rowCount;
    check("T1 ETNARA central / Tower reads no agency notification or SmartMatch row (restrictive deny on 5 tables)", towerNotices.length === 0 && towerSm.length === 0 && denies === 5, `${towerNotices.length},${towerSm.length},${denies}`);

    // ================================================================ background jobs (low)
    const famJob = await tryRuntime(A.family.userId, orgA, `SELECT app_notify_shifts_not_en_route()`);
    const famJob2 = await tryRuntime(A.family.userId, orgA, `SELECT app_notify_late_shift_arrivals()`);
    const workerJob = await notifyShiftsNotEnRoute().then(() => true, () => false);
    const workerJob2 = await notifyLateShiftArrivals().then(() => true, () => false);
    check("J1 cross-agency jobs run only from the API worker, never from a user session", famJob !== null && famJob2 !== null && workerJob && workerJob2, famJob?.message.slice(0, 30));

    // ================================================================ arrivals (medium/low)
    const sFuture = await shift(A.cg4, 60 * 24 * 3, 60);
    const tooEarly = await call("POST", `/organizations/${orgA}/shifts/${sFuture}/arrival`, A.cg4.token, {});
    check("A1 «Llegué» is refused days before the visit (window: 2 h before start to the end)", tooEarly.status === 409 && tooEarly.body.error === "ARRIVAL_OUTSIDE_WINDOW", `${tooEarly.status} ${tooEarly.body.error}`);
    const sNow = await shift(A.cg5, 20, 60);
    const burst = await Promise.all(Array.from({ length: 4 }, () => call("POST", `/organizations/${orgA}/shifts/${sNow}/arrival`, A.cg5.token, { clientEventId: randomUUID() })));
    const stored = Number((await q<{ n: string }>(`SELECT count(*) n FROM shift_arrivals WHERE shift_id=$1`, [sNow])).rows[0].n);
    check("A2 four simultaneous «Llegué»: one stored, no server error (409/200 for the rest)", stored === 1 && burst.every((r) => [200, 201, 409].includes(r.status)) && burst.filter((r) => r.status === 201).length === 1, burst.map((r) => r.status).join(","));
    const cgNote = await q(`UPDATE shift_arrivals SET reviewed_by_user_id=$2, reviewed_at=now(), review_note='Nota interna' WHERE shift_id=$1`, [sNow, A.admin.userId]).then(() => call("GET", `/organizations/${orgA}/shifts/${sNow}/visit-verification`, A.cg5.token));
    const admNote = await call("GET", `/organizations/${orgA}/shifts/${sNow}/visit-verification`, A.admin.token);
    check("A3 the agency's review note is not returned to the caregiver", cgNote.body.arrivals?.[0]?.reviewNote === null && admNote.body.arrivals?.[0]?.reviewNote === "Nota interna", `${cgNote.body.arrivals?.[0]?.reviewNote}`);

    // ================================================================ addresses (medium)
    const L = `/organizations/${orgA}/care-recipients/${rA}`;
    const legacy0 = await call("PUT", `${L}/location`, A.admin.token, { addressLine: "Calle Luna 12", municipality: "Caguas", latitude: 18.2341, longitude: -66.0485 });
    const primary = (await q<{ id: string }>(`SELECT id FROM care_recipient_locations WHERE care_recipient_id=$1 AND is_primary`, [rA])).rows[0].id;
    await call("POST", `${L}/service-locations/${primary}/confirm-gps`, A.admin.token, { latitude: 18.2341, longitude: -66.0485, confirm: true });
    const legacyNotes = await call("PUT", `${L}/location`, A.admin.token, { accessNotes: "Portón azul" });
    const afterNotes = (await q<{ latitude: string; gps_confirmed_at: Date | null }>(`SELECT latitude, gps_confirmed_at FROM care_recipient_locations WHERE id=$1`, [primary])).rows[0];
    check("L1 the old address form cannot wipe a confirmed GPS point by omitting the coordinates", legacy0.status === 200 && legacyNotes.status === 200 && Number(afterNotes.latitude) === 18.2341 && afterNotes.gps_confirmed_at !== null, JSON.stringify(afterNotes));
    const pinned = (await q<{ n: string }>(`SELECT count(*) n FROM shifts WHERE care_recipient_id=$1 AND service_location_id IS NULL AND status IN ('unassigned','confirmed') AND scheduled_end > now()`, [rA])).rows[0].n;
    const sUpcoming = (await q<{ id: string; service_location_id: string }>(`SELECT id, service_location_id FROM shifts WHERE id=$1`, [sMine])).rows[0];
    const alt = await call("POST", `${L}/service-locations`, A.admin.token, { label: "Casa nueva", addressLine: "Calle Sol 4", municipality: "Cidra", makePrimary: true });
    const sAfter = (await q<{ service_location_id: string }>(`SELECT service_location_id FROM shifts WHERE id=$1`, [sMine])).rows[0];
    check("L2 changing the primary address never moves upcoming shifts silently (they stay pinned)",
      Number(pinned) === 0 && sUpcoming.service_location_id === primary && alt.status === 201 && sAfter.service_location_id === primary, `null=${pinned} ${sAfter.service_location_id === primary}`);
    const evUpdate = await q(`UPDATE care_recipient_location_events SET event_type = event_type WHERE location_id=$1`, [primary]).then(() => "allowed", (e) => (e as Error).message);
    check("L3 address history is append-only even for the owner role", /HISTORY_APPEND_ONLY/.test(evUpdate), evUpdate.slice(0, 40));

    // ================================================================ SmartMatch (medium)
    const S = `/organizations/${orgA}/smartmatch`;
    const day = new Date(Date.now() + 9 * 86400e3); day.setUTCHours(14, 0, 0, 0);
    const opp = await call("POST", `${S}/opportunities`, A.admin.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Acompañante",
      startsAt: day.toISOString(), endsAt: new Date(day.getTime() + 4 * 3600e3).toISOString() });
    const oppId = opp.body.opportunity?.id;
    const admin2 = await person("a-admin2", orgA, ["ORGANIZATION_ADMIN"]);
    admin2.token = (await call("POST", "/auth/login", "", { email: admin2.email, password })).body.token;
    await call("POST", "/me/active-organization", admin2.token, { organizationId: orgA });
    await call("POST", `${S}/opportunities/${oppId}/publish`, admin2.token, {});
    const app = await call("POST", `${S}/opportunities/${oppId}/applications`, A.cg2.token, { consent: true, consentVersion: "smartmatch-consent-v1" });
    await call("POST", `${S}/applications/${app.body.application?.id}/decision`, A.admin.token, { decision: "APPROVE", confirm: true });
    const made = await call("POST", `${S}/opportunities/${oppId}/shift`, A.admin.token, { careRecipientId: rA, serviceLocationId: primary });
    const linked = made.body.shift?.id;
    const blocked = await call("POST", `${S}/opportunities/${oppId}/cancel`, A.admin.token, { reason: "NO_LONGER_NEEDED" });
    await call("POST", `/organizations/${orgA}/me/shifts/${linked}/respond`, A.cg2.token, { decision: "rejected", reason: "No puedo" });
    const freed = await call("POST", `${S}/opportunities/${oppId}/cancel`, A.admin.token, { reason: "NO_LONGER_NEEDED" });
    check("M1 a FILLED opportunity is pinned while its shift has a caregiver, and can be cancelled once the caregiver declined",
      made.status === 201 && blocked.status === 409 && freed.status === 200, `${made.status},${blocked.status},${freed.status} ${freed.body.error ?? ""}`);

    // ================================================================ alerts (low)
    const sSoon = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status,service_location_id) VALUES ($1,$2,now()+interval '20 minutes',now()+interval '80 minutes','confirmed',$3) RETURNING id`, [orgA, rA, primary])).rows[0].id;
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,response_status,responded_at) VALUES ($1,$2,$3,$4,'accepted',now())`, [orgA, sSoon, A.cg4.membershipId, rA]);
    await notifyShiftsNotEnRoute();
    const open1 = Number((await q<{ n: string }>(`SELECT count(*) n FROM notifications WHERE related_entity_id=$1 AND notification_type='SHIFT_NOT_EN_ROUTE' AND read_at IS NULL`, [sSoon])).rows[0].n);
    await call("POST", `/organizations/${orgA}/shifts/${sSoon}/cancel`, A.admin.token, {});
    const open2 = Number((await q<{ n: string }>(`SELECT count(*) n FROM notifications WHERE related_entity_id=$1 AND notification_type='SHIFT_NOT_EN_ROUTE' AND read_at IS NULL`, [sSoon])).rows[0].n);
    check("N1 cancelling the visit closes its open «sin salida» alerts", open1 >= 1 && open2 === 0, `${open1}->${open2}`);

    // ================================================================ rate limit (low)
    const many = await Promise.all(Array.from({ length: 130 }, () => call("POST", `${S}/opportunities/${randomUUID()}/publish`, A.family.token, {})));
    check("R1 new write endpoints are rate-limited per session (429 after 120/min)", many.some((r) => r.status === 429), `429s=${many.filter((r) => r.status === 429).length}`);
  } finally {
    await runtime.end();
    server.close();
    await pool.end();
    await db.end();
  }

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nSecurity audit hardening: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
