/**
 * SmartMatch real-PostgreSQL RLS verification (Gate 1).
 *
 * Runs every check as the app_runtime role, with the same session context
 * withTenantContext() sets, against a database built from the real
 * migrations. Synthetic data only. Every probe runs in its own transaction
 * and is rolled back; fixtures are created in a transaction that is also
 * rolled back at the end, so nothing persists.
 *
 * NEVER point this at a shared, staging or production database.
 * Usage: ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://...disposable... npx tsx scripts/verifySmartMatchRls.ts
 */
import pg from "pg";

const url = process.env.MIGRATIONS_DATABASE_URL;
if (!url || process.env.ETNARA_DISPOSABLE_DB !== "true") {
  throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
}
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(url)) {
  throw new Error("Refusing to run SmartMatch RLS verification against a hosted database");
}

const client = new pg.Client({ connectionString: url });
const results: { name: string; pass: boolean; detail: string }[] = [];

const id = (prefix: string, n: number) => `${prefix}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_A = id("a0", 1), ORG_B = id("b0", 1);
const U = {
  adminA: id("a1", 1), workerA: id("a2", 1), workerA2: id("a2", 2), inactiveA: id("a2", 3),
  adminA2: id("a1", 2), adminWorkerA: id("a5", 1),
  supervisorA: id("a3", 1), familyA: id("a4", 1), adminB: id("b1", 1), workerB: id("b2", 1), platform: id("c1", 1),
};
const OPP = { aPub: id("d1", 1), aDraft: id("d1", 2), aPast: id("d1", 3), bPub: id("d2", 1) };
const CONSENT = "smartmatch-consent-v1";

type Ctx = { user?: string; org?: string; superadmin?: boolean };

async function asRuntime<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  await client.query("SAVEPOINT probe");
  try {
    await client.query("SET LOCAL ROLE app_runtime");
    if (ctx.user) await client.query("SELECT set_config('app.current_user_id',$1,true)", [ctx.user]);
    if (ctx.org) await client.query("SELECT set_config('app.current_org_id',$1,true)", [ctx.org]);
    await client.query("SELECT set_config('app.is_superadmin',$1,true)", [ctx.superadmin ? "true" : "false"]);
    return await fn();
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT probe");
    await client.query("RESET ROLE");
    await client.query("SELECT set_config('app.current_user_id','',true), set_config('app.current_org_id','',true), set_config('app.is_superadmin','false',true)");
  }
}

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
}

async function expectCount(name: string, ctx: Ctx, sql: string, params: unknown[], expected: number) {
  try {
    const n = await asRuntime(ctx, async () => (await client.query(sql, params)).rowCount ?? 0);
    record(name, n === expected, `rows=${n} expected=${expected}`);
  } catch (e) {
    record(name, false, `unexpected error: ${(e as Error).message}`);
  }
}

async function expectDenied(name: string, ctx: Ctx, sql: string, params: unknown[]) {
  try {
    const n = await asRuntime(ctx, async () => (await client.query(sql, params)).rowCount ?? 0);
    // An UPDATE/DELETE hidden by RLS affects 0 rows; that is also a denial.
    record(name, n === 0, n === 0 ? "0 rows affected" : `NOT DENIED: ${n} rows affected`);
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    // 42501 privilege/RLS, 23514 check, 23505 unique, 23503 FK
    record(name, ["42501", "23514", "23505", "23503"].includes(code), `denied (${code}) ${(e as Error).message}`);
  }
}

async function expectAllowed(name: string, ctx: Ctx, sql: string, params: unknown[], expectedRows = 1) {
  try {
    const n = await asRuntime(ctx, async () => (await client.query(sql, params)).rowCount ?? 0);
    record(name, n === expectedRows, `rows=${n} expected=${expectedRows}`);
  } catch (e) {
    record(name, false, `unexpected error: ${(e as Error).message}`);
  }
}

async function seed() {
  const q = (s: string, p: unknown[] = []) => client.query(s, p);
  await q(`INSERT INTO organizations (id,name,organization_type,status) VALUES ($1,'SM Synthetic A','HOME_CARE_AGENCY','active'),($2,'SM Synthetic B','HOME_CARE_AGENCY','active')`, [ORG_A, ORG_B]);
  await q(`INSERT INTO organization_features (organization_id,feature_code,enabled) SELECT o, 'SMARTMATCH', true FROM unnest($1::uuid[]) o`, [[ORG_A, ORG_B]]);
  for (const [key, uid] of Object.entries(U)) {
    await q(`INSERT INTO users (id,email,status) VALUES ($1,$2,'active')`, [uid, `sm-${key}@example.invalid`]);
  }
  const memberships: [string, string, string, string][] = [
    [U.adminA, ORG_A, "ORGANIZATION_ADMIN", "active"],
    [U.workerA, ORG_A, "WORKER", "active"],
    [U.workerA2, ORG_A, "WORKER", "active"],
    [U.inactiveA, ORG_A, "WORKER", "active"],
    [U.adminA2, ORG_A, "ORGANIZATION_ADMIN", "active"],
    [U.supervisorA, ORG_A, "SUPERVISOR", "active"],
    [U.familyA, ORG_A, "FAMILY", "active"],
    [U.adminB, ORG_B, "ORGANIZATION_ADMIN", "active"],
    [U.workerB, ORG_B, "WORKER", "active"],
  ];
  for (const [user, org, role, status] of memberships) {
    const m = await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,$3) RETURNING id`, [user, org, status]);
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [m.rows[0].id, org, role]);
  }
  // Worker records: inactiveA has the WORKER role but an INACTIVE worker membership.
  for (const [user, org, status] of [[U.workerA, ORG_A, "active"], [U.workerA2, ORG_A, "active"], [U.inactiveA, ORG_A, "inactive"], [U.workerB, ORG_B, "active"]] as const) {
    const w = await q(`INSERT INTO workers (user_id) VALUES ($1) RETURNING id`, [user]);
    await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,$3,'caregiver')`, [w.rows[0].id, org, status]);
  }
  // One user who is both agency administrator and caregiver (same membership).
  const aw = await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [U.adminWorkerA, ORG_A]);
  await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code IN ('ORGANIZATION_ADMIN','WORKER')`, [aw.rows[0].id, ORG_A]);
  const awWorker = await q(`INSERT INTO workers (user_id) VALUES ($1) RETURNING id`, [U.adminWorkerA]);
  await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver')`, [awWorker.rows[0].id, ORG_A]);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [U.platform]);
  const opp = `INSERT INTO smartmatch_opportunities (id,organization_id,created_by_user_id,visibility,status,region_label,role_label,starts_at,ends_at)
               VALUES ($1,$2,$3,'INTERNAL',$4,'Caguas','Cuidador',now()+$5::interval,now()+$5::interval+interval '4 hours')`;
  await q(opp, [OPP.aPub, ORG_A, U.adminA, "PUBLISHED", "2 days"]);
  await q(opp, [OPP.aDraft, ORG_A, U.adminA, "DRAFT", "2 days"]);
  await q(opp, [OPP.bPub, ORG_B, U.adminB, "PUBLISHED", "2 days"]);
  // A past published opportunity, inserted bypassing time-based checks.
  await q(`INSERT INTO smartmatch_opportunities (id,organization_id,created_by_user_id,visibility,status,region_label,role_label,starts_at,ends_at,created_at)
           VALUES ($1,$2,$3,'INTERNAL','PUBLISHED','Caguas','Cuidador',now()-interval '2 days',now()-interval '1 day',now()-interval '3 days')`, [OPP.aPast, ORG_A, U.adminA]);
}

const apply = `INSERT INTO smartmatch_applications (opportunity_id,organization_id,caregiver_user_id,consented_at,consent_version) VALUES ($1,$2,$3,now(),$4)`;
const opps = `SELECT id FROM smartmatch_opportunities`;
const apps = `SELECT id FROM smartmatch_applications`;

async function main() {
  await client.connect();
  await client.query("BEGIN");
  try {
    await seed();
    const wA = { user: U.workerA, org: ORG_A };

    // Discovery (role fix)
    await expectCount("D1 worker A sees only own agency published future opportunity", wA, opps, [], 1);
    await expectCount("D2 worker A cannot see draft", wA, `${opps} WHERE id=$1`, [OPP.aDraft], 0);
    await expectCount("D3 worker A cannot see past opportunity", wA, `${opps} WHERE id=$1`, [OPP.aPast], 0);
    await expectCount("D4 worker B sees only agency B", { user: U.workerB, org: ORG_B }, opps, [], 1);
    await expectCount("D5 worker A with forged org B context sees nothing", { user: U.workerA, org: ORG_B }, opps, [], 0);
    await expectCount("D6 WORKER role with inactive worker membership sees nothing", { user: U.inactiveA, org: ORG_A }, opps, [], 0);
    await expectCount("D7 FAMILY sees nothing", { user: U.familyA, org: ORG_A }, opps, [], 0);
    await expectCount("D8 SUPERVISOR has no SmartMatch access", { user: U.supervisorA, org: ORG_A }, opps, [], 0);
    await expectCount("D9 platform superadmin context sees no opportunities", { user: U.platform, org: ORG_A, superadmin: true }, opps, [], 0);
    await expectCount("D10 no session context sees nothing", {}, opps, [], 0);
    await expectCount("D11 admin A sees all agency A opportunities", { user: U.adminA, org: ORG_A }, opps, [], 3);
    await expectCount("D12 admin A with forged org B sees nothing", { user: U.adminA, org: ORG_B }, opps, [], 0);

    // Submission
    await expectAllowed("S1 worker A applies with consent", wA, apply, [OPP.aPub, ORG_A, U.workerA, CONSENT]);
    await expectDenied("S2 application without consent rejected", wA,
      `INSERT INTO smartmatch_applications (opportunity_id,organization_id,caregiver_user_id) VALUES ($1,$2,$3)`, [OPP.aPub, ORG_A, U.workerA]);
    await expectDenied("S3 apply on behalf of another caregiver", wA, apply, [OPP.aPub, ORG_A, U.workerA2, CONSENT]);
    await expectDenied("S4 apply to draft", wA, apply, [OPP.aDraft, ORG_A, U.workerA, CONSENT]);
    await expectDenied("S5 apply to past opportunity", wA, apply, [OPP.aPast, ORG_A, U.workerA, CONSENT]);
    await expectDenied("S6 apply to agency B opportunity claiming org A", wA, apply, [OPP.bPub, ORG_A, U.workerA, CONSENT]);
    await expectDenied("S7 apply to agency B opportunity claiming org B", wA, apply, [OPP.bPub, ORG_B, U.workerA, CONSENT]);
    await expectDenied("S8 caregiver cannot insert an APPROVED status", wA,
      `INSERT INTO smartmatch_applications (opportunity_id,organization_id,caregiver_user_id,consented_at,consent_version,status) VALUES ($1,$2,$3,now(),$4,'APPROVED')`, [OPP.aPub, ORG_A, U.workerA, CONSENT]);
    await expectDenied("S9 inactive worker cannot apply", { user: U.inactiveA, org: ORG_A }, apply, [OPP.aPub, ORG_A, U.inactiveA, CONSENT]);
    await expectDenied("S10 admin cannot apply as caregiver", { user: U.adminA, org: ORG_A }, apply, [OPP.aPub, ORG_A, U.adminA, CONSENT]);

    // Persist one application (as superuser, inside the outer txn) for the remaining probes.
    const app = (await client.query(`INSERT INTO smartmatch_applications (opportunity_id,organization_id,caregiver_user_id,consented_at,consent_version) VALUES ($1,$2,$3,now(),$4) RETURNING id`, [OPP.aPub, ORG_A, U.workerA, CONSENT])).rows[0].id as string;
    await expectDenied("S11 duplicate application rejected", wA, apply, [OPP.aPub, ORG_A, U.workerA, CONSENT]);
    try {
      await client.query("SAVEPOINT fk");
      await client.query(`INSERT INTO smartmatch_applications (opportunity_id,organization_id,caregiver_user_id,consented_at,consent_version) VALUES ($1,$2,$3,now(),$4)`, [OPP.bPub, ORG_A, U.workerA2, CONSENT]);
      record("S12 organization_id cannot disagree with opportunity (FK, even superuser)", false, "NOT DENIED");
    } catch (e) {
      record("S12 organization_id cannot disagree with opportunity (FK, even superuser)", (e as { code?: string }).code === "23503", (e as Error).message);
    } finally { await client.query("ROLLBACK TO SAVEPOINT fk"); }

    // Reading applications
    await expectCount("R1 worker A reads own application", wA, apps, [], 1);
    await expectCount("R2 worker A2 cannot read worker A application", { user: U.workerA2, org: ORG_A }, apps, [], 0);
    await expectCount("R3 admin A reads agency A applications", { user: U.adminA, org: ORG_A }, apps, [], 1);
    await expectCount("R4 admin B cannot read agency A applications", { user: U.adminB, org: ORG_B }, apps, [], 0);
    await expectCount("R5 admin A with forged org B cannot read", { user: U.adminA, org: ORG_B }, apps, [], 0);
    await expectCount("R6 supervisor cannot read applications", { user: U.supervisorA, org: ORG_A }, apps, [], 0);
    await expectCount("R7 platform superadmin context cannot read applications", { user: U.platform, org: ORG_A, superadmin: true }, apps, [], 0);

    // Decisions are not available to app_runtime directly
    await expectDenied("A1 admin cannot approve by direct UPDATE", { user: U.adminA, org: ORG_A },
      `UPDATE smartmatch_applications SET status='APPROVED' WHERE id=$1`, [app]);
    await expectDenied("A2 admin cannot set decided_by directly (no column grant)", { user: U.adminA, org: ORG_A },
      `UPDATE smartmatch_applications SET decided_by_user_id=$2, decided_at=now() WHERE id=$1`, [app, U.adminA]);
    await expectDenied("A3 caregiver cannot self-approve", wA,
      `UPDATE smartmatch_applications SET status='APPROVED' WHERE id=$1`, [app]);
    await expectDenied("A4 nobody can DELETE applications", { user: U.adminA, org: ORG_A },
      `DELETE FROM smartmatch_applications WHERE id=$1`, [app]);

    // Agency decision rules enforced by RLS/constraints (backend checks are tested over HTTP)
    const CHECKS = JSON.stringify({ approvable: true, membershipActive: true, credentialsEligible: true, availabilityCovers: true, consentRecorded: true });
    const adminA = { user: U.adminA, org: ORG_A };
    await expectDenied("A5 approval signed as another administrator", adminA,
      `UPDATE smartmatch_applications SET status='APPROVED', decided_by_user_id=$2, decided_at=now(), decision_reason='APPROVED_ELIGIBLE', decision_checks=$3::jsonb WHERE id=$1`, [app, U.adminA2, CHECKS]);
    await expectDenied("A6 approval without recorded server checks", adminA,
      `UPDATE smartmatch_applications SET status='APPROVED', decided_by_user_id=$2, decided_at=now(), decision_reason='APPROVED_ELIGIBLE' WHERE id=$1`, [app, U.adminA]);
    await expectAllowed("A7 properly signed approval with checks accepted", adminA,
      `UPDATE smartmatch_applications SET status='APPROVED', decided_by_user_id=$2, decided_at=now(), decision_reason='APPROVED_ELIGIBLE', decision_checks=$3::jsonb WHERE id=$1`, [app, U.adminA, CHECKS]);
    await expectDenied("A8 admin of agency B cannot decide agency A application", { user: U.adminB, org: ORG_B },
      `UPDATE smartmatch_applications SET status='REJECTED', decided_by_user_id=$2, decided_at=now(), decision_reason='AGENCY_REJECTED' WHERE id=$1`, [app, U.adminB]);
    await expectAllowed("A9 admin other than the creator can update opportunity status", { user: U.adminA2, org: ORG_A },
      `UPDATE smartmatch_opportunities SET status='FILLED' WHERE id=$1`, [OPP.aPub]);
    await expectDenied("A10 opportunity creator cannot be rewritten", adminA,
      `UPDATE smartmatch_opportunities SET created_by_user_id=$2 WHERE id=$1`, [OPP.aPub, U.adminA2]);
    const ownApp = (await client.query(`INSERT INTO smartmatch_applications (opportunity_id,organization_id,caregiver_user_id,consented_at,consent_version) VALUES ($1,$2,$3,now(),$4) RETURNING id`, [OPP.aPub, ORG_A, U.adminWorkerA, CONSENT])).rows[0].id as string;
    await expectDenied("A11 admin who is also the applicant cannot decide own application", { user: U.adminWorkerA, org: ORG_A },
      `UPDATE smartmatch_applications SET status='APPROVED', decided_by_user_id=$2, decided_at=now(), decision_reason='APPROVED_ELIGIBLE', decision_checks=$3::jsonb WHERE id=$1`, [ownApp, U.adminWorkerA, CHECKS]);

    // Append-only history
    const events = `SELECT id FROM smartmatch_application_events`;
    await expectCount("V1 admin A reads agency A history", adminA, `${events} WHERE application_id=$1`, [app], 1);
    await expectCount("V2 caregiver reads own history", wA, `${events} WHERE application_id=$1`, [app], 1);
    await expectCount("V3 another caregiver cannot read it", { user: U.workerA2, org: ORG_A }, events, [], 0);
    await expectCount("V4 admin of agency B cannot read it", { user: U.adminB, org: ORG_B }, `${events} WHERE application_id=$1`, [app], 0);
    await expectCount("V5 supervisor cannot read it", { user: U.supervisorA, org: ORG_A }, events, [], 0);
    await expectCount("V6 platform superadmin context cannot read it", { user: U.platform, org: ORG_A, superadmin: true }, events, [], 0);
    await expectDenied("V7 app_runtime cannot forge history", adminA,
      `INSERT INTO smartmatch_application_events (organization_id,application_id,opportunity_id,caregiver_user_id,event_type,new_status) VALUES ($1,$2,$3,$4,'APPROVED','APPROVED')`, [ORG_A, app, OPP.aPub, U.workerA]);
    await expectDenied("V8 app_runtime cannot alter history", adminA, `UPDATE smartmatch_application_events SET event_type='APPROVED'`, []);
    await expectDenied("V9 app_runtime cannot delete history", adminA, `DELETE FROM smartmatch_application_events`, []);

    // Withdrawal
    await expectAllowed("W1 worker A withdraws pending application", wA,
      `UPDATE smartmatch_applications SET status='WITHDRAWN', withdrawn_at=now() WHERE id=$1`, [app]);
    await expectDenied("W2 withdraw without timestamp rejected", wA,
      `UPDATE smartmatch_applications SET status='WITHDRAWN' WHERE id=$1`, [app]);
    await expectDenied("W3 worker A2 cannot withdraw worker A application", { user: U.workerA2, org: ORG_A },
      `UPDATE smartmatch_applications SET status='WITHDRAWN', withdrawn_at=now() WHERE id=$1`, [app]);
    await expectDenied("W4 cannot move opportunity of an application", wA,
      `UPDATE smartmatch_applications SET opportunity_id=$2 WHERE id=$1`, [app, OPP.aDraft]);
    await client.query(`UPDATE smartmatch_applications SET status='WITHDRAWN', withdrawn_at=now() WHERE id=$1`, [app]);
    await expectDenied("W5 cannot withdraw twice / reopen", wA,
      `UPDATE smartmatch_applications SET status='WITHDRAWN', withdrawn_at=now() WHERE id=$1`, [app]);

    // "Mis solicitudes" still shows the opportunity after it closes
    await client.query(`UPDATE smartmatch_opportunities SET status='FILLED' WHERE id=$1`, [OPP.aPub]);
    await expectCount("M1 applicant still sees FILLED opportunity they applied to", wA, `${opps} WHERE id=$1`, [OPP.aPub], 1);
    await expectCount("M2 non-applicant does not see FILLED opportunity", { user: U.workerA2, org: ORG_A }, `${opps} WHERE id=$1`, [OPP.aPub], 0);

    // Opportunity integrity (097)
    const insOpp = (status: string, extraCols = "", extraVals = "") =>
      `INSERT INTO smartmatch_opportunities (organization_id,created_by_user_id,visibility,status,region_label,role_label,starts_at,ends_at${extraCols}) VALUES ($1,$2,'INTERNAL','${status}','Caguas','Cuidador',now()+interval '1 day',now()+interval '1 day 4 hours'${extraVals})`;
    await expectAllowed("G1 admin creates a DRAFT", adminA, insOpp("DRAFT"), [ORG_A, U.adminA]);
    await expectDenied("G2 admin cannot create an opportunity already PUBLISHED", adminA, insOpp("PUBLISHED"), [ORG_A, U.adminA]);
    await expectDenied("G3 admin cannot create an opportunity already FILLED", adminA, insOpp("FILLED"), [ORG_A, U.adminA]);
    await expectDenied("G4 client cannot choose id or created_at", adminA, insOpp("DRAFT", ",created_at", ",now()-interval '9 days'"), [ORG_A, U.adminA]);
    await expectAllowed("G5 any agency admin publishes a draft (not only its creator)", { user: U.adminA2, org: ORG_A },
      `UPDATE smartmatch_opportunities SET status='PUBLISHED' WHERE id=$1 AND status='DRAFT'`, [OPP.aDraft]);
    await expectDenied("G6 admin of agency B cannot publish agency A draft", { user: U.adminB, org: ORG_B },
      `UPDATE smartmatch_opportunities SET status='PUBLISHED' WHERE id=$1`, [OPP.aDraft]);
    await expectDenied("G7 caregiver cannot publish a draft", wA,
      `UPDATE smartmatch_opportunities SET status='PUBLISHED' WHERE id=$1`, [OPP.aDraft]);
    // Migration 109: cancelling a PUBLISHED opportunity needs reason, actor and time.
    await expectDenied("G8a PUBLISHED -> CANCELLED without a reason is refused", adminA,
      `UPDATE smartmatch_opportunities SET status='CANCELLED' WHERE id=$1 AND status='PUBLISHED'`, [OPP.aPast]);
    await expectAllowed("G8 PUBLISHED -> CANCELLED allowed with reason, actor and time", adminA,
      `UPDATE smartmatch_opportunities SET status='CANCELLED', cancellation_reason='NO_LONGER_NEEDED', cancelled_at=now(), cancelled_by_user_id=$2
       WHERE id=$1 AND status='PUBLISHED'`, [OPP.aPast, U.adminA]);
    await expectDenied("G9 schedule cannot change after publishing", adminA,
      `UPDATE smartmatch_opportunities SET starts_at=starts_at+interval '1 day', ends_at=ends_at+interval '1 day' WHERE id=$1`, [OPP.aPub]);
    await expectDenied("G10 municipality/role cannot change after publishing", adminA,
      `UPDATE smartmatch_opportunities SET region_label='Ponce' WHERE id=$1`, [OPP.aPub]);
    await expectAllowed("G11 draft terms remain editable", adminA,
      `UPDATE smartmatch_opportunities SET region_label='Ponce' WHERE id=$1`, [OPP.aDraft]);
    await client.query("SAVEPOINT g12");
    await client.query(`UPDATE smartmatch_opportunities SET status='FILLED' WHERE id=$1`, [OPP.bPub]);
    await client.query("RELEASE SAVEPOINT g12");
    await expectDenied("G12 FILLED cannot be reopened (admin)", { user: U.adminB, org: ORG_B },
      `UPDATE smartmatch_opportunities SET status='PUBLISHED' WHERE id=$1`, [OPP.bPub]);
    try {
      await client.query("SAVEPOINT g13");
      await client.query(`UPDATE smartmatch_opportunities SET status='PUBLISHED' WHERE id=$1`, [OPP.bPub]);
      record("G13 FILLED cannot be reopened even by privileged SQL", false, "NOT DENIED");
    } catch (e) {
      record("G13 FILLED cannot be reopened even by privileged SQL", (e as Error).message.includes("INVALID_STATUS_TRANSITION"), (e as Error).message);
    } finally { await client.query("ROLLBACK TO SAVEPOINT g13"); }
    const pendingApp = (await client.query(`INSERT INTO smartmatch_applications (opportunity_id,organization_id,caregiver_user_id,consented_at,consent_version) VALUES ($1,$2,$3,now(),$4) RETURNING id`, [OPP.aPub, ORG_A, U.workerA2, CONSENT])).rows[0].id as string;
    await expectDenied("G14 withdrawal cannot carry decision data", { user: U.workerA2, org: ORG_A },
      `UPDATE smartmatch_applications SET status='WITHDRAWN', withdrawn_at=now(), decision_checks='{"approvable":true}'::jsonb WHERE id=$1`, [pendingApp]);

    // Network lock
    await expectDenied("N1 admin cannot create NETWORK opportunity", { user: U.adminA, org: ORG_A },
      `INSERT INTO smartmatch_opportunities (organization_id,created_by_user_id,visibility,region_label,role_label,starts_at,ends_at) VALUES ($1,$2,'NETWORK','Caguas','Cuidador',now()+interval '1 day',now()+interval '2 days')`, [ORG_A, U.adminA]);
    await expectDenied("N2 admin cannot switch opportunity to NETWORK", { user: U.adminA, org: ORG_A },
      `UPDATE smartmatch_opportunities SET visibility='NETWORK' WHERE id=$1`, [OPP.aDraft]);
    try {
      await client.query("SAVEPOINT net");
      await client.query(`UPDATE smartmatch_opportunities SET visibility='NETWORK' WHERE id=$1`, [OPP.aDraft]);
      record("N3 direct privileged UPDATE to NETWORK blocked", false, "NOT DENIED");
    } catch (e) {
      record("N3 direct privileged UPDATE to NETWORK blocked", (e as { code?: string }).code === "23514", (e as Error).message);
    } finally { await client.query("ROLLBACK TO SAVEPOINT net"); }
    await expectDenied("N4 admin cannot move opportunity to another agency", { user: U.adminA, org: ORG_A },
      `UPDATE smartmatch_opportunities SET organization_id=$2 WHERE id=$1`, [OPP.aDraft, ORG_B]);

    // Single approval invariant (database last line of defense)
    const a1 = (await client.query(`INSERT INTO smartmatch_applications (opportunity_id,organization_id,caregiver_user_id,consented_at,consent_version,status,decided_by_user_id,decided_at,decision_reason,decision_checks) VALUES ($1,$2,$3,now(),$4,'APPROVED',$5,now(),'APPROVED_ELIGIBLE','{"approvable":true,"membershipActive":true,"credentialsEligible":true,"availabilityCovers":true,"consentRecorded":true}') RETURNING id`, [OPP.bPub, ORG_B, U.workerB, CONSENT, U.adminB])).rows[0].id;
    try {
      await client.query("SAVEPOINT dup");
      await client.query(`INSERT INTO smartmatch_applications (opportunity_id,organization_id,caregiver_user_id,consented_at,consent_version,status,decided_by_user_id,decided_at,decision_reason,decision_checks) VALUES ($1,$2,$3,now(),$4,'APPROVED',$5,now(),'APPROVED_ELIGIBLE','{"approvable":true,"membershipActive":true,"credentialsEligible":true,"availabilityCovers":true,"consentRecorded":true}')`, [OPP.bPub, ORG_B, U.adminB, CONSENT, U.adminB]);
      record("I1 second APPROVED on same opportunity blocked", false, "NOT DENIED");
    } catch (e) {
      record("I1 second APPROVED on same opportunity blocked", (e as { code?: string }).code === "23505", `${(e as Error).message} (first=${a1})`);
    } finally { await client.query("ROLLBACK TO SAVEPOINT dup"); }
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }

  const width = Math.max(...results.map(r => r.name.length));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter(r => !r.pass).length;
  console.log(`\nSmartMatch RLS: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
