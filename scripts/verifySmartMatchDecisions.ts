/**
 * SmartMatch Gate 2 verification over real HTTP + real PostgreSQL commits.
 *
 * Starts the real Express app connected as app_runtime, seeds its own
 * synthetic agencies/users (unique per run, so reruns are safe), and checks
 * applications, withdrawal/re-apply, agency decisions, eligibility blocking,
 * audit history, multi-tenant isolation and concurrency (parallel requests).
 *
 * Disposable databases only. Requires:
 *   ETNARA_DISPOSABLE_DB=true
 *   MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<disposable db>
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

type Json = Record<string, unknown>;
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

async function main() {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => admin.query<T>(s, p);

  // Server connects as app_runtime with a fresh random password.
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!);
  u.username = "app_runtime"; u.password = runtimePassword;
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

  async function call(method: string, path: string, token: string | null, body?: Json) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
  }

  // ---------------------------------------------------------------- seed
  const org = async (name: string) =>
    (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgA = await org(`SM Gate2 A ${tag}`);
  const orgB = await org(`SM Gate2 B ${tag}`);

  async function person(key: string, orgId: string, role: string, opts: { worker?: boolean } = {}) {
    const email = `sm2-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId]);
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [m.rows[0].id, orgId, role]);
    let membershipId: string | null = null; let workerId: string | null = null;
    if (opts.worker) {
      workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Synthetic ${key}`])).rows[0].id;
      membershipId = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
    }
    return { email, userId, membershipId, workerId, token: "" };
  }
  const P = {
    admin1: await person("admin1", orgA, "ORGANIZATION_ADMIN"),
    admin2: await person("admin2", orgA, "ORGANIZATION_ADMIN"),
    supervisor: await person("supervisor", orgA, "SUPERVISOR"),
    w1: await person("w1", orgA, "WORKER", { worker: true }),           // eligible
    w2: await person("w2", orgA, "WORKER", { worker: true }),           // eligible
    w3: await person("w3", orgA, "WORKER", { worker: true }),           // no availability configured
    w4: await person("w4", orgA, "WORKER", { worker: true }),           // missing credential
    w5: await person("w5", orgA, "WORKER", { worker: true }),           // unavailability conflict
    adminB: await person("adminB", orgB, "ORGANIZATION_ADMIN"),
    wB: await person("wB", orgB, "WORKER", { worker: true }),
  };

  // Credentials: org A requires an active BLS credential (no org review).
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,$2) RETURNING id`, [orgA, `SM Gate2 ${tag}`])).rows[0].id;
  await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  for (const w of [P.w1, P.w2, P.w3, P.w5]) {
    await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date + 365)`, [w.workerId, bls]);
  }
  // Availability: every weekday 06:00-22:00 Puerto Rico, except w3 (none).
  for (const w of [P.w1, P.w2, P.w4, P.w5]) {
    await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [w.membershipId, orgA]);
    for (let d = 0; d < 7; d++) {
      await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,'06:00','22:00')`, [w.membershipId, orgA, d]);
    }
  }
  // Opportunities: 10:00-14:00 Puerto Rico time, `days` ahead.
  async function opportunity(orgId: string, creator: string, days: number) {
    return (await q<{ id: string; starts_at: Date; ends_at: Date }>(`
      INSERT INTO smartmatch_opportunities (organization_id,created_by_user_id,visibility,status,region_label,role_label,starts_at,ends_at)
      VALUES ($1,$2,'INTERNAL','PUBLISHED','Caguas','Cuidador',
        (date_trunc('day', now() AT TIME ZONE 'America/Puerto_Rico') + make_interval(days => $3) + interval '10 hours') AT TIME ZONE 'America/Puerto_Rico',
        (date_trunc('day', now() AT TIME ZONE 'America/Puerto_Rico') + make_interval(days => $3) + interval '14 hours') AT TIME ZONE 'America/Puerto_Rico')
      RETURNING id, starts_at, ends_at`, [orgId, creator, days])).rows[0];
  }
  const o1 = await opportunity(orgA, P.admin1.userId, 3);
  const o2 = await opportunity(orgA, P.admin1.userId, 4);
  const o3 = await opportunity(orgA, P.admin1.userId, 5);
  const o4 = await opportunity(orgA, P.admin1.userId, 6);
  const oB = await opportunity(orgB, P.adminB.userId, 3);
  // w5 is unavailable during o1.
  await q(`INSERT INTO worker_unavailability_periods (organization_worker_membership_id,organization_id,starts_at,ends_at,reason) VALUES ($1,$2,$3,$4,'synthetic')`,
    [P.w5.membershipId, orgA, o1.starts_at, o1.ends_at]);

  // ---------------------------------------------------------------- login
  for (const [key, p] of Object.entries(P)) {
    const r = await call("POST", "/auth/login", null, { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${key} failed: ${r.status}`);
    p.token = r.body.token as string;
    const orgId = key.endsWith("B") ? orgB : orgA;
    await call("POST", "/me/active-organization", p.token, { organizationId: orgId });
  }
  const A = `/organizations/${orgA}/smartmatch`;
  const consent = { consent: true, consentVersion: "smartmatch-consent-v1" };
  const apply = (p: { token: string }, oppId: string, body: Json = consent) =>
    call("POST", `${A}/opportunities/${oppId}/applications`, p.token, body);
  const decide = (p: { token: string }, appId: string, body: Json) =>
    call("POST", `${A}/applications/${appId}/decision`, p.token, body);
  const appStatus = async (id: string) => (await q<{ status: string }>(`SELECT status FROM smartmatch_applications WHERE id=$1`, [id])).rows[0]?.status;

  try {
    // ------------------------------------------------ caregiver applications
    const noConsent = await apply(P.w1, o1.id, {});
    check("C1 application without consent rejected", noConsent.status === 400 && noConsent.body.error === "CONSENT_REQUIRED", `status=${noConsent.status}`);
    const oldVersion = await apply(P.w1, o1.id, { consent: true, consentVersion: "v0" });
    check("C2 outdated consent version rejected", oldVersion.status === 400, `status=${oldVersion.status}`);
    const a1 = await apply(P.w1, o1.id);
    check("C3 caregiver applies with consent", a1.status === 201, `status=${a1.status}`);
    const app1 = (a1.body.application as { id: string }).id;
    const dup = await apply(P.w1, o1.id);
    check("C4 duplicate application rejected", dup.status === 409 && dup.body.error === "DUPLICATE_APPLICATION", `status=${dup.status}`);
    const cross = await apply(P.w1, oB.id);
    check("C5 cannot apply to another agency's opportunity", cross.status === 404, `status=${cross.status}`);
    const adminApply = await apply(P.admin1, o1.id);
    check("C6 admin (not a worker) cannot apply", adminApply.status === 403, `status=${adminApply.status}`);

    const wd = await call("POST", `${A}/applications/${app1}/withdraw`, P.w1.token);
    check("C7 caregiver withdraws pending application", wd.status === 200, `status=${wd.status}`);
    const wd2 = await call("POST", `${A}/applications/${app1}/withdraw`, P.w1.token);
    check("C8 second withdrawal rejected", wd2.status === 409, `status=${wd2.status}`);
    const otherWd = await call("POST", `${A}/applications/${app1}/withdraw`, P.w2.token);
    check("C9 another caregiver cannot withdraw it", otherWd.status === 404, `status=${otherWd.status}`);
    const reNoConsent = await apply(P.w1, o1.id, {});
    check("C10 re-apply requires renewed consent", reNoConsent.status === 400, `status=${reNoConsent.status}`);
    const re = await apply(P.w1, o1.id);
    check("C11 re-apply after withdrawal allowed", re.status === 201, `status=${re.status}`);
    const app1b = (re.body.application as { id: string }).id;
    const mine = await call("GET", `${A}/my-applications`, P.w1.token);
    const mineStatuses = ((mine.body.applications ?? []) as { status: string }[]).map(a => a.status).sort().join(",");
    check("C12 'Mis solicitudes' keeps withdrawn history + new pending", mineStatuses === "PENDING,WITHDRAWN", mineStatuses);
    const otherMine = await call("GET", `${A}/my-applications`, P.w2.token);
    check("C13 other caregiver sees none of them", ((otherMine.body.applications ?? []) as unknown[]).length === 0, `count=${(otherMine.body.applications as unknown[])?.length}`);

    // Concurrent re-applications: exactly one wins.
    const race = await Promise.all([apply(P.w2, o1.id), apply(P.w2, o1.id), apply(P.w2, o1.id)]);
    const created = race.filter(r => r.status === 201).length;
    check("C14 three simultaneous applications -> exactly one created", created === 1 && race.every(r => [201, 409].includes(r.status)), race.map(r => r.status).join(","));
    const app2 = (race.find(r => r.status === 201)!.body.application as { id: string }).id;

    // ------------------------------------------------ permissions & isolation
    const confirmMissing = await decide(P.admin1, app1b, { decision: "APPROVE" });
    check("P1 approval without confirmation rejected", confirmMissing.status === 400, `status=${confirmMissing.status}`);
    const byWorker = await decide(P.w2, app1b, { decision: "APPROVE", confirm: true });
    check("P2 caregiver cannot decide", byWorker.status === 403, `status=${byWorker.status}`);
    const bySupervisor = await decide(P.supervisor, app1b, { decision: "REJECT" });
    check("P3 supervisor cannot decide", bySupervisor.status === 403, `status=${bySupervisor.status}`);
    const byAdminBOwnOrg = await call("POST", `/organizations/${orgB}/smartmatch/applications/${app1b}/decision`, P.adminB.token, { decision: "REJECT" });
    check("P4 admin of agency B cannot decide agency A application (no existence leak)", byAdminBOwnOrg.status === 404, `status=${byAdminBOwnOrg.status}`);
    const byAdminBForged = await decide(P.adminB, app1b, { decision: "REJECT" });
    check("P5 admin of agency B with agency A in the URL denied", byAdminBForged.status === 403, `status=${byAdminBForged.status}`);
    const reviewB = await call("GET", `/organizations/${orgB}/smartmatch/applications/${app1b}/review`, P.adminB.token);
    check("P6 admin of agency B cannot review agency A application", reviewB.status === 404, `status=${reviewB.status}`);
    check("P7 application untouched by denied attempts", (await appStatus(app1b)) === "PENDING", String(await appStatus(app1b)));

    // ------------------------------------------------ eligibility blocking
    const a3 = await apply(P.w3, o1.id); const app3 = (a3.body.application as { id: string }).id;
    const a4 = await apply(P.w4, o1.id); const app4 = (a4.body.application as { id: string }).id;
    const a5 = await apply(P.w5, o1.id); const app5 = (a5.body.application as { id: string }).id;
    const b3 = await decide(P.admin1, app3, { decision: "APPROVE", confirm: true });
    const c3 = b3.body.checks as Json | undefined;
    check("E1 no availability configured -> approval blocked", b3.status === 409 && c3?.availabilityConfigured === false && c3?.approvable === false, `status=${b3.status}`);
    const b4 = await decide(P.admin1, app4, { decision: "APPROVE", confirm: true });
    const c4 = b4.body.checks as Json | undefined;
    check("E2 missing credential -> approval blocked", b4.status === 409 && c4?.credentialsEligible === false && JSON.stringify(c4?.unmetRequirementCodes) === '["BLS"]', `status=${b4.status} unmet=${JSON.stringify(c4?.unmetRequirementCodes)}`);
    const b5 = await decide(P.admin1, app5, { decision: "APPROVE", confirm: true });
    const c5 = b5.body.checks as Json | undefined;
    check("E3 time-off overlapping the service -> approval blocked", b5.status === 409 && c5?.noUnavailabilityConflict === false, `status=${b5.status}`);
    // Membership deactivated after applying -> blocked.
    await q(`UPDATE organization_worker_memberships SET status='inactive' WHERE id=$1`, [P.w2.membershipId]);
    const b2 = await decide(P.admin1, app2, { decision: "APPROVE", confirm: true });
    check("E4 inactive membership -> approval blocked", b2.status === 409 && (b2.body.checks as Json)?.membershipActive === false, `status=${b2.status}`);
    await q(`UPDATE organization_worker_memberships SET status='active' WHERE id=$1`, [P.w2.membershipId]);
    check("E5 blocked attempts leave applications PENDING and opportunity PUBLISHED",
      (await appStatus(app3)) === "PENDING" && (await q(`SELECT 1 FROM smartmatch_opportunities WHERE id=$1 AND status='PUBLISHED'`, [o1.id])).rowCount === 1, "");

    const review = await call("GET", `${A}/applications/${app1b}/review`, P.admin1.token);
    const rc = review.body.checks as Json | undefined;
    check("E6 review shows live checks and caregiver name, no patient data",
      review.status === 200 && rc?.approvable === true && (review.body.caregiver as Json)?.displayName === "Synthetic w1" && !JSON.stringify(review.body).match(/patient|diagnos|address/i),
      `status=${review.status} approvable=${rc?.approvable}`);

    // ------------------------------------------------ approval
    const ok = await decide(P.admin1, app1b, { decision: "APPROVE", confirm: true });
    check("D1 eligible application approved", ok.status === 200 && ok.body.outcome === "APPROVED", `status=${ok.status}`);
    const appRow = (await q<{ status: string; decided_by_user_id: string; decided_at: Date; decision_reason: string }>(`SELECT status, decided_by_user_id, decided_at, decision_reason FROM smartmatch_applications WHERE id=$1`, [app1b])).rows[0];
    check("D2 decision records who and when", appRow.status === "APPROVED" && appRow.decided_by_user_id === P.admin1.userId && appRow.decided_at instanceof Date && appRow.decision_reason === "APPROVED_ELIGIBLE", JSON.stringify({ by: appRow.decided_by_user_id === P.admin1.userId, reason: appRow.decision_reason }));
    const oppRow = (await q<{ status: string }>(`SELECT status FROM smartmatch_opportunities WHERE id=$1`, [o1.id])).rows[0];
    check("D3 opportunity marked FILLED", oppRow.status === "FILLED", oppRow.status);
    const assignments = await q(`SELECT 1 FROM assignments WHERE organization_id=$1`, [orgA]);
    check("D4 no real assignment created", assignments.rowCount === 0, `assignments=${assignments.rowCount}`);
    const others = await q<{ status: string; decision_reason: string }>(`SELECT status, decision_reason FROM smartmatch_applications WHERE opportunity_id=$1 AND id<>$2 AND status<>'WITHDRAWN'`, [o1.id, app1b]);
    check("D5 remaining pending applications closed as OPPORTUNITY_FILLED", others.rows.every(r => r.status === "REJECTED" && r.decision_reason === "OPPORTUNITY_FILLED"), others.rows.map(r => r.status).join(","));
    const again = await decide(P.admin2, app1b, { decision: "APPROVE", confirm: true });
    check("D6 approving an already-decided application rejected", again.status === 409, `status=${again.status}`);
    const lateApply = await apply(P.w4, o1.id);
    check("D7 cannot apply to a FILLED opportunity", lateApply.status === 404 || lateApply.status === 409, `status=${lateApply.status}`);
    const mineAfter = await call("GET", `${A}/my-applications`, P.w1.token);
    const approvedRow = ((mineAfter.body.applications ?? []) as { id: string; status: string; opportunity_status: string }[]).find(a => a.id === app1b);
    check("D8 caregiver sees APPROVED and opportunity FILLED", approvedRow?.status === "APPROVED" && approvedRow?.opportunity_status === "FILLED", JSON.stringify(approvedRow ?? null));

    // ------------------------------------------------ audit history
    const events = await call("GET", `${A}/applications/${app1b}/events`, P.admin1.token);
    const ev = (events.body.events ?? []) as { event_type: string; actor_user_id: string }[];
    check("H1 approval recorded in append-only history with actor",
      events.status === 200 && ev.map(e => e.event_type).join(",") === "SUBMITTED,APPROVED" && ev[1]?.actor_user_id === P.admin1.userId,
      ev.map(e => e.event_type).join(","));
    const firstEvents = (await q<{ event_type: string; actor_user_id: string }>(`SELECT event_type, actor_user_id FROM smartmatch_application_events WHERE application_id=$1 ORDER BY occurred_at`, [app1])).rows;
    check("H2 withdrawal recorded with the caregiver as actor",
      firstEvents.map(e => e.event_type).join(",") === "SUBMITTED,WITHDRAWN" && firstEvents.every(e => e.actor_user_id === P.w1.userId),
      firstEvents.map(e => e.event_type).join(","));
    const eventsB = await call("GET", `/organizations/${orgB}/smartmatch/applications/${app1b}/events`, P.adminB.token);
    check("H3 agency B cannot read agency A history", eventsB.status === 404, `status=${eventsB.status}`);
    const eventsW = await call("GET", `${A}/applications/${app1b}/events`, P.w2.token);
    check("H4 caregiver cannot use the agency history endpoint", eventsW.status === 403, `status=${eventsW.status}`);
    let immutable = false;
    try { await q(`UPDATE smartmatch_application_events SET event_type='APPROVED' WHERE application_id=$1`, [app1]); }
    catch (e) { immutable = (e as Error).message.includes("APPEND_ONLY"); }
    check("H5 history is immutable even for the database owner", immutable, String(immutable));

    // ------------------------------------------------ reject
    const r1 = await apply(P.w1, o2.id); const rApp = (r1.body.application as { id: string }).id;
    const rej = await decide(P.admin2, rApp, { decision: "REJECT" });
    check("R1 admin rejects", rej.status === 200 && (await appStatus(rApp)) === "REJECTED", `status=${rej.status}`);
    const reAfterReject = await apply(P.w1, o2.id);
    check("R2 cannot re-apply after an agency rejection", reAfterReject.status === 409, `status=${reAfterReject.status}`);
    const wdRejected = await call("POST", `${A}/applications/${rApp}/withdraw`, P.w1.token);
    check("R3 cannot withdraw a decided application", wdRejected.status === 409, `status=${wdRejected.status}`);

    // An administrator other than the opportunity's creator can approve.
    const o6 = await opportunity(orgA, P.admin1.userId, 8);
    const d9 = (await apply(P.w2, o6.id)).body.application as { id: string };
    const byOtherAdmin = await decide(P.admin2, d9.id, { decision: "APPROVE", confirm: true });
    const o6Status = (await q<{ status: string }>(`SELECT status FROM smartmatch_opportunities WHERE id=$1`, [o6.id])).rows[0].status;
    check("D9 an admin other than the creator can approve (opportunity -> FILLED)", byOtherAdmin.status === 200 && o6Status === "FILLED", `status=${byOtherAdmin.status} opp=${o6Status}`);

    // Server re-validates eligibility at approval time (not trusting the review screen).
    const o8 = await opportunity(orgA, P.admin1.userId, 9);
    const rv = (await apply(P.w2, o8.id)).body.application as { id: string };
    const before = await call("GET", `${A}/applications/${rv.id}/review`, P.admin1.token);
    await q(`UPDATE credentials SET status='revoked' WHERE worker_id=$1`, [P.w2.workerId]);
    const after = await decide(P.admin1, rv.id, { decision: "APPROVE", confirm: true });
    check("E7 credential revoked after review -> server re-checks and blocks approval",
      (before.body.checks as Json)?.approvable === true && after.status === 409 && (after.body.checks as Json)?.credentialsEligible === false && (await appStatus(rv.id)) === "PENDING",
      `before=${(before.body.checks as Json)?.approvable} after=${after.status}`);
    await q(`UPDATE credentials SET status='active' WHERE worker_id=$1`, [P.w2.workerId]);

    // Consent is stored with its text version and is auditable by the agency.
    const consentRow = (await q<{ consented_at: Date | null; consent_version: string | null }>(`SELECT consented_at, consent_version FROM smartmatch_applications WHERE id=$1`, [rv.id])).rows[0];
    const auditEv = await call("GET", `${A}/applications/${rv.id}/events`, P.admin1.token);
    const submitted = ((auditEv.body.events ?? []) as Json[]).find((e) => e.event_type === "SUBMITTED");
    check("H6 consent recorded (timestamp + text version) and visible in the agency audit history",
      consentRow.consented_at instanceof Date && consentRow.consent_version === "smartmatch-consent-v1" && submitted?.consent_version === "smartmatch-consent-v1",
      `version=${consentRow.consent_version} audit=${submitted?.consent_version}`);

    // ------------------------------------------------ concurrency
    // Two admins approve two different eligible applications at the same time.
    const x1 = (await apply(P.w1, o3.id)).body.application as { id: string };
    const x2 = (await apply(P.w2, o3.id)).body.application as { id: string };
    const parallel = await Promise.all([
      decide(P.admin1, x1.id, { decision: "APPROVE", confirm: true }),
      decide(P.admin2, x2.id, { decision: "APPROVE", confirm: true }),
    ]);
    const approvedCount = (await q(`SELECT 1 FROM smartmatch_applications WHERE opportunity_id=$1 AND status='APPROVED'`, [o3.id])).rowCount;
    check("K1 simultaneous approvals -> exactly one approved",
      parallel.filter(r => r.status === 200).length === 1 && parallel.filter(r => r.status === 409).length === 1 && approvedCount === 1,
      parallel.map(r => r.status).join(",") + ` approvedRows=${approvedCount}`);

    // Approval racing the applicant's own withdrawal: exactly one wins.
    const y = (await apply(P.w1, o4.id)).body.application as { id: string };
    const race2 = await Promise.all([
      decide(P.admin1, y.id, { decision: "APPROVE", confirm: true }),
      call("POST", `${A}/applications/${y.id}/withdraw`, P.w1.token),
    ]);
    const finalY = await appStatus(y.id);
    const consistent = (race2[0].status === 200 && race2[1].status === 409 && finalY === "APPROVED") ||
                       (race2[0].status === 409 && race2[1].status === 200 && finalY === "WITHDRAWN");
    check("K2 approval vs withdrawal -> exactly one wins, state consistent", consistent, `${race2.map(r => r.status).join(",")} final=${finalY}`);

    // New applications racing an approval never leave a PENDING row on a FILLED opportunity.
    const o5 = await opportunity(orgA, P.admin1.userId, 7);
    const z1 = (await apply(P.w1, o5.id)).body.application as { id: string };
    const race3 = await Promise.all([
      decide(P.admin1, z1.id, { decision: "APPROVE", confirm: true }),
      apply(P.w2, o5.id),
      apply(P.w5, o5.id),
    ]);
    const pendingOnFilled = (await q(`SELECT 1 FROM smartmatch_applications a JOIN smartmatch_opportunities o ON o.id=a.opportunity_id WHERE o.id=$1 AND o.status='FILLED' AND a.status='PENDING'`, [o5.id])).rowCount;
    check("K3 applications racing an approval leave no PENDING row on a FILLED opportunity",
      race3[0].status === 200 && pendingOnFilled === 0, `${race3.map(r => r.status).join(",")} pendingOnFilled=${pendingOnFilled}`);
  } finally {
    server.close();
    await pool.end();
    await admin.end();
  }

  const width = Math.max(...results.map(r => r.name.length));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter(r => !r.pass).length;
  console.log(`\nSmartMatch decisions: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
