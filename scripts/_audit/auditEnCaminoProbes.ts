/**
 * AUDIT PROBES for «Voy en camino» / «Llegué» (diagnostic only, not committed to main).
 * Targets cases the Gate 6/7 verifiers do not cover. Disposable local DB, synthetic data.
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@127.0.0.1/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("disposable DB only");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");
type Json = Record<string, any>;
const out: { id: string; ok: boolean; observed: string; expected: string }[] = [];
const probe = (id: string, ok: boolean, observed: string, expected: string) => out.push({ id, ok, observed, expected });

async function main() {
  const db = new pg.Client({ connectionString: adminUrl }); await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const rp = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${rp}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = rp; process.env.DATABASE_URL = u.toString();
  const { hashPassword } = await import("../../src/security/password.js");
  const { createApp } = await import("../../src/app.js");
  const { pool } = await import("../../src/config/db.js");
  const server = createApp().listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex"); const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  const fives: string[] = [];
  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    const t = await res.text(); let b: Json = {}; try { b = t ? JSON.parse(t) : {}; } catch { b = { raw: t.slice(0, 80) }; }
    if (res.status >= 500) fives.push(`${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")} ${res.status}`);
    return { status: res.status, body: b };
  }
  const orgA = (await q<{ id: string }>(`WITH o AS (INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id), f AS (INSERT INTO organization_features (organization_id,feature_code,enabled) SELECT o.id, c, true FROM o, unnest(ARRAY['SMARTMATCH','EN_CAMINO']) c) SELECT id FROM o`, [`EC A ${tag}`])).rows[0].id;
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'EC') RETURNING id`, [orgA])).rows[0].id;
  await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  type P = { email: string; userId: string; token: string; mid?: string };
  async function person(key: string, roles: string[], worker = false): Promise<P> {
    const email = `ec-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgA])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgA, roles]);
    let mid: string | undefined;
    if (worker) {
      const w = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Cuidadora ${key}`])).rows[0].id;
      mid = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [w, orgA])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [w, bls]);
      await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [mid, orgA]);
      for (let d = 0; d < 7; d++) await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,'00:00','23:59')`, [mid, orgA, d]);
    }
    return { email, userId, token: "", mid };
  }
  const A = { admin: await person("admin", ["ORGANIZATION_ADMIN"]), fam: await person("fam", ["FAMILY"]),
    cg1: await person("cg1", ["WORKER"], true), cg2: await person("cg2", ["WORKER"], true), cg3: await person("cg3", ["WORKER"], true),
    cg4: await person("cg4", ["WORKER"], true), cg5: await person("cg5", ["WORKER"], true) };
  for (const p of Object.values(A)) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password }); p.token = r.body.token;
    await call("POST", "/me/active-organization", p.token, { organizationId: orgA });
  }
  const rA = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Sintetico','EC') RETURNING id`, [orgA])).rows[0].id;
  // primary address WITHOUT a confirmed GPS point (common for a new agency)
  await q(`INSERT INTO care_recipient_locations (care_recipient_id,organization_id,address_line,municipality,is_primary) VALUES ($1,$2,'Calle Sol 3','Caguas',true)`, [rA, orgA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [A.fam.userId, orgA, rA]);
  const at = (m: number) => { const d = new Date(Date.now() + m * 60_000); d.setUTCSeconds(0, 0); return d.toISOString(); };
  async function shift(p: P, startMin: number, dur = 120) {
    const s = await call("POST", `/organizations/${orgA}/shifts`, A.admin.token, { careRecipientId: rA, scheduledStart: at(startMin), scheduledEnd: at(startMin + dur) });
    const id = s.body.shift.id as string;
    const a = await call("POST", `/organizations/${orgA}/shifts/${id}/assignments`, A.admin.token, { organizationWorkerMembershipId: p.mid });
    await call("POST", `/organizations/${orgA}/me/shifts/${id}/respond`, p.token, { decision: "accepted" });
    return { id, assignmentId: a.body.assignment?.id as string };
  }
  const J = (id: string) => `/organizations/${orgA}/shifts/${id}/journey`;
  const typesFor = async (userId: string, shiftId: string) =>
    (await q<{ t: string }>(`SELECT notification_type t FROM notifications WHERE user_id=$1 AND (related_entity_id=$2 OR related_entity_id IN (SELECT id FROM shift_journey_events WHERE shift_id=$2) OR related_entity_id IN (SELECT id FROM assignments WHERE shift_id=$2)) ORDER BY created_at`, [userId, shiftId])).rows.map((r) => r.t);

  try {
    // ---------------------------------------------------------------- 5. cancellation while en route
    const c = await shift(A.cg1, 45);
    await call("POST", `${J(c.id)}/en-route`, A.cg1.token, { clientEventId: randomUUID() });
    const famBefore = await typesFor(A.fam.userId, c.id); const cgBefore = await typesFor(A.cg1.userId, c.id);
    const cancel = await call("POST", `/organizations/${orgA}/shifts/${c.id}/cancel`, A.admin.token, { reason: "Prueba" });
    const famAfter = await typesFor(A.fam.userId, c.id); const cgAfter = await typesFor(A.cg1.userId, c.id);
    const cgState = await call("GET", J(c.id), A.cg1.token);
    probe("5a agency cancels a visit while the caregiver is EN ROUTE: is the caregiver told?", cgAfter.length > cgBefore.length,
      `cancel=${cancel.status}; caregiver notices before=[${cgBefore}] after=[${cgAfter}]; caregiver GET journey=${cgState.status} ${cgState.body.journey?.state ?? cgState.body.error}`,
      "the caregiver on the road receives a cancellation notice");
    probe("5b same: is the family (who got «va en camino») told?", famAfter.length > famBefore.length,
      `family before=[${famBefore}] after=[${famAfter}]`, "the family receives a cancellation notice");

    // ---------------------------------------------------------------- 5/6. reassignment after en route
    const r = await shift(A.cg2, 50);
    await call("POST", `${J(r.id)}/en-route`, A.cg2.token, { clientEventId: randomUUID() });
    const rem = await call("PATCH", `/organizations/${orgA}/shifts/${r.id}/assignments/${r.assignmentId}`, A.admin.token, { reason: "Reasignada" });
    const cg2Notes = await typesFor(A.cg2.userId, r.id);
    await call("POST", `/organizations/${orgA}/shifts/${r.id}/assignments`, A.admin.token, { organizationWorkerMembershipId: A.cg3.mid });
    const before3 = await call("GET", J(r.id), A.cg3.token);
    await call("POST", `/organizations/${orgA}/me/shifts/${r.id}/respond`, A.cg3.token, { decision: "accepted" });
    const st3 = await call("GET", J(r.id), A.cg3.token);
    const en3 = await call("POST", `${J(r.id)}/en-route`, A.cg3.token, { clientEventId: randomUUID() });
    const famR = await typesFor(A.fam.userId, r.id);
    const oldCg = await call("GET", J(r.id), A.cg2.token);
    probe("6a reassignment after «en camino»: removed caregiver told, new one starts clean, family informed of the new departure",
      rem.status === 200 && st3.body.journey?.state === "ASSIGNED" && en3.status === 201 && cg2Notes.length > 0 && famR.filter((t) => t === "FAMILY_CAREGIVER_EN_ROUTE").length === 2 && oldCg.status === 404,
      `remove=${rem.status} removedCaregiverNotices=[${cg2Notes}] newBeforeAccept=${before3.body.journey?.state} newAfterAccept=${st3.body.journey?.state} newEnRoute=${en3.status} familyEnRouteNotices=${famR.filter((t) => t === "FAMILY_CAREGIVER_EN_ROUTE").length} oldCaregiverGET=${oldCg.status}`,
      "old caregiver notified + loses access; new state ASSIGNED; family told about the NEW caregiver leaving");

    // ---------------------------------------------------------------- 3. «Llegué» against an address without confirmed GPS point
    const g = await shift(A.cg4, 30);
    await call("POST", `/organizations/${orgA}/me/location-consent`, A.cg4.token, { consentVersion: "location-check-v1" });
    const far = await call("POST", `/organizations/${orgA}/shifts/${g.id}/arrival`, A.cg4.token, { latitude: 18.47, longitude: -66.1, accuracyM: 15, clientEventId: randomUUID() }); // San Juan, ~30 km from Caguas
    const mgrNote = await typesFor(A.admin.userId, g.id);
    const agencyView = await call("GET", J(g.id), A.admin.token);
    probe("3a «Llegué» 30 km away from an address whose GPS point was never confirmed", far.body.needsReview === true || mgrNote.includes("SHIFT_ARRIVAL_NEEDS_REVIEW"),
      `arrival=${far.status} proximity=${far.body.proximity} needsReview=${far.body.needsReview}; agency notices=[${mgrNote}]; agency sees needsReview=${agencyView.body.journey?.arrivalNeedsReview}`,
      "the agency learns the location could not be verified (no silent «verified» arrival)");

    // ---------------------------------------------------------------- 2. declared delay vs late-arrival alert
    const d = await shift(A.cg5, -16, 120);   // started 16 min ago
    await q(`INSERT INTO shift_journey_events (organization_id, shift_id, organization_worker_membership_id, recorded_by_user_id, event_type, occurred_at, declared_delay_minutes, delay_reason)
             VALUES ($1,$2,$3,$4,'EN_ROUTE', now() - interval '30 minutes', NULL, NULL),
                    ($1,$2,$3,$4,'DELAY_REPORTED', now() - interval '25 minutes', 30, 'TRAFFIC')`, [orgA, d.id, A.cg5.mid, A.cg5.userId]);
    await q(`SET app.background_job = 'on'`).catch(() => undefined);
    let ran = "";
    try { ran = String((await q<{ n: number }>(`SELECT app_notify_late_shift_arrivals() n`)).rows[0].n); } catch (e) { ran = `job:${(e as Error).message.slice(0, 50)}`; }
    const lateTypes = await typesFor(A.admin.userId, d.id);
    probe("2a caregiver declared a 30-min delay and is en route: does the agency still get «sin llegada (15 min)»?", true,
      `job=${ran} agency notices=[${lateTypes}]`, "informational (expected: delay notice; a «late» notice too is noise unless the declared delay has passed)");

    // ---------------------------------------------------------------- 5. offline / old timestamps
    const o = await shift(A.cg1, 20);
    const oldEnRoute = await call("POST", `${J(o.id)}/en-route`, A.cg1.token, { clientEventId: randomUUID(), occurredAt: new Date(Date.now() - 70 * 60_000).toISOString(), recordedOffline: true });
    probe("5c offline «Voy en camino» synced 70 min later", oldEnRoute.status === 201 || oldEnRoute.status === 409,
      `status=${oldEnRoute.status} ${oldEnRoute.body.error ?? ""}`, "informational: server accepts offline departures only up to 60 min old");
    const oldArrival = await call("POST", `/organizations/${orgA}/shifts/${o.id}/arrival`, A.cg1.token, { clientEventId: randomUUID(), occurredAt: new Date(Date.now() - 10 * 60_000).toISOString(), recordedOffline: true });
    probe("5d offline «Llegué» with device time (server side)", oldArrival.status === 201, `status=${oldArrival.status} ${oldArrival.body.error ?? ""} offline=${oldArrival.body.proximity}`, "accepted; but the app never sends offline arrivals (see frontend)");

    // ---------------------------------------------------------------- 4. permissions: family / other caregiver
    const famJ = await call("GET", J(o.id), A.fam.token);
    const otherCg = await call("POST", `${J(o.id)}/en-route`, A.cg5.token, { clientEventId: randomUUID() });
    const famArr = await call("POST", `/organizations/${orgA}/shifts/${o.id}/arrival`, A.fam.token, {});
    probe("4a family cannot use the caregiver/agency journey endpoint; other caregiver and family cannot declare", famJ.status >= 400 && otherCg.status === 404 && famArr.status >= 400,
      `familyGET=${famJ.status} otherCaregiver=${otherCg.status} familyArrival=${famArr.status}`, "4xx");

    // ---------------------------------------------------------------- 6. SmartMatch-created shift
    const S = `/organizations/${orgA}/smartmatch`;
    const start = new Date(Date.now() + 40 * 60_000); start.setUTCSeconds(0, 0);
    const opp = await call("POST", `${S}/opportunities`, A.admin.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 2 * 3600e3).toISOString() });
    await call("POST", `${S}/opportunities/${opp.body.opportunity.id}/publish`, A.admin.token);
    const app = await call("POST", `${S}/opportunities/${opp.body.opportunity.id}/applications`, A.cg2.token, { consent: true, consentVersion: "smartmatch-consent-v1" });
    await call("POST", `${S}/applications/${app.body.application.id}/decision`, A.admin.token, { decision: "APPROVE", confirm: true });
    const locId = (await q<{ id: string }>(`SELECT id FROM care_recipient_locations WHERE care_recipient_id=$1`, [rA])).rows[0].id;
    const sm = await call("POST", `${S}/opportunities/${opp.body.opportunity.id}/shift`, A.admin.token, { careRecipientId: rA, serviceLocationId: locId });
    const smShift = sm.body.shift?.id as string;
    const smState = await call("GET", J(smShift), A.cg2.token);
    const smEnBefore = await call("POST", `${J(smShift)}/en-route`, A.cg2.token, { clientEventId: randomUUID() });
    await call("POST", `/organizations/${orgA}/me/shifts/${smShift}/respond`, A.cg2.token, { decision: "accepted" });
    const smEn = await call("POST", `${J(smShift)}/en-route`, A.cg2.token, { clientEventId: randomUUID() });
    const smArr = await call("POST", `/organizations/${orgA}/shifts/${smShift}/arrival`, A.cg2.token, { clientEventId: randomUUID() });
    probe("6b SmartMatch shift: same journey; the approved caregiver must still accept the assignment first",
      sm.status === 201 && smEn.status === 201 && [201, 200].includes(smArr.status),
      `shift=${sm.status} stateBeforeAccept=${smState.body.journey?.state} enRouteBeforeAccept=${smEnBefore.status} ${smEnBefore.body.error ?? ""} enRoute=${smEn.status} arrival=${smArr.status}`,
      "works; note the extra «Aceptar» step after a SmartMatch approval");

    probe("Z no server error (5xx)", fives.length === 0, fives.join(" | ") || "none", "none");
  } finally {
    for (const x of out) console.log(`${x.ok ? "OK  " : "GAP "} ${x.id}\n      observed: ${x.observed}\n      expected: ${x.expected}`);
    console.log(`EN CAMINO PROBES: ${out.filter((x) => x.ok).length}/${out.length} as expected`);
    server.close(); await pool.end(); await db.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
