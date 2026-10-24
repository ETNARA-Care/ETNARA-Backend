/**
 * «En camino» / «Llegué» fixes (migration 113): cancellation and reassignment
 * notices, journey invalidation, offline sync (12 h, no stale notices, no
 * overwrite), delay-aware late alert, privacy and pilot-only scope.
 * Real HTTP with the server connected as app_runtime. Synthetic data only.
 *
 * Disposable databases only:
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") {
  throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
}
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
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  const serverErrors: string[] = [];

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed: Json = {}; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 80) }; }
    if (res.status >= 500) serverErrors.push(`${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")} ${res.status}`);
    return { status: res.status, body: parsed };
  }
  const org = async (name: string, pilot: boolean) =>
    (await q<{ id: string }>(`WITH o AS (INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id),
      f AS (INSERT INTO organization_features (organization_id,feature_code,enabled) SELECT o.id, c, $2 FROM o, unnest(ARRAY['SMARTMATCH','EN_CAMINO']) c) SELECT id FROM o`, [name, pilot])).rows[0].id;
  const orgA = await org(`EC Fix A ${tag}`, true);
  const orgOff = await org(`EC Fix Off ${tag}`, false);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  for (const o of [orgA, orgOff]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'EC') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  }
  type P = { email: string; userId: string; token: string; mid?: string; orgId: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `ecfix-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    if (roles.length) {
      const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
      await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    }
    let mid: string | undefined;
    if (worker) {
      const w = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Cuidadora ${key}`])).rows[0].id;
      mid = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [w, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [w, bls]);
      await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [mid, orgId]);
      for (let d = 0; d < 7; d++) await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,'00:00','23:59')`, [mid, orgId, d]);
    }
    return { email, userId, token: "", mid, orgId };
  }
  const A = {
    admin: await person("admin", orgA, ["ORGANIZATION_ADMIN"]), sup: await person("sup", orgA, ["SUPERVISOR"]),
    fam: await person("fam", orgA, ["FAMILY"]), famMuted: await person("fammuted", orgA, ["FAMILY"]),
    platform: await person("platform", orgA, []),
    cg: await Promise.all(Array.from({ length: 13 }, (_, i) => person(`cg${i}`, orgA, ["WORKER"], true))),
  };
  const Off = { admin: await person("offadmin", orgOff, ["ORGANIZATION_ADMIN"]), fam: await person("offfam", orgOff, ["FAMILY"]), cg: await person("offcg", orgOff, ["WORKER"], true) };
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [A.platform.userId]);
  const recipient = async (o: string) => (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Sintetico',$2) RETURNING id`, [o, `EC-${tag}`])).rows[0].id;
  const rA = await recipient(orgA); const rOff = await recipient(orgOff);
  await q(`INSERT INTO care_recipient_locations (care_recipient_id,organization_id,address_line,municipality,is_primary) VALUES ($1,$2,'Calle Estrella 7','Caguas',true)`, [rA, orgA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [A.fam.userId, orgA, rA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_receive_notifications) VALUES ($1,$2,$3,'hijo','active',false)`, [A.famMuted.userId, orgA, rA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [Off.fam.userId, orgOff, rOff]);
  for (const p of [A.admin, A.sup, A.fam, A.famMuted, A.platform, ...A.cg, Off.admin, Off.fam, Off.cg]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${p.email} ${r.status}`);
    p.token = r.body.token;
    if (p !== A.platform) await call("POST", "/me/active-organization", p.token, { organizationId: p.orgId });
  }

  const at = (m: number) => { const d = new Date(Date.now() + m * 60_000); d.setUTCSeconds(0, 0); return d.toISOString(); };
  async function shift(p: P, startMin: number, dur = 120, opts: { org?: string; admin?: P; rec?: string; accept?: boolean } = {}) {
    const o = opts.org ?? orgA; const admin = opts.admin ?? A.admin; const rec = opts.rec ?? rA;
    const s = await call("POST", `/organizations/${o}/shifts`, admin.token, { careRecipientId: rec, scheduledStart: at(startMin), scheduledEnd: at(startMin + dur) });
    const id = s.body.shift?.id as string;
    if (!id) throw new Error(`shift ${s.status} ${JSON.stringify(s.body)}`);
    const a = await call("POST", `/organizations/${o}/shifts/${id}/assignments`, admin.token, { organizationWorkerMembershipId: p.mid });
    if (a.status !== 201) throw new Error(`assign ${a.status} ${JSON.stringify(a.body)}`);
    if (opts.accept !== false) await call("POST", `/organizations/${o}/me/shifts/${id}/respond`, p.token, { decision: "accepted" });
    return { id, assignmentId: a.body.assignment?.id as string };
  }
  /** Move a shift in time (as the database owner) to simulate the clock. */
  const moveStart = (id: string, minutesFromNow: number, dur = 240) =>
    q(`UPDATE shifts SET scheduled_start = now() + make_interval(mins => $2), scheduled_end = now() + make_interval(mins => $2 + $3) WHERE id = $1`, [id, minutesFromNow, dur]);
  const J = (id: string, o = orgA) => `/organizations/${o}/shifts/${id}/journey`;
  const notes = async (userId: string, types: string[], shiftId?: string) =>
    (await q<{ notification_type: string; related_entity_type: string; related_entity_id: string; read_at: Date | null }>(
      `SELECT notification_type, related_entity_type, related_entity_id, read_at FROM notifications WHERE user_id=$1 AND notification_type = ANY($2)
       ${shiftId ? "AND (related_entity_id = $3 OR related_entity_id IN (SELECT id FROM shift_journey_events WHERE shift_id = $3))" : ""}`,
      shiftId ? [userId, types, shiftId] : [userId, types])).rows;
  const apiNotes = async (p: P) => ((await call("GET", "/me/notifications?limit=100", p.token)).body.items ?? []) as Json[];
  const enRoute = (p: P, id: string, extra: Json = {}) => call("POST", `${J(id)}/en-route`, p.token, { clientEventId: randomUUID(), ...extra });
  const arrive = (p: P, id: string, extra: Json = {}) => call("POST", `/organizations/${orgA}/shifts/${id}/arrival`, p.token, { clientEventId: randomUUID(), ...extra });
  const leaks = (v: unknown) => /Calle Estrella|Caguas|latitude|longitude/i.test(JSON.stringify(v));
  const runJob = async (fn: string) => Number((await q<{ n: number }>(`SELECT ${fn}() AS n`)).rows[0].n);

  try {
    // ================================================================ 1. cancellation
    const c = await shift(A.cg[0], 45);
    await enRoute(A.cg[0], c.id);
    const pendingCg = A.cg[1];   // a second caregiver offered the same shift, not yet accepted
    await call("POST", `/organizations/${orgA}/shifts/${c.id}/assignments`, A.admin.token, { organizationWorkerMembershipId: pendingCg.mid });
    const cancel = await call("POST", `/organizations/${orgA}/shifts/${c.id}/cancel`, A.admin.token, {});
    const cgN = await notes(A.cg[0].userId, ["SHIFT_CANCELLED"], c.id);
    const pendN = await notes(pendingCg.userId, ["SHIFT_CANCELLED"], c.id);
    const famN = await notes(A.fam.userId, ["FAMILY_VISIT_CANCELLED"], c.id);
    check("C1 cancelling a visit with the caregiver EN ROUTE tells her once (and a pending caregiver too)",
      cancel.status === 200 && cgN.length === 1 && pendN.length === 1 && cgN[0].related_entity_type === "shift", `cancel=${cancel.status} caregiver=${cgN.length} pending=${pendN.length}`);
    check("C2 the family (who got «va en camino») is told once; a relative with notifications off is not",
      famN.length === 1 && (await notes(A.famMuted.userId, ["FAMILY_VISIT_CANCELLED"], c.id)).length === 0, `family=${famN.length}`);
    const st = await call("GET", J(c.id), A.cg[0].token);
    const again = await enRoute(A.cg[0], c.id);
    const arrAfter = await arrive(A.cg[0], c.id);
    const delayAfter = await call("POST", `${J(c.id)}/delay`, A.cg[0].token, { minutes: 15, reason: "TRAFFIC", clientEventId: randomUUID() });
    check("C3 «En camino» is over: state CANCELLED; departure, delay and «Llegué» are refused afterwards",
      // after a cancellation the caregiver no longer sees the visit (Gate 6 C5): 404 is a refusal too
      st.body.journey?.state === "CANCELLED" && again.status === 200 && again.body.journey?.state === "CANCELLED" && [404, 409].includes(arrAfter.status) && delayAfter.status === 409
      && (await q(`SELECT 1 FROM shift_arrivals WHERE shift_id=$1`, [c.id])).rowCount === 0,
      `state=${st.body.journey?.state} enRoute=${again.status}/${again.body.journey?.state} arrival=${arrAfter.status} ${arrAfter.body.error} delay=${delayAfter.status} ${delayAfter.body.error}`);
    const c2 = await call("POST", `/organizations/${orgA}/shifts/${c.id}/cancel`, A.admin.token, {});
    const dupe = await q(`INSERT INTO notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, channel, status)
      VALUES ($1,$2,'SHIFT_CANCELLED','shift',$3,'in_app','sent')`, [A.cg[0].userId, orgA, c.id]).then(() => "inserted", (e: Error) => e.message.slice(0, 50));
    check("C4 no duplicates: a second cancel is refused and the database rejects a second cancellation notice",
      c2.status === 409 && /duplicate key/.test(dupe) && (await notes(A.cg[0].userId, ["SHIFT_CANCELLED"], c.id)).length === 1, `secondCancel=${c2.status} db=${dupe}`);
    const cgApi = (await apiNotes(A.cg[0])).filter((n) => n.type === "SHIFT_CANCELLED");
    const famApi = (await apiNotes(A.fam)).filter((n) => n.type === "FAMILY_VISIT_CANCELLED");
    check("C5 the notices read in Spanish, carry no address or location; the caregiver's opens her shift (shiftId)",
      cgApi.length === 1 && cgApi[0].shiftId === c.id && cgApi[0].summary === "La agencia canceló uno de tus turnos"
      && famApi.length === 1 && famApi[0].summary === "La agencia canceló una visita" && !leaks(cgApi) && !leaks(famApi), `${cgApi[0]?.summary} / ${famApi[0]?.summary}`);

    // ================================================================ 2. removal / reassignment
    const r = await shift(A.cg[2], 50);
    await enRoute(A.cg[2], r.id);
    await q(`INSERT INTO notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, channel, status)
      VALUES ($1,$2,'SHIFT_NOT_EN_ROUTE','shift',$3,'in_app','sent')`, [A.admin.userId, orgA, r.id]);  // an open preventive alert
    const rem = await call("PATCH", `/organizations/${orgA}/shifts/${r.id}/assignments/${r.assignmentId}`, A.admin.token, { reason: "Reasignada por la agencia" });
    const removedN = await notes(A.cg[2].userId, ["SHIFT_UNASSIGNED"], r.id);
    const changedN = await notes(A.fam.userId, ["FAMILY_CAREGIVER_CHANGED"], r.id);
    const alertClosed = (await notes(A.admin.userId, ["SHIFT_NOT_EN_ROUTE"], r.id))[0]?.read_at !== null;
    check("R1 taking an en-route caregiver off the visit tells her once and tells the family «cambió la cuidadora»; open alerts close",
      rem.status === 200 && removedN.length === 1 && changedN.length === 1 && alertClosed, `remove=${rem.status} caregiver=${removedN.length} family=${changedN.length} alertClosed=${alertClosed}`);
    const oldGet = await call("GET", J(r.id), A.cg[2].token);
    const oldEn = await enRoute(A.cg[2], r.id);
    const oldArr = await arrive(A.cg[2], r.id);
    check("R2 the removed caregiver loses the visit at once: state, departure and «Llegué» answer 404",
      oldGet.status === 404 && oldEn.status === 404 && oldArr.status === 404, `${oldGet.status},${oldEn.status},${oldArr.status}`);
    await call("POST", `/organizations/${orgA}/shifts/${r.id}/assignments`, A.admin.token, { organizationWorkerMembershipId: A.cg[3].mid });
    const newPending = await call("GET", J(r.id), A.cg[3].token);
    await call("POST", `/organizations/${orgA}/me/shifts/${r.id}/respond`, A.cg[3].token, { decision: "accepted" });
    const newSt = await call("GET", J(r.id), A.cg[3].token);
    const newEn = await enRoute(A.cg[3], r.id);
    const famEnRoute = await notes(A.fam.userId, ["FAMILY_CAREGIVER_EN_ROUTE"], r.id);
    check("R3 the replacement starts clean (PENDING -> ASSIGNED, not «en camino») and the family is told when SHE leaves",
      newPending.body.journey?.state === "PENDING_ACCEPTANCE" && newSt.body.journey?.state === "ASSIGNED" && newEn.status === 201 && famEnRoute.length === 2,
      `pending=${newPending.body.journey?.state} accepted=${newSt.body.journey?.state} enRoute=${newEn.status} familyEnRoute=${famEnRoute.length}`);
    const hist = await call("GET", J(r.id), A.admin.token);
    const kinds = ((hist.body.history ?? []) as Json[]).map((h) => h.kind);
    const famHist = await call("GET", J(r.id), A.fam.token);
    check("R4 audit: the removal is in the agency's operational history (who, when); the family cannot read it",
      kinds.includes("UNASSIGNED") && kinds.filter((k) => k === "EN_ROUTE").length === 2 && famHist.status === 404, kinds.join(">"));
    const p = await shift(A.cg[4], 60, 120, { accept: false });
    await call("PATCH", `/organizations/${orgA}/shifts/${p.id}/assignments/${p.assignmentId}`, A.admin.token, { reason: "Otro plan" });
    check("R5 removing a caregiver who had not accepted: she is told, the family is not (nobody had confirmed)",
      (await notes(A.cg[4].userId, ["SHIFT_UNASSIGNED"], p.id)).length === 1 && (await notes(A.fam.userId, ["FAMILY_CAREGIVER_CHANGED"], p.id)).length === 0);

    // ================================================================ 3. pilot scope + isolation
    const off = await shift(Off.cg, 60, 120, { org: orgOff, admin: Off.admin, rec: rOff });
    await call("POST", `/organizations/${orgOff}/shifts/${off.id}/cancel`, Off.admin.token, {});
    const offNotes = (await notes(Off.cg.userId, ["SHIFT_CANCELLED"])).length + (await notes(Off.fam.userId, ["FAMILY_VISIT_CANCELLED"])).length;
    const crossA = (await q<{ n: string }>(`SELECT count(*) n FROM notifications WHERE organization_id=$1 AND notification_type IN ('SHIFT_CANCELLED','FAMILY_VISIT_CANCELLED','SHIFT_UNASSIGNED','FAMILY_CAREGIVER_CHANGED')
      AND user_id NOT IN (SELECT user_id FROM organization_memberships WHERE organization_id=$1)`, [orgA])).rows[0].n;
    const platformSees = (await apiNotes(A.platform)).length;
    check("S1 agencies without «En camino» see no change; notices never reach people outside the agency; ETNARA Central gets none",
      offNotes === 0 && crossA === "0" && platformSees === 0, `offAgency=${offNotes} outside=${crossA} platform=${platformSees}`);

    // ================================================================ 4. offline sync
    const o1 = await shift(A.cg[5], 60, 240);
    await moveStart(o1.id, -150);                          // started 2.5 h ago, still on
    const old3h = await enRoute(A.cg[5], o1.id, { occurredAt: new Date(Date.now() - 180 * 60_000).toISOString(), recordedOffline: true });
    const offRow = (await q<{ recorded_offline: boolean }>(`SELECT recorded_offline FROM shift_journey_events WHERE shift_id=$1`, [o1.id])).rows[0];
    const famStale = await notes(A.fam.userId, ["FAMILY_CAREGIVER_EN_ROUTE"], o1.id);
    check("O1 a departure saved without signal syncs 3 h later (inside its window): stored as offline, no stale notice to the family",
      old3h.status === 201 && offRow?.recorded_offline === true && famStale.length === 0, `status=${old3h.status} ${old3h.body.error ?? ""} offline=${offRow?.recorded_offline} familyNotices=${famStale.length}`);
    const o2 = await shift(A.cg[6], 60, 240);
    await moveStart(o2.id, -13 * 60 + 30, 15 * 60);
    const old13h = await enRoute(A.cg[6], o2.id, { occurredAt: new Date(Date.now() - 13 * 3600e3).toISOString(), recordedOffline: true });
    const future = await enRoute(A.cg[6], o2.id, { occurredAt: new Date(Date.now() + 10 * 60_000).toISOString(), recordedOffline: true });
    check("O2 security kept: older than 12 h or in the future is refused",
      old13h.status === 409 && old13h.body.error === "JOURNEY_TIME_INVALID" && future.status === 400, `13h=${old13h.status} ${old13h.body.error} future=${future.status} ${future.body.error}`);
    const o3 = await shift(A.cg[7], 30, 240);
    await moveStart(o3.id, -20);
    const arrNow = await arrive(A.cg[7], o3.id);
    const lateSync = await enRoute(A.cg[7], o3.id, { occurredAt: new Date(Date.now() - 40 * 60_000).toISOString(), recordedOffline: true });
    const st3 = await call("GET", J(o3.id), A.admin.token);
    const after = await enRoute(A.cg[7], o3.id);
    const famO3 = await notes(A.fam.userId, ["FAMILY_CAREGIVER_EN_ROUTE"], o3.id);
    check("O3 an old event never overwrites a newer state: a departure from BEFORE the arrival syncs as history, state stays ARRIVED, no «en camino» to the family",
      arrNow.status === 201 && lateSync.status === 201 && st3.body.journey?.state === "ARRIVED" && famO3.length === 0,
      `arrival=${arrNow.status} lateDeparture=${lateSync.status} state=${st3.body.journey?.state} family=${famO3.length}`);
    check("O4 a NEW departure after arriving is still refused", after.status === 200 || after.body.error === "JOURNEY_ALREADY_ARRIVED",
      `status=${after.status} ${after.body.error ?? after.body.journey?.state}`);
    const o5 = await shift(A.cg[8], 40, 120);
    const id5 = randomUUID();
    const replays = await Promise.all([1, 2, 3, 4].map(() => enRoute(A.cg[8], o5.id, { clientEventId: id5, occurredAt: new Date(Date.now() - 60_000).toISOString(), recordedOffline: true })));
    const rows5 = (await q<{ n: string }>(`SELECT count(*) n FROM shift_journey_events WHERE shift_id=$1`, [o5.id])).rows[0].n;
    const aid = randomUUID();
    const arrReplays = await Promise.all([1, 2, 3].map(() => arrive(A.cg[8], o5.id, { clientEventId: aid, occurredAt: new Date(Date.now() - 30_000).toISOString(), recordedOffline: true })));
    const arrRows = (await q<{ n: string }>(`SELECT count(*) n FROM shift_arrivals WHERE shift_id=$1`, [o5.id])).rows[0].n;
    check("O5 offline replays (same id, 4 and 3 at once) are stored once each, no server error",
      rows5 === "1" && arrRows === "1" && replays.every((x) => x.status < 500) && arrReplays.every((x) => x.status < 500),
      `departures=${rows5} (${replays.map((x) => x.status).join(",")}) arrivals=${arrRows} (${arrReplays.map((x) => x.status).join(",")})`);
    const o6 = await shift(A.cg[9], 40, 120);
    await call("POST", `/organizations/${orgA}/shifts/${o6.id}/cancel`, A.admin.token, {});
    const arrCancelled = await arrive(A.cg[9], o6.id, { occurredAt: new Date(Date.now() - 60_000).toISOString(), recordedOffline: true });
    const enCancelled = await enRoute(A.cg[9], o6.id, { occurredAt: new Date(Date.now() - 60_000).toISOString(), recordedOffline: true });
    check("O6 an offline «Llegué» / «Voy en camino» that syncs after the cancellation is refused (nothing stored)",
      [404, 409].includes(arrCancelled.status) && [404, 409].includes(enCancelled.status) && (await q(`SELECT 1 FROM shift_arrivals WHERE shift_id=$1`, [o6.id])).rowCount === 0
      && (await q(`SELECT 1 FROM shift_journey_events WHERE shift_id=$1`, [o6.id])).rowCount === 0, `arrival=${arrCancelled.status} ${arrCancelled.body.error} enRoute=${enCancelled.status}`);
    const o7 = await shift(A.cg[0], 30, 240);
    await moveStart(o7.id, -10);
    const fresh = await arrive(A.cg[0], o7.id, { occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(), recordedOffline: true });
    const o8 = await shift(A.cg[1], 30, 240);
    await moveStart(o8.id, -60);
    const stale = await arrive(A.cg[1], o8.id, { occurredAt: new Date(Date.now() - 45 * 60_000).toISOString(), recordedOffline: true });
    const famFresh = await notes(A.fam.userId, ["FAMILY_CAREGIVER_ARRIVED"], o7.id);
    const famStaleArr = await notes(A.fam.userId, ["FAMILY_CAREGIVER_ARRIVED"], o8.id);
    const reviewStale = await notes(A.admin.userId, ["SHIFT_ARRIVAL_NEEDS_REVIEW"], o8.id);
    check("O7 offline «Llegué» (no location): a recent one tells the family; a 45-min-old one does not, but the agency still reviews it",
      fresh.status === 201 && stale.status === 201 && famFresh.length === 1 && famStaleArr.length === 0 && reviewStale.length === 1,
      `recentFamily=${famFresh.length} staleFamily=${famStaleArr.length} agencyReview=${reviewStale.length}`);

    // ================================================================ 5. late alert respects the declared delay
    // shifts are placed in time BEFORE any journey event (a started journey locks the schedule, 107)
    const L = await shift(A.cg[10], 60, 240); await moveStart(L.id, -20);
    const L2 = await shift(A.cg[11], 60, 240); await moveStart(L2.id, -50);
    const N = await shift(A.cg[12], 60, 240); await moveStart(N.id, -20);
    for (const [cg, id] of [[A.cg[10], L.id], [A.cg[11], L2.id]] as const) {
      await enRoute(cg, id);
      await call("POST", `${J(id)}/delay`, cg.token, { minutes: 30, reason: "TRAFFIC", clientEventId: randomUUID() });
    }
    await runJob("app_notify_late_shift_arrivals");
    const today = await call("GET", `/organizations/${orgA}/operations/journeys`, A.admin.token);
    const risk = (id: string) => (((today.body.journeys ?? []) as Json[]).find((j) => j.shiftId === id)?.risks ?? []) as string[];
    const lateL = await notes(A.admin.userId, ["SHIFT_LATE_ARRIVAL"], L.id);
    const lateN = await notes(A.admin.userId, ["SHIFT_LATE_ARRIVAL"], N.id);
    const lateL2 = await notes(A.admin.userId, ["SHIFT_LATE_ARRIVAL"], L2.id);
    check("L1 20 min after start: no «sin llegada» for a caregiver who declared 30 min; alert for one who declared nothing; «Hoy en ruta» agrees",
      lateL.length === 0 && lateN.length === 1 && !risk(L.id).includes("LATE_ARRIVAL") && risk(N.id).includes("LATE_ARRIVAL"),
      `withDelay=${lateL.length} noDelay=${lateN.length} risks=${JSON.stringify(risk(L.id))}/${JSON.stringify(risk(N.id))}`);
    await runJob("app_notify_late_shift_arrivals");
    check("L2 once start + delay + 15 min has passed (50 min), the agency is alerted, once; «Hoy en ruta» agrees",
      lateL2.length === 1 && (await notes(A.admin.userId, ["SHIFT_LATE_ARRIVAL"], L2.id)).length === 1 && risk(L2.id).includes("LATE_ARRIVAL"), JSON.stringify(risk(L2.id)));

    // ================================================================ 6. SmartMatch shift
    const S = `/organizations/${orgA}/smartmatch`;
    const start = new Date(Date.now() + 50 * 60_000); start.setUTCSeconds(0, 0);
    const opp = await call("POST", `${S}/opportunities`, A.admin.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 2 * 3600e3).toISOString() });
    await call("POST", `${S}/opportunities/${opp.body.opportunity.id}/publish`, A.admin.token);
    const app = await call("POST", `${S}/opportunities/${opp.body.opportunity.id}/applications`, A.cg[4].token, { consent: true, consentVersion: "smartmatch-consent-v1" });
    await call("POST", `${S}/applications/${app.body.application.id}/decision`, A.admin.token, { decision: "APPROVE", confirm: true });
    const locId = (await q<{ id: string }>(`SELECT id FROM care_recipient_locations WHERE care_recipient_id=$1`, [rA])).rows[0].id;
    const sm = await call("POST", `${S}/opportunities/${opp.body.opportunity.id}/shift`, A.admin.token, { careRecipientId: rA, serviceLocationId: locId });
    const smId = sm.body.shift?.id as string;
    await call("POST", `/organizations/${orgA}/me/shifts/${smId}/respond`, A.cg[4].token, { decision: "accepted" });
    const smEn = await enRoute(A.cg[4], smId);
    const smCancel = await call("POST", `/organizations/${orgA}/shifts/${smId}/cancel`, A.admin.token, {});
    check("M1 SmartMatch shift: same journey; cancelling it in Turnos tells the caregiver and the family",
      sm.status === 201 && smEn.status === 201 && smCancel.status === 200 && (await notes(A.cg[4].userId, ["SHIFT_CANCELLED"], smId)).length === 1
      && (await notes(A.fam.userId, ["FAMILY_VISIT_CANCELLED"], smId)).length === 1, `shift=${sm.status} enRoute=${smEn.status} cancel=${smCancel.status}`);

    // ================================================================ 7. privacy
    const cols = (await q<{ c: string }>(`SELECT column_name c FROM information_schema.columns WHERE table_name IN ('shift_journey_events','shift_arrivals') AND column_name ~ '(lat|lng|lon|coord|geo|route)'`)).rows.map((x) => x.c);
    const funcs = (await q<{ f: string; pub: boolean }>(`SELECT p.proname f, has_function_privilege('public', p.oid, 'EXECUTE') pub FROM pg_proc p
      WHERE p.proname IN ('app_shift_cancel_notify','app_assignment_removal_notify','app_assignment_delete_closes_alerts','app_journey_event_is_stale','app_shift_declared_delay_minutes')`)).rows;
    check("P1 still no coordinates or route stored; the new functions are not executable by PUBLIC",
      cols.length === 0 && funcs.length === 5 && funcs.every((f) => !f.pub), `cols=${cols.join(",")} funcs=${funcs.map((f) => f.f + ":" + f.pub).join(",")}`);

    check("Z1 no server error (5xx) in the whole run", serverErrors.length === 0, serverErrors.join(" | "));
  } finally {
    for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(130)} ${r.detail}`);
    const passed = results.filter((r) => r.pass).length;
    console.log(`En Camino fixes: ${passed}/${results.length} PASS`);
    server.close(); await pool.end(); await db.end();
    if (passed !== results.length) process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
