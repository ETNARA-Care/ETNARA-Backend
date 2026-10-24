/**
 * Check-out ("Terminar turno") end to end over HTTP as app_runtime, synthetic data only.
 *
 * Incident 24-oct-2026: four HTTP 500 in a row on POST .../check-out, every
 * retry failing the same way. Cause: a visit open for more than 48 h made
 * app_record_timesheet_from_checkout RAISE 'invalid timesheet window' and the
 * whole check-out rolled back (fixed by migration 113).
 *
 * Covers regular Turnos shifts and shifts created from SmartMatch, the 48 h
 * boundary, offline retries, the supervisor override, rejection paths, and the
 * safe 500 contract. Creates its own synthetic agency (.invalid e-mails).
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });
const HOUR = 3600 * 1000;

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
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);

  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed };
  }

  // Synthetic agency with SmartMatch on, BLS required.
  const orgId = (await q<{ id: string }>(`WITH o AS (INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id), f AS (INSERT INTO organization_features (organization_id,feature_code,enabled) SELECT o.id, c, true FROM o, unnest(ARRAY['SMARTMATCH','EN_CAMINO']) c) SELECT id FROM o`, [`CO ${tag}`])).rows[0].id;
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'CO') RETURNING id`, [orgId])).rows[0].id;
  await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  type P = { email: string; userId: string; token: string; owm?: string };
  async function person(key: string, roles: string[], worker = false): Promise<P> {
    const email = `co-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let owm: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Synthetic ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
      await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [owm, orgId]);
      for (let d = 0; d < 7; d++) await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,'06:00','22:00')`, [owm, orgId, d]);
    }
    return { email, userId, token: "", owm };
  }
  const adm = await person("admin", ["ORGANIZATION_ADMIN"]);
  const sup = await person("supervisor", ["SUPERVISOR"]);
  const cg = await person("cg", ["WORKER"], true);
  for (const p of [adm, sup, cg]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${p.email} ${r.status}`);
    p.token = r.body.token;
    await call("POST", "/me/active-organization", p.token, { organizationId: orgId });
  }
  const recipientId = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Sintetico',$2,'active') RETURNING id`, [orgId, `R-${tag}`])).rows[0].id;
  const O = `/organizations/${orgId}`;

  // Each visit gets its own day far away from the others (no schedule conflicts).
  let day = 3;
  async function regularShift() {
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day++, 14);
    const s = await call("POST", `${O}/shifts`, adm.token, { careRecipientId: recipientId, scheduledStart: new Date(start).toISOString(), scheduledEnd: new Date(start + 3 * HOUR).toISOString() });
    if (s.status !== 201) throw new Error(`shift ${s.status} ${JSON.stringify(s.body)}`);
    const id = s.body.shift.id as string;
    const a = await call("POST", `${O}/shifts/${id}/assignments`, adm.token, { organizationWorkerMembershipId: cg.owm });
    if (a.status !== 201) throw new Error(`assign ${a.status} ${JSON.stringify(a.body)}`);
    const r = await call("POST", `${O}/me/shifts/${id}/respond`, cg.token, { decision: "accepted" });
    if (r.status !== 200) throw new Error(`respond ${r.status} ${JSON.stringify(r.body)}`);
    return id;
  }
  async function smartMatchShift() {
    const S = `${O}/smartmatch`;
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day++, 14));
    const d = await call("POST", `${S}/opportunities`, adm.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 4 * HOUR).toISOString() });
    const oppId = d.body.opportunity.id as string;
    await call("POST", `${S}/opportunities/${oppId}/publish`, adm.token);
    const ap = await call("POST", `${S}/opportunities/${oppId}/applications`, cg.token, { consent: true, consentVersion: "smartmatch-consent-v1" });
    const dec = await call("POST", `${S}/applications/${ap.body.application.id}/decision`, adm.token, { decision: "APPROVE", confirm: true });
    if (dec.body.outcome !== "APPROVED") throw new Error(`approve ${dec.status} ${JSON.stringify(dec.body)}`);
    const sh = await call("POST", `${S}/opportunities/${oppId}/shift`, adm.token, { careRecipientId: recipientId });
    if (sh.status !== 201) throw new Error(`smartmatch shift ${sh.status} ${JSON.stringify(sh.body)}`);
    const id = (sh.body.shift?.id ?? sh.body.shiftId) as string;
    const r = await call("POST", `${O}/me/shifts/${id}/respond`, cg.token, { decision: "accepted" });
    if (r.status !== 200) throw new Error(`respond sm ${r.status} ${JSON.stringify(r.body)}`);
    return id;
  }
  const checkIn = (id: string) => call("POST", `${O}/shifts/${id}/check-in`, cg.token, { verificationMethodCode: "CAREGIVER_SESSION" });
  const checkOut = (id: string, body: Json = {}) => call("POST", `${O}/shifts/${id}/check-out`, cg.token, body);
  /** Simulates time passing: the open check-in happened `hours` ago. */
  const age = (id: string, hours: number) =>
    q(`UPDATE verification_events SET occurred_at = now() - make_interval(secs => $2::int) WHERE shift_id = $1 AND event_type = 'check_in'`, [id, Math.round(hours * 3600)]);
  const status = async (id: string) => (await q<{ status: string }>("SELECT status FROM shifts WHERE id = $1", [id])).rows[0]?.status;
  const sheet = async (id: string) => (await q<{ recorded_minutes: number }>("SELECT recorded_minutes FROM timesheets WHERE shift_id = $1", [id])).rows[0] ?? null;
  const reviewNotices = async (id: string) => Number((await q<{ n: string }>(
    "SELECT count(*) n FROM notifications WHERE related_entity_id = $1 AND notification_type = 'TIMESHEET_NEEDS_REVIEW'", [id])).rows[0].n);
  const all: Array<{ status: number; body: Json }> = [];
  const track = <T extends { status: number; body: Json }>(r: T) => { all.push(r); return r; };

  try {
    // CO1 Regular visit.
    const s1 = await regularShift();
    await checkIn(s1); await age(s1, 2);
    const o1 = track(await checkOut(s1));
    check("CO1 regular shift (2 h): 201, shift completed, timesheet 120 min, no review notice",
      o1.status === 201 && (await status(s1)) === "completed" && (await sheet(s1))?.recorded_minutes === 120 && (await reviewNotices(s1)) === 0,
      `${o1.status} ${await status(s1)} ${(await sheet(s1))?.recorded_minutes}`);

    // CO2 Regular visit left open for more than 48 h (the incident).
    const s2 = await regularShift();
    await checkIn(s2); await age(s2, 50);
    const o2 = track(await checkOut(s2));
    const o2b = track(await checkOut(s2));
    check("CO2 visit open 50 h: check-out 201 (was 500), shift completed",
      o2.status === 201 && (await status(s2)) === "completed", `${o2.status} ${String(o2.body.error ?? "")} ${await status(s2)}`);
    check("CO2b a retry after it closed is a normal 4xx, never a 500, and stores nothing more",
      o2b.status >= 400 && o2b.status < 500 && Number((await q<{ n: string }>("SELECT count(*) n FROM verification_events WHERE shift_id=$1 AND event_type='check_out'", [s2])).rows[0].n) === 1,
      `${o2b.status} ${String(o2b.body.error ?? "")}`);
    const audit2 = Number((await q<{ n: string }>("SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action='TIMESHEET_SKIPPED_LONG_VISIT'", [s2])).rows[0].n);
    check("CO2c no automatic timesheet beyond 48 h; admin and supervisor get one review notice each; audited",
      (await sheet(s2)) === null && (await reviewNotices(s2)) === 2 && audit2 === 1, `sheet=${(await sheet(s2))?.recorded_minutes ?? "none"} notices=${await reviewNotices(s2)} audit=${audit2}`);
    const n2 = (await call("GET", "/me/notifications?limit=100", adm.token)).body.items as Json[];
    const mine = n2.find((n) => n.type === "TIMESHEET_NEEDS_REVIEW" && n.relatedEntityId === s2);
    const cgNotices = ((await call("GET", "/me/notifications?limit=100", cg.token)).body.items as Json[]).filter((n) => n.type === "TIMESHEET_NEEDS_REVIEW");
    check("CO2d the admin sees the notice (linked to the shift); the caregiver gets none",
      !!mine && cgNotices.length === 0, `admin=${Boolean(mine)} caregiver=${cgNotices.length}`);
    const v2 = await call("GET", `${O}/shifts/${s2}/visit-verification`, adm.token);
    check("CO2e the agency still sees check-in and check-out of that visit", v2.status === 200 && v2.body.events.length === 2 && v2.body.status === "completed",
      `${v2.status} ${String(v2.body.status)}`);

    // CO3 Boundary: 47.5 h still produces the timesheet.
    const s3 = await regularShift();
    await checkIn(s3); await age(s3, 47.5);
    const o3 = track(await checkOut(s3));
    check("CO3 visit of 47.5 h: 201 and timesheet 2850 min", o3.status === 201 && (await sheet(s3))?.recorded_minutes === 2850, `${o3.status} ${(await sheet(s3))?.recorded_minutes}`);

    // CO4 Offline check-out of a long visit, then the device retries the same record.
    const s4 = await regularShift();
    await checkIn(s4); await age(s4, 60);
    const outId = randomUUID();
    const occurredAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const o4 = track(await checkOut(s4, { clientEventId: outId, occurredAt }));
    const o4b = track(await checkOut(s4, { clientEventId: outId, occurredAt }));
    check("CO4 offline check-out of a 60 h visit: 201, device retry 200 replayed", o4.status === 201 && o4b.status === 200 && o4b.body.replayed === true, `${o4.status} ${o4b.status}`);

    // CO5 SmartMatch shift, normal visit.
    const s5 = await smartMatchShift();
    await checkIn(s5); await age(s5, 4);
    const o5 = track(await checkOut(s5));
    check("CO5 SmartMatch shift (4 h): 201, completed, timesheet 240 min",
      o5.status === 201 && (await status(s5)) === "completed" && (await sheet(s5))?.recorded_minutes === 240, `${o5.status} ${await status(s5)} ${(await sheet(s5))?.recorded_minutes}`);

    // CO6 SmartMatch shift left open > 48 h.
    const s6 = await smartMatchShift();
    await checkIn(s6); await age(s6, 72);
    const o6 = track(await checkOut(s6));
    check("CO6 SmartMatch shift open 72 h: 201, completed, review notice, no timesheet",
      o6.status === 201 && (await status(s6)) === "completed" && (await sheet(s6)) === null && (await reviewNotices(s6)) === 2, `${o6.status} ${await status(s6)}`);

    // CO7 Supervisor override closes a long visit too (was also a 500).
    const s7 = await regularShift();
    await checkIn(s7); await age(s7, 55);
    const o7 = track(await call("POST", `${O}/shifts/${s7}/verification/supervisor-override`, sup.token, { organizationWorkerMembershipId: cg.owm, eventType: "check_out", reason: "Visita olvidada abierta" }));
    check("CO7 supervisor override check-out of a 55 h visit: 201, review notice, no timesheet",
      o7.status === 201 && (await sheet(s7)) === null && (await reviewNotices(s7)) === 2, `${o7.status} ${String(o7.body.error ?? "")}`);

    // CO8 Rejections stay 4xx.
    const s8 = await regularShift();
    const o8 = track(await checkOut(s8));
    check("CO8 check-out without check-in: 409 NO_ACTIVE_CHECK_IN", o8.status === 409 && o8.body.error === "NO_ACTIVE_CHECK_IN", `${o8.status}`);
    const s9 = await regularShift();
    await checkIn(s9); await age(s9, 1);
    await q("UPDATE organization_worker_memberships SET status='inactive' WHERE id=$1", [cg.owm]);
    const o9 = track(await checkOut(s9));
    await q("UPDATE organization_worker_memberships SET status='active' WHERE id=$1", [cg.owm]);
    check("CO9 membership deactivated during the visit: 4xx, not 500", o9.status >= 400 && o9.status < 500, `${o9.status} ${String(o9.body.error ?? "")}`);
    const o10 = track(await call("POST", `${O}/shifts/${s9}/check-out`, cg.token, { occurredAt: "not-a-date" }));
    check("CO10 malformed time: 400", o10.status === 400, `${o10.status}`);
    const o11 = track(await call("POST", `${O}/shifts/${s1}/check-out`, sup.token, {}));
    check("CO11 a supervisor without a worker profile cannot check out as a caregiver: 4xx", o11.status >= 400 && o11.status < 500, `${o11.status} ${String(o11.body.error ?? "")}`);

    // CO12 No 500 anywhere in this run; if one appears it must carry only { error, errorId }.
    const fives = all.filter((r) => r.status === 500);
    check("CO12 no 500 in the whole run", fives.length === 0, `${fives.length} ${fives.map((r) => JSON.stringify(r.body)).join(" ")}`);
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
    await db.end();
  }

  console.log("\nCheck-out flow (regular + SmartMatch)\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nCheck-out flow: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Check-out verification failed:", error);
  process.exit(1);
});
