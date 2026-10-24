/**
 * AUDIT PROBES (diagnostic only, not committed). Targets cases the existing
 * verifiers do not cover. Disposable local database only; synthetic data.
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@127.0.0.1/<db>
 * Each probe prints OBSERVED behaviour plus EXPECTED (what a safe pilot needs).
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
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const { hashPassword } = await import("../../src/security/password.js");
  const { createApp } = await import("../../src/app.js");
  const { pool } = await import("../../src/config/db.js");
  const server = createApp().listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex"); const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  const statuses5xx: string[] = [];

  async function call(method: string, path: string, token: string, body?: unknown, raw?: string) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const text = await res.text(); let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 80) }; }
    if (res.status >= 500) statuses5xx.push(`${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")} -> ${res.status} ${JSON.stringify(parsed).slice(0, 80)}`);
    return { status: res.status, body: parsed };
  }
  const org = async (name: string) => (await q<{ id: string }>(`WITH o AS (INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id), f AS (INSERT INTO organization_features (organization_id,feature_code,enabled) SELECT o.id, c, true FROM o, unnest(ARRAY['SMARTMATCH','EN_CAMINO']) c) SELECT id FROM o`, [name])).rows[0].id;
  const orgA = await org(`Audit A ${tag}`); const orgB = await org(`Audit B ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  for (const o of [orgA, orgB]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'AUD') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  }
  type P = { email: string; userId: string; token: string; owm?: string };
  async function person(key: string, orgId: string, roles: string[], worker = false, from = "00:00", to = "23:59"): Promise<P> {
    const email = `aud-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let owm: string | undefined;
    if (worker) {
      const wid = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Synthetic ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [wid, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [wid, bls]);
      await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [owm, orgId]);
      for (let d = 0; d < 7; d++) await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,$4,$5)`, [owm, orgId, d, from, to]);
    }
    return { email, userId, token: "", owm };
  }
  const A = {
    admin: await person("admin", orgA, ["ORGANIZATION_ADMIN"]), admin2: await person("admin2", orgA, ["ORGANIZATION_ADMIN"]),
    sup: await person("sup", orgA, ["SUPERVISOR"]), fam: await person("fam", orgA, ["FAMILY"]), plat: await person("plat", orgA, []),
    cg1: await person("cg1", orgA, ["WORKER"], true), cg2: await person("cg2", orgA, ["WORKER"], true),
    cg3: await person("cg3", orgA, ["WORKER"], true), cgDay: await person("cgday", orgA, ["WORKER"], true, "08:00", "12:00"),
  };
  const B = { admin: await person("badmin", orgB, ["ORGANIZATION_ADMIN"]), cg: await person("bcg", orgB, ["WORKER"], true) };
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [A.plat.userId]);
  for (const [p, o] of [...Object.values(A).map((p) => [p, orgA] as const), ...Object.values(B).map((p) => [p, orgB] as const)]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password }); if (r.status !== 200) throw new Error(`login ${r.status}`);
    p.token = r.body.token; await call("POST", "/me/active-organization", p.token, { organizationId: o });
  }
  const S = `/organizations/${orgA}/smartmatch`;
  const consent = { consent: true, consentVersion: "smartmatch-consent-v1" };
  const rA = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Sintetico','Aud','active') RETURNING id`, [orgA])).rows[0].id;
  const rA2 = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Sintetico','Aud2','active') RETURNING id`, [orgA])).rows[0].id;
  // Puerto Rico local time (UTC-4) helpers.
  const prAt = (days: number, hourLocal: number) => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + days, hourLocal + 4)); };
  async function opp(start: Date, hours: number, token = A.admin.token) {
    const d = await call("POST", `${S}/opportunities`, token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + hours * 3600e3).toISOString() });
    const id = d.body.opportunity?.id as string;
    const p = await call("POST", `${S}/opportunities/${id}/publish`, token);
    return { id, create: d.status, publish: p.status };
  }
  const apply = async (oppId: string, cg: P) => (await call("POST", `${S}/opportunities/${oppId}/applications`, cg.token, consent)).body.application?.id as string;
  const decide = (appId: string, decision: "APPROVE" | "REJECT", token = A.admin.token) =>
    call("POST", `${S}/applications/${appId}/decision`, token, decision === "APPROVE" ? { decision, confirm: true } : { decision });
  const notes = async (p: P) => ((await call("GET", "/me/notifications?limit=100", p.token)).body.items ?? []) as Json[];

  try {
    // ---------------------------------------------------------------- 4. availability / schedule
    // 4a overnight visit (20:00 -> 04:00 local), caregiver available all day every day
    const night = await opp(prAt(3, 20), 8);
    const nApp = await apply(night.id, A.cg1);
    const nRev = await call("GET", `${S}/applications/${nApp}/review`, A.admin.token);
    const nDec = await decide(nApp, "APPROVE");
    probe("4a overnight visit (20:00-04:00) with caregiver available 00:00-23:59 every day", nDec.status === 200,
      `review.availabilityCovers=${nRev.body.checks?.availabilityCovers} decision=${nDec.status} ${nDec.body.error ?? nDec.body.outcome ?? ""}`,
      "approvable (24h availability covers it)");
    // 4b opportunity outside availability window (caregiver 08-12, visit 14-18) -> must block
    const pm = await opp(prAt(4, 14), 4);
    const pmApp = await apply(pm.id, A.cgDay);
    const pmDec = await decide(pmApp, "APPROVE");
    probe("4b visit 14:00-18:00, caregiver only available 08:00-12:00", pmDec.status === 409,
      `decision=${pmDec.status} ${pmDec.body.error ?? ""}`, "blocked 409");
    // 4c visit partly outside window (11:00-13:00 vs 08-12) -> must block
    const part = await opp(prAt(5, 11), 2);
    const partApp = await apply(part.id, A.cgDay);
    const partDec = await decide(partApp, "APPROVE");
    probe("4c visit 11:00-13:00 partly outside 08:00-12:00", partDec.status === 409, `decision=${partDec.status} ${partDec.body.error ?? ""}`, "blocked 409");
    // 4d same caregiver approved for two overlapping opportunities
    const o1 = await opp(prAt(6, 9), 4); const o2 = await opp(prAt(6, 11), 4);
    const a1 = await apply(o1.id, A.cg2); const a2 = await apply(o2.id, A.cg2); const a2other = await apply(o2.id, A.cg3);
    const d1 = await decide(a1, "APPROVE"); const d2 = await decide(a2, "APPROVE");
    probe("4d same caregiver approved for two overlapping visits (09-13 and 11-15)", d2.status === 409,
      `first=${d1.status} second=${d2.status} ${d2.body.error ?? d2.body.outcome ?? ""}`, "second approval blocked (caregiver already committed)");
    const s1 = await call("POST", `${S}/opportunities/${o1.id}/shift`, A.admin.token, { careRecipientId: rA });
    const s2 = await call("POST", `${S}/opportunities/${o2.id}/shift`, A.admin.token, { careRecipientId: rA2 });
    const otherStatus = (await q<{ status: string; closed_reason: string | null; decision_reason: string | null }>(`SELECT status, closed_reason, decision_reason FROM smartmatch_applications WHERE id=$1`, [a2other])).rows[0];
    const o2row = (await q<{ status: string; shift_id: string | null }>(`SELECT status, shift_id FROM smartmatch_opportunities WHERE id=$1`, [o2.id])).rows[0];
    probe("4e consequence of 4d: second shift creation and the other applicant", !(d2.status === 200 && s2.status === 409),
      `shift1=${s1.status} shift2=${s2.status} ${s2.body.error ?? ""}; opp2=${o2row.status} shift=${o2row.shift_id ?? "none"}; other applicant=${otherStatus.status}/${otherStatus.decision_reason ?? otherStatus.closed_reason}`,
      "no FILLED opportunity left without a possible shift while other applicants were already turned away");
    // 4f approval when caregiver already has a regular (non-SmartMatch) shift at the same time
    const reg = await call("POST", `/organizations/${orgA}/shifts`, A.admin.token, { careRecipientId: rA, scheduledStart: prAt(7, 9).toISOString(), scheduledEnd: prAt(7, 13).toISOString() });
    let assigned = 0;
    if (reg.status === 201) { const as = await call("POST", `/organizations/${orgA}/shifts/${reg.body.shift?.id}/assignments`, A.admin.token, { organizationWorkerMembershipId: A.cg3.owm }); assigned = as.status; }
    const o3 = await opp(prAt(7, 10), 2); const a3 = await apply(o3.id, A.cg3); const d3 = await decide(a3, "APPROVE");
    probe("4f approval while caregiver already has a regular shift at that time", d3.status === 409,
      `regularShift=${reg.status} assign=${assigned} decision=${d3.status} ${d3.body.error ?? d3.body.outcome ?? ""}`, "blocked or at least flagged in review");

    // ---------------------------------------------------------------- 1. cancellation
    const draft = await call("POST", `${S}/opportunities`, A.admin.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: prAt(8, 9).toISOString(), endsAt: prAt(8, 13).toISOString() });
    const dc = await call("POST", `${S}/opportunities/${draft.body.opportunity?.id}/cancel`, A.admin.token, { reason: "NO_LONGER_NEEDED" });
    probe("1a cancel a DRAFT (never published)", true, `cancel=${dc.status} ${dc.body.error ?? ""}`, "informational: drafts cannot be discarded via API");
    const f = await opp(prAt(9, 9), 4); const fa = await apply(f.id, A.cg1); await decide(fa, "APPROVE");
    const before = (await notes(A.cg1)).length;
    const fc = await call("POST", `${S}/opportunities/${f.id}/cancel`, A.admin.token, { reason: "SCHEDULE_CHANGED" });
    const after = await notes(A.cg1);
    const appRow = (await q<{ status: string }>(`SELECT status FROM smartmatch_applications WHERE id=$1`, [fa])).rows[0];
    const told = after.length - before;
    const myApps = ((await call("GET", `${S}/my-applications`, A.cg1.token)).body.applications ?? []) as Json[];
    const mine = myApps.find((x) => x.id === fa);
    probe("1b cancel a FILLED opportunity (approved, no shift yet): approved caregiver informed?", told >= 1,
      `cancel=${fc.status}; application=${appRow?.status}; new notices for caregiver=${told}; caregiver view status=${mine?.status} opp=${mine?.opportunity_status ?? mine?.opportunityStatus}`,
      "approved caregiver gets a notice that the visit was cancelled");
    const fc2 = await call("POST", `${S}/opportunities/${f.id}/cancel`, A.admin2.token, { reason: "OTHER" });
    probe("1c cancel twice", fc2.status === 409, `second=${fc2.status}`, "409");
    const ghost = await call("POST", `${S}/opportunities/${randomUUID()}/cancel`, A.admin.token, { reason: "OTHER" });
    probe("1d cancel unknown id", ghost.status === 404, `status=${ghost.status}`, "404");

    // ---------------------------------------------------------------- 2. reject / withdraw
    const r = await opp(prAt(10, 9), 4); const ra = await apply(r.id, A.cg1);
    const rj = await decide(ra, "REJECT");
    const rjNote = (await notes(A.cg1)).filter((n) => n.relatedEntityId === ra);
    const rjEv = await call("GET", `${S}/applications/${ra}/events`, A.admin.token);
    probe("2a reject: caregiver notified once, history has actor", rj.status === 200 && rjNote.length === 1 && JSON.stringify(rjEv.body).includes("REJECTED"),
      `reject=${rj.status} notices=${rjNote.length} events=${rjEv.status}`, "200, one notice, REJECTED event with actor");
    const rw = await call("POST", `${S}/applications/${ra}/withdraw`, A.cg1.token);
    probe("2b withdraw after rejection", rw.status === 409, `status=${rw.status}`, "409");
    const rr = await decide(ra, "REJECT", A.admin2.token);
    probe("2c reject twice (second admin)", rr.status === 409, `status=${rr.status}`, "409");
    const wa = await apply(r.id, A.cg2); await call("POST", `${S}/applications/${wa}/withdraw`, A.cg2.token);
    const wd = await decide(wa, "APPROVE");
    probe("2d approve a withdrawn application", wd.status === 409, `status=${wd.status}`, "409");

    // ---------------------------------------------------------------- 3. duplicates
    const dup = await opp(prAt(11, 9), 4);
    const results = await Promise.all(Array.from({ length: 8 }, () => call("POST", `${S}/opportunities/${dup.id}/applications`, A.cg1.token, consent)));
    const rows = (await q<{ n: string }>(`SELECT count(*) n FROM smartmatch_applications WHERE opportunity_id=$1 AND status='PENDING'`, [dup.id])).rows[0].n;
    probe("3a eight simultaneous applications, same caregiver", rows === "1" && results.filter((x) => x.status === 201).length === 1,
      `statuses=${results.map((x) => x.status).sort().join(",")} pendingRows=${rows}`, "exactly one");
    const pubTwice = await Promise.all([1, 2, 3].map(() => call("POST", `${S}/opportunities/${dup.id}/publish`, A.admin.token)));
    probe("3b publish an already published opportunity (x3 concurrent)", pubTwice.every((x) => x.status >= 400 && x.status < 500), pubTwice.map((x) => x.status).join(","), "4xx, no duplicate history");

    // ---------------------------------------------------------------- 7. permission matrix (every endpoint x role)
    const pm2 = await opp(prAt(12, 9), 4); const pmApp2 = await apply(pm2.id, A.cg1);
    const endpoints: [string, string, unknown?][] = [
      ["POST", `${S}/opportunities`, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: prAt(13, 9).toISOString(), endsAt: prAt(13, 12).toISOString() }],
      ["GET", `${S}/opportunities`], ["GET", `${S}/application-counts`], ["GET", `${S}/opportunities/${pm2.id}/applications`],
      ["GET", `${S}/opportunities/${pm2.id}/review-queue`], ["GET", `${S}/applications/${pmApp2}/review`], ["GET", `${S}/applications/${pmApp2}/events`],
      ["POST", `${S}/applications/${pmApp2}/decision`, { decision: "REJECT" }], ["GET", `${S}/opportunities/${pm2.id}/shift-draft`],
      ["POST", `${S}/opportunities/${pm2.id}/cancel`, { reason: "OTHER" }], ["GET", `${S}/opportunities/${pm2.id}/history`],
    ];
    const roles: [string, P][] = [["supervisor", A.sup], ["caregiver", A.cg2], ["family", A.fam], ["platform", A.plat], ["agencyB-admin", B.admin], ["agencyB-caregiver", B.cg]];
    const leaks: string[] = []; const matrix: string[] = [];
    for (const [m, path, body] of endpoints) {
      const row: string[] = [];
      for (const [rn, p] of roles) {
        const res = await call(m, path, p.token, body);
        row.push(`${rn}=${res.status}`);
        if (res.status < 400) leaks.push(`${m} ${path.replace(S, "").replace(/[0-9a-f-]{36}/g, ":id")} ${rn} -> ${res.status}`);
      }
      matrix.push(`${m} ${path.replace(S, "").replace(/[0-9a-f-]{36}/g, ":id")}: ${row.join(" ")}`);
    }
    const famBrowse = await call("GET", `${S}/available-opportunities`, A.fam.token);
    const famMine = await call("GET", `${S}/my-applications`, A.fam.token);
    probe("7a admin-only endpoints refuse supervisor, caregiver, family, ETNARA Central and agency B", leaks.length === 0, leaks.join(" | ") || "all 4xx", "every non-admin call 4xx");
    probe("7b family cannot browse or list applications", famBrowse.status === 403 && famMine.status === 403, `${famBrowse.status},${famMine.status}`, "403,403");
    const pmStill = (await q<{ status: string }>(`SELECT status FROM smartmatch_applications WHERE id=$1`, [pmApp2])).rows[0].status;
    probe("7c denied calls changed nothing", pmStill === "PENDING", `application=${pmStill}`, "PENDING");

    // ---------------------------------------------------------------- 6. cross-org with forged ids
    const bOpp = await call("POST", `/organizations/${orgB}/smartmatch/opportunities`, B.admin.token, { visibility: "INTERNAL", regionLabel: "Ponce", roleLabel: "Cuidador/a", startsAt: prAt(14, 9).toISOString(), endsAt: prAt(14, 12).toISOString() });
    await call("POST", `/organizations/${orgB}/smartmatch/opportunities/${bOpp.body.opportunity?.id}/publish`, B.admin.token);
    const viaA = await call("POST", `${S}/opportunities/${bOpp.body.opportunity?.id}/applications`, A.cg1.token, consent);
    const listA = ((await call("GET", `${S}/available-opportunities`, A.cg1.token)).body.opportunities ?? []) as Json[];
    const cancelViaA = await call("POST", `${S}/opportunities/${bOpp.body.opportunity?.id}/cancel`, A.admin.token, { reason: "OTHER" });
    const histViaA = await call("GET", `${S}/opportunities/${bOpp.body.opportunity?.id}/history`, A.admin.token);
    const bStill = (await q<{ status: string }>(`SELECT status FROM smartmatch_opportunities WHERE id=$1`, [bOpp.body.opportunity?.id])).rows[0]?.status;
    probe("6a agency-B opportunity id used inside agency-A URLs (apply, cancel, history) + discovery", viaA.status === 404 && cancelViaA.status === 404 && histViaA.status === 404 && !listA.some((o) => o.id === bOpp.body.opportunity?.id) && bStill === "PUBLISHED",
      `apply=${viaA.status} cancel=${cancelViaA.status} history=${histViaA.status} inListA=${listA.some((o) => o.id === bOpp.body.opportunity?.id)} B=${bStill}`, "404s, invisible, untouched");

    // ---------------------------------------------------------------- 8. error handling (no 5xx, clear 4xx)
    const bad: [string, string, unknown?, string?][] = [
      ["GET", `${S}/applications/not-a-uuid/review`], ["POST", `${S}/applications/not-a-uuid/decision`, { decision: "APPROVE", confirm: true }],
      ["POST", `${S}/opportunities/not-a-uuid/cancel`, { reason: "OTHER" }], ["GET", `/organizations/not-a-uuid/smartmatch/opportunities`],
      ["POST", `${S}/opportunities`, undefined, "{not json"], ["POST", `${S}/opportunities`, { visibility: "INTERNAL" }],
      ["POST", `${S}/opportunities`, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "x".repeat(5000), startsAt: prAt(3, 9).toISOString(), endsAt: prAt(3, 12).toISOString() }],
      ["POST", `${S}/opportunities`, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: prAt(3, 12).toISOString(), endsAt: prAt(3, 9).toISOString() }],
      ["POST", `${S}/opportunities/${pm2.id}/applications`, { consent: "yes", consentVersion: 1 }],
      ["POST", `${S}/applications/${pmApp2}/decision`, { decision: "MAYBE" }],
      ["POST", `${S}/opportunities/${pm2.id}/cancel`, { reason: "BECAUSE", note: "x".repeat(10000) }],
    ];
    const badRes: string[] = [];
    for (const [m, path, body, raw] of bad) { const r2 = await call(m, path, path.includes("/applications") && m === "POST" && !path.includes("decision") ? A.cg2.token : A.admin.token, body, raw); badRes.push(`${r2.status}`); }
    probe("8a malformed ids / bodies / oversized fields never produce a server error", badRes.every((s) => Number(s) >= 400 && Number(s) < 500), badRes.join(","), "all 4xx");
    const past = await call("POST", `${S}/opportunities`, A.admin.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: prAt(-2, 9).toISOString(), endsAt: prAt(-2, 12).toISOString() });
    const pastPub = past.body.opportunity?.id ? await call("POST", `${S}/opportunities/${past.body.opportunity.id}/publish`, A.admin.token) : { status: 0, body: {} };
    probe("8b opportunity in the past", past.status >= 400 || pastPub.status >= 400, `create=${past.status} publish=${pastPub.status}`, "refused at create or publish");
    const long = await call("POST", `${S}/opportunities`, A.admin.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: prAt(3, 9).toISOString(), endsAt: prAt(33, 9).toISOString() });
    probe("8c opportunity lasting 30 days", long.status >= 400, `create=${long.status}`, "informational: is there a maximum duration?");
    const net = await call("POST", `${S}/opportunities`, A.admin.token, { visibility: "NETWORK", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: prAt(3, 9).toISOString(), endsAt: prAt(3, 12).toISOString() });
    probe("8d NETWORK visibility (cross-agency) is not available in the pilot", net.status >= 400, `create=${net.status} ${net.body.error ?? ""}`, "refused");

    // ---------------------------------------------------------------- 8. audit trail completeness
    const ev = (await q<{ event_type: string; actor: boolean }>(`SELECT event_type, actor_user_id IS NOT NULL actor FROM smartmatch_opportunity_events WHERE opportunity_id=$1 ORDER BY occurred_at`, [f.id])).rows;
    const apEv = (await q<{ event_type: string; actor: boolean }>(`SELECT event_type, actor_user_id IS NOT NULL actor FROM smartmatch_application_events WHERE application_id=$1 ORDER BY occurred_at`, [fa])).rows;
    probe("8e audit trail of a cancelled FILLED opportunity (opportunity + approved application)", ev.length >= 4 && ev.every((e) => e.actor),
      `opportunity=${ev.map((e) => e.event_type + (e.actor ? "*" : "")).join(">")} application=${apEv.map((e) => e.event_type + (e.actor ? "*" : "")).join(">")}`, "CREATED>PUBLISHED>FILLED>CANCELLED with actor (*)");
    const oppCols = (await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='smartmatch_opportunity_events'`)).rows.map((x) => x.column_name);
    probe("8f info: opportunity history columns", true, oppCols.join(","), "-");

    probe("8g no server error (5xx) during the whole probe run", statuses5xx.length === 0, statuses5xx.join(" | ") || "none", "none");
    console.log("MATRIX\n  " + matrix.join("\n  "));
  } finally {
    for (const o of out) console.log(`${o.ok ? "OK  " : "GAP "} ${o.id}\n      observed: ${o.observed}\n      expected: ${o.expected}`);
    console.log(`AUDIT PROBES: ${out.filter((o) => o.ok).length}/${out.length} as expected`);
    server.close(); await pool.end(); await db.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
