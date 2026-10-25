/**
 * Gate 7 «ETNARA En Camino»: declared departure and delays, derived journey
 * state, family view and notices, agency alerts and «Hoy en ruta», over real
 * HTTP with the server connected as app_runtime, plus direct RLS probes.
 * Synthetic data only. No GPS, no tracking, no estimated times.
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
  const orgA = await org(`G7 A ${tag}`);
  const orgB = await org(`G7 B ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  for (const o of [orgA, orgB]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'G7') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  }
  type P = { email: string; userId: string; token: string; workerId?: string; membershipId?: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `g7-${key}-${tag}@example.invalid`;
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

  try {
    // ================================================================ J: declaring the departure
    const sMain = await shift(A.cg1, 60, 120);
    const before = await call("GET", J(sMain), A.cg1.token);
    check("J1 accepted shift starts as ASSIGNED (caregiver view)", before.status === 200 && before.body.journey?.state === "ASSIGNED", `${before.status} ${before.body.journey?.state}`);
    const go = await call("POST", `${J(sMain)}/en-route`, A.cg1.token, { clientEventId: randomUUID() });
    check("J2 «Voy en camino» → EN_ROUTE with the declared time", go.status === 201 && go.body.journey?.state === "EN_ROUTE" && !!go.body.journey?.enRouteAt, `${go.status} ${JSON.stringify(go.body).slice(0, 80)}`);
    const burst = await Promise.all(Array.from({ length: 5 }, () => call("POST", `${J(sMain)}/en-route`, A.cg1.token, { clientEventId: randomUUID() })));
    check("J3 double taps / concurrent requests are idempotent: one departure only", burst.every((r) => r.status === 200) && (await rows(sMain, "EN_ROUTE")) === 1, burst.map((r) => r.status).join(","));
    const famEnRoute = await notices(A.family, "FAMILY_CAREGIVER_EN_ROUTE");
    check("J4 the authorised relative is notified once, without address or location",
      famEnRoute.length === 1 && !leaks(famEnRoute), `n=${famEnRoute.length}`);
    const others = [(await notices(A.familyMuted, "FAMILY_CAREGIVER_EN_ROUTE")).length, (await notices(A.familyRevoked, "FAMILY_CAREGIVER_EN_ROUTE")).length,
      (await notices(B.family, "FAMILY_CAREGIVER_EN_ROUTE")).length];
    check("J5 no notice for a relative with notifications off, a revoked relative, or another agency", others.every((n) => n === 0), others.join(","));
    const fj = await familyJourney(A.family, sMain);
    check("J6 family sees «En camino» with its time, never a location, ETA or review flag",
      fj?.journey?.state === "EN_ROUTE" && !!fj.journey.enRouteAt && !("arrivalNeedsReview" in fj.journey) && !leaks(fj.journey) && !/eta|estimated/i.test(JSON.stringify(fj.journey)),
      JSON.stringify(fj?.journey ?? null).slice(0, 120));
    const revokedView = await call("GET", `/organizations/${orgA}/care-recipients/${rA}/family-shifts`, A.familyRevoked.token);
    check("J7 a revoked relative cannot read the journey", revokedView.status !== 200 || !(revokedView.body.shifts ?? []).length, `status=${revokedView.status}`);

    // ================================================================ W: who and when
    const other = await call("POST", `${J(sMain)}/en-route`, A.cg2.token, {});
    const mgr = await call("POST", `${J(sMain)}/en-route`, A.admin.token, {});
    const cross = await call("POST", `/organizations/${orgB}/shifts/${sMain}/journey/en-route`, B.cg.token, {});
    check("W1 only the assigned caregiver declares: other caregiver, manager and another agency refused",
      other.status === 404 && [403, 404].includes(mgr.status) && cross.status === 404, `${other.status},${mgr.status},${cross.status}`);
    const sLater = await shift(A.cg2, 180, 60);
    const early = await call("POST", `${J(sLater)}/en-route`, A.cg2.token, {});
    const sPast = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '2 hours',now()+interval '30 minutes','confirmed') RETURNING id`, [orgA, rA])).rows[0].id;
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,response_status,responded_at) VALUES ($1,$2,$3,$4,'accepted',now())`, [orgA, sPast, A.cg2.membershipId, rA]);
    const late = await call("POST", `${J(sPast)}/en-route`, A.cg2.token, {});
    check("W2 window: refused 3 h before and 2 h after the start (allowed from -2 h to +1 h)",
      early.status === 409 && early.body.error === "JOURNEY_OUTSIDE_WINDOW" && late.status === 409 && late.body.error === "JOURNEY_OUTSIDE_WINDOW", `${early.status} ${early.body.error}, ${late.status} ${late.body.error}`);
    const sPending = await shift(A.cg3, 30, 60, "pending");
    const pend = await call("POST", `${J(sPending)}/en-route`, A.cg3.token, {});
    const sRejected = await shift(A.cg4, 45, 60, "rejected");
    const rej = await call("POST", `${J(sRejected)}/en-route`, A.cg4.token, {});
    check("W3 not before accepting; never after rejecting (no event, no family notice)",
      pend.status === 409 && pend.body.error === "JOURNEY_ASSIGNMENT_NOT_ACCEPTED" && [404, 409].includes(rej.status) && (await rows(sPending)) + (await rows(sRejected)) === 0,
      `${pend.status} ${pend.body.error}, ${rej.status}`);
    const offlineAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const sOffline = await shift(A.cg5, 50, 60);
    const off = await call("POST", `${J(sOffline)}/en-route`, A.cg5.token, { clientEventId: randomUUID(), occurredAt: offlineAt, recordedOffline: true });
    const tooOld = await call("POST", `${J(sOffline)}/delay`, A.cg5.token, { minutes: 10, reason: "TRAFFIC", clientEventId: randomUUID() });
    check("W4 an offline departure keeps the device time (within limits)",
      off.status === 201 && Math.abs(new Date(off.body.journey?.enRouteAt).getTime() - new Date(offlineAt).getTime()) < 1500 && tooOld.status === 201, `${off.status}`);

    // ================================================================ D: delays
    const bad = await call("POST", `${J(sMain)}/delay`, A.cg1.token, { minutes: 20, reason: "TRAFFIC" });
    const freeText = await call("POST", `${J(sMain)}/delay`, A.cg1.token, { minutes: 15, reason: "TRAFFIC", note: "texto libre" });
    const badReason = await call("POST", `${J(sMain)}/delay`, A.cg1.token, { minutes: 15, reason: "Me quedé dormida" });
    check("D1 delay only from fixed minutes and reason categories; no free text", bad.status === 400 && freeText.status === 400 && badReason.status === 400, `${bad.status},${freeText.status},${badReason.status}`);
    const famDelayBase = (await notices(A.family, "FAMILY_CAREGIVER_DELAYED")).length;
    const d15 = await call("POST", `${J(sMain)}/delay`, A.cg1.token, { minutes: 15, reason: "TRAFFIC", clientEventId: randomUUID() });
    const famDelay1 = await notices(A.family, "FAMILY_CAREGIVER_DELAYED");
    const mgrDelay1 = await notices(A.admin, "SHIFT_DELAY_REPORTED");
    check("D2 a 15-min delay: relative notified, agency not alerted (< 30 min)",
      d15.status === 201 && d15.body.journey?.delay?.minutes === 15 && famDelay1.length === famDelayBase + 1 && mgrDelay1.length === 0 && !leaks(famDelay1), `${d15.status} fam=${famDelay1.length} mgr=${mgrDelay1.length}`);
    const same = await call("POST", `${J(sMain)}/delay`, A.cg1.token, { minutes: 15, reason: "TRAFFIC", clientEventId: randomUUID() });
    check("D3 the same delay twice is refused (no duplicate notices)", same.status === 409 && same.body.error === "JOURNEY_DELAY_UNCHANGED", `${same.status} ${same.body.error}`);
    const d30 = await call("POST", `${J(sMain)}/delay`, A.cg1.token, { minutes: 30, reason: "TRAFFIC", clientEventId: randomUUID() });
    const d45 = await call("POST", `${J(sMain)}/delay`, A.cg1.token, { minutes: 45, reason: "TRANSPORT", clientEventId: randomUUID() });
    const mgrDelay = [(await notices(A.admin, "SHIFT_DELAY_REPORTED")).length, (await notices(A.supervisor, "SHIFT_DELAY_REPORTED")).length];
    const famDelays = (await notices(A.family, "FAMILY_CAREGIVER_DELAYED")).length;
    check("D4 delay >= 30 alerts admin and supervisor once per shift; each new delay informs the relative",
      d30.status === 201 && d45.status === 201 && mgrDelay.every((n) => n === 1) && famDelays === famDelayBase + 3, `mgr=${mgrDelay} fam=${famDelays}`);
    const d4th = await call("POST", `${J(sMain)}/delay`, A.cg1.token, { minutes: 60, reason: "OTHER", clientEventId: randomUUID() });
    check("D5 at most three delay reports per shift", d4th.status === 409 && d4th.body.error === "JOURNEY_DELAY_LIMIT", `${d4th.status} ${d4th.body.error}`);
    const fjDelay = await familyJourney(A.family, sMain);
    check("D6 family sees the latest declared delay (minutes + category), not an estimated time",
      fjDelay?.journey?.delay?.minutes === 45 && fjDelay.journey.delay.reason === "TRANSPORT" && !("eta" in fjDelay.journey), JSON.stringify(fjDelay?.journey?.delay ?? null));

    // ================================================================ S: arrival, start, finish
    const arrive = await call("POST", `/organizations/${orgA}/shifts/${sMain}/arrival`, A.cg1.token, { clientEventId: randomUUID() });
    const afterArrive = await call("GET", J(sMain), A.admin.token);
    const fjArr = await familyJourney(A.family, sMain);
    check("S1 «Llegué» stops «En camino» automatically (ARRIVED)",
      arrive.status === 201 && afterArrive.body.journey?.state === "ARRIVED" && fjArr?.journey?.state === "ARRIVED", `${arrive.status} ${afterArrive.body.journey?.state}`);
    check("S2 arrival needing review: the agency sees the flag, the family only «Llegada registrada»",
      afterArrive.body.journey?.arrivalNeedsReview === true && fjArr?.journey && !("arrivalNeedsReview" in fjArr.journey), JSON.stringify(fjArr?.journey ?? null).slice(0, 100));
    const afterGo = await call("POST", `${J(sMain)}/en-route`, A.cg1.token, { clientEventId: randomUUID() });
    const afterDelay = await call("POST", `${J(sMain)}/delay`, A.cg1.token, { minutes: 10, reason: "OTHER" });
    check("S3 after arriving nothing more can be declared",
      afterGo.status === 200 && afterDelay.status === 409 && afterDelay.body.error === "JOURNEY_ALREADY_ARRIVED", `${afterGo.status} ${afterDelay.status} ${afterDelay.body.error}`);
    const famArr = await notices(A.family, "FAMILY_CAREGIVER_ARRIVED");
    check("S4 relative notified «Llegó» once, with no review detail", famArr.length === 1 && !/review|revis|FAR|lejos/i.test(JSON.stringify(famArr)), `n=${famArr.length}`);
    const cin = await call("POST", `/organizations/${orgA}/shifts/${sMain}/check-in`, A.cg1.token, { verificationMethodCode: "CAREGIVER_SESSION" });
    const cout = await call("POST", `/organizations/${orgA}/shifts/${sMain}/check-out`, A.cg1.token, {});
    const endState = await call("GET", J(sMain), A.admin.token);
    const famStart = (await notices(A.family, "SHIFT_STARTED")).length;
    const famEnd = (await notices(A.family, "SHIFT_COMPLETED")).length;
    check("S5 check-in → IN_SERVICE, check-out → COMPLETED; family told once each through the existing start/finish notices",
      cin.status === 201 && [200, 201].includes(cout.status) && endState.body.journey?.state === "COMPLETED" && famStart === 1 && famEnd === 1, `${cin.status},${cout.status},${endState.body.journey?.state},${famStart},${famEnd}`);
    const hist = (endState.body.history ?? []) as Json[];
    const kinds = hist.map((h) => h.kind);
    const ordered = hist.every((h, i) => i === 0 || new Date(hist[i - 1].at).getTime() <= new Date(h.at).getTime());
    check("S6 auditable operational history for the agency, in order",
      ["ASSIGNED", "ACCEPTED", "EN_ROUTE", "DELAY_REPORTED", "ARRIVED", "STARTED", "FINISHED"].every((k) => kinds.includes(k)) && ordered && kinds.filter((k) => k === "DELAY_REPORTED").length === 3,
      kinds.join(","));
    const cgView = await call("GET", J(sMain), A.cg1.token);
    const famDirect = await call("GET", J(sMain), A.family.token);
    check("S7 the history is for the agency only (caregiver gets the state; family uses its own view)",
      cgView.status === 200 && !("history" in cgView.body) && famDirect.status === 404, `${cgView.status},${famDirect.status}`);

    // ================================================================ C: cancellation
    const sCancel = await shift(A.cg3, 100, 60);
    await call("POST", `${J(sCancel)}/en-route`, A.cg3.token, {});
    const famBeforeCancel = (await notices(A.family, "FAMILY_CAREGIVER_EN_ROUTE")).length;
    const cancel = await call("POST", `/organizations/${orgA}/shifts/${sCancel}/cancel`, A.admin.token, {});
    const cState = await call("GET", J(sCancel), A.admin.token);
    const cDelay = await call("POST", `${J(sCancel)}/delay`, A.cg3.token, { minutes: 15, reason: "TRAFFIC" });
    const famAfterCancel = (await notices(A.family, "FAMILY_CAREGIVER_DELAYED")).length;
    check("C1 cancelling stops «En camino»; nothing more can be declared nor notified",
      cancel.status === 200 && cState.body.journey?.state === "CANCELLED" && cState.body.journey?.delay === null && [404, 409].includes(cDelay.status) && famAfterCancel === famDelays,
      `${cancel.status} ${cState.body.journey?.state} ${cDelay.status}`);
    const fjCancel = await familyJourney(A.family, sCancel);
    check("C2 family sees the cancelled visit as CANCELLED (not «en camino»)", fjCancel?.journey?.state === "CANCELLED" && famBeforeCancel >= 2, fjCancel?.journey?.state);

    // ================================================================ A: agency alerts and «Hoy en ruta»
    const sSoon = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()+interval '20 minutes',now()+interval '80 minutes','confirmed') RETURNING id`, [orgA, rA])).rows[0].id;
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,response_status,responded_at) VALUES ($1,$2,$3,$4,'accepted',now())`, [orgA, sSoon, A.cg4.membershipId, rA]);
    await notifyShiftsNotEnRoute(); await notifyShiftsNotEnRoute();
    const soonAlerts = (await notices(A.admin, "SHIFT_NOT_EN_ROUTE")).filter((n: Json) => JSON.stringify(n).includes(sSoon));
    const offlineAlerts = (await notices(A.admin, "SHIFT_NOT_EN_ROUTE")).filter((n: Json) => JSON.stringify(n).includes(sOffline));
    check("A1 preventive alert 30 min before when no departure was declared: once, never for a caregiver already on the way",
      soonAlerts.length === 1 && offlineAlerts.length === 0, `soon=${soonAlerts.length} declared=${offlineAlerts.length}`);
    await call("POST", `${J(sSoon)}/en-route`, A.cg4.token, {});
    const resolved = (await notices(A.admin, "SHIFT_NOT_EN_ROUTE")).filter((n: Json) => JSON.stringify(n).includes(sSoon));
    check("A2 the preventive alert resolves itself when the caregiver declares the departure", resolved.length === 1 && !!(resolved[0].readAt ?? resolved[0].read_at), JSON.stringify(resolved[0] ?? {}).slice(0, 120));
    const today = await call("GET", `/organizations/${orgA}/operations/journeys`, A.admin.token);
    const byId = new Map(((today.body.journeys ?? []) as Json[]).map((j) => [j.shiftId, j]));
    const pastRow = byId.get(sPast);
    // «Hoy en ruta» lists the visits that overlap the Puerto Rico day (UTC-4, no DST). Shifts created
    // «in 20/60 minutes» fall on the next day when the run starts late in the evening, so whether each
    // one belongs to today is computed here, independently of the module, and both cases are checked.
    const PR_OFFSET_MS = 4 * 3_600_000;
    const dayStart = Math.floor((Date.now() - PR_OFFSET_MS) / 86_400_000) * 86_400_000 + PR_OFFSET_MS;
    const dayEnd = dayStart + 86_400_000;
    const shiftWindow = async (id: string) => (await q<{ s: Date; e: Date }>(`SELECT scheduled_start s, scheduled_end e FROM shifts WHERE id=$1`, [id])).rows[0];
    const listedAsExpected = async (id: string, state: string) => {
      const w = await shiftWindow(id);
      const isToday = w.s.getTime() < dayEnd && w.e.getTime() > dayStart;
      return isToday ? byId.get(id)?.journey?.state === state : !byId.has(id);
    };
    const mainOk = await listedAsExpected(sMain, "COMPLETED");
    const soonOk = await listedAsExpected(sSoon, "EN_ROUTE");
    check("A3 «Hoy en ruta»: today's visits with state and risks (late arrival flagged as a risk); next-day visits not listed",
      today.status === 200 && mainOk && soonOk && (pastRow?.risks ?? []).includes("LATE_ARRIVAL"),
      `${today.status} n=${byId.size} main=${mainOk} soon=${soonOk} past=${JSON.stringify(pastRow?.risks)}`);
    const todayCg = await call("GET", `/organizations/${orgA}/operations/journeys`, A.cg1.token);
    const todayFam = await call("GET", `/organizations/${orgA}/operations/journeys`, A.family.token);
    const todayB = await call("GET", `/organizations/${orgB}/operations/journeys`, B.admin.token);
    check("A4 «Hoy en ruta» is for managers only and per agency",
      todayCg.status === 403 && todayFam.status === 403 && today.status === 200 && !((todayB.body.journeys ?? []) as Json[]).some((j) => byId.has(j.shiftId)),
      `${todayCg.status},${todayFam.status},${todayB.status}`);

    // ================================================================ R: data protection
    const cols = (await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='shift_journey_events'`)).rows.map((r) => r.column_name);
    check("R1 no coordinate or route column exists", !cols.some((c) => /lat|lng|lon|route|position|location|eta/.test(c)), cols.join(","));
    const upd = await tryRuntime(A.admin.userId, orgA, `UPDATE shift_journey_events SET occurred_at = now() WHERE shift_id=$1`, [sMain]);
    const del = await tryRuntime(A.admin.userId, orgA, `DELETE FROM shift_journey_events WHERE shift_id=$1`, [sMain]);
    let superUpd = false;
    try { await q(`UPDATE shift_journey_events SET occurred_at = now() WHERE shift_id=$1`, [sMain]); } catch { superUpd = true; }
    check("R2 events are append-only (no update or delete, not even by the owner role)", upd !== null && del !== null && superUpd, `${upd?.message.slice(0, 30)} / ${del?.message.slice(0, 30)}`);
    const famRows = await asRuntime(A.family.userId, orgA, `SELECT id FROM shift_journey_events`);
    const bRows = await asRuntime(B.admin.userId, orgB, `SELECT id FROM shift_journey_events WHERE organization_id=$1`, [orgA]);
    const bState = await asRuntime(B.admin.userId, orgB, `SELECT * FROM app_shift_journey_state($1)`, [sMain]);
    check("R3 families never read the table; another agency reads neither events nor state", famRows.length === 0 && bRows.length === 0 && bState.length === 0, `${famRows.length},${bRows.length},${bState.length}`);
    const towerRows = await asRuntime(A.platform.userId, orgA, `SELECT id FROM shift_journey_events`, [], true);
    const towerState = await asRuntime(A.platform.userId, orgA, `SELECT * FROM app_shift_journey_state($1)`, [sMain], true);
    const forced = (await q(`SELECT 1 FROM pg_class WHERE relname='shift_journey_events' AND relforcerowsecurity`)).rowCount;
    check("R4 ETNARA central / Tower reads nothing; FORCE row level security", towerRows.length === 0 && towerState.length === 0 && forced === 1);
    const forged = await tryRuntime(A.cg2.userId, orgA,
      `INSERT INTO shift_journey_events (organization_id,shift_id,organization_worker_membership_id,recorded_by_user_id,event_type) VALUES ($1,$2,$3,$4,'EN_ROUTE')`,
      [orgA, sLater, A.cg1.membershipId, A.cg2.userId]);
    const famInsert = await tryRuntime(A.family.userId, orgA,
      `INSERT INTO shift_journey_events (organization_id,shift_id,organization_worker_membership_id,recorded_by_user_id,event_type) VALUES ($1,$2,$3,$4,'EN_ROUTE')`,
      [orgA, sLater, A.cg2.membershipId, A.family.userId]);
    check("R5 nobody can write a departure for someone else (forged membership, relative)", forged !== null && famInsert !== null);
    const allFamily = await call("GET", "/me/notifications?limit=100", A.family.token);
    check("R6 no family notification carries an address, coordinates or caregiver location", !leaks(allFamily.body), "");
  } finally {
    await runtime.end();
    server.close();
    await pool.end();
    await db.end();
  }

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nGate 7 journey: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
