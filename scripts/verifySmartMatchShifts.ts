/**
 * SmartMatch Gate 5 (Turnos): "Crear turno con esta cuidadora", over real
 * HTTP with the server connected as app_runtime, plus direct RLS probes for
 * the private instructions. Synthetic data only, unique per run.
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

  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
  }

  const org = async (name: string) =>
    (await q<{ id: string }>(`WITH o AS (INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id), f AS (INSERT INTO organization_features (organization_id,feature_code,enabled) SELECT o.id, c, true FROM o, unnest(ARRAY['SMARTMATCH','EN_CAMINO']) c) SELECT id FROM o`, [name])).rows[0].id;
  const orgA = await org(`SM Shift A ${tag}`);
  const orgB = await org(`SM Shift B ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  for (const o of [orgA, orgB]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'G5') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  }
  type P = { email: string; userId: string; token: string; workerId?: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `sm5s-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let workerId: string | undefined;
    if (worker) {
      workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Synthetic ${key}`])).rows[0].id;
      const owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
      await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [owm, orgId]);
      for (let d = 0; d < 7; d++) await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,'06:00','22:00')`, [owm, orgId, d]);
    }
    return { email, userId, token: "", workerId };
  }
  const A = {
    admin1: await person("a-admin1", orgA, ["ORGANIZATION_ADMIN"]),
    admin2: await person("a-admin2", orgA, ["ORGANIZATION_ADMIN"]),
    adminWorker: await person("a-adminworker", orgA, ["ORGANIZATION_ADMIN", "WORKER"], true),
    supervisor: await person("a-supervisor", orgA, ["SUPERVISOR"]),
    cg1: await person("a-cg1", orgA, ["WORKER"], true),
    cg2: await person("a-cg2", orgA, ["WORKER"], true),
    cg3: await person("a-cg3", orgA, ["WORKER"], true),
    cg4: await person("a-cg4", orgA, ["WORKER"], true),
    family: await person("a-family", orgA, ["FAMILY"]),
    platform: await person("a-platform", orgA, []),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]), cg: await person("b-cg", orgB, ["WORKER"], true) };
  for (const [p, o] of [...Object.values(A).map((p) => [p, orgA] as const), ...Object.values(B).map((p) => [p, orgB] as const)]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${p.email} ${r.status}`);
    p.token = r.body.token;
    await call("POST", "/me/active-organization", p.token, { organizationId: o });
  }
  const S = `/organizations/${orgA}/smartmatch`;
  const consent = { consent: true, consentVersion: "smartmatch-consent-v1" };
  async function opportunity(days: number) {
    const now = new Date(); const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, 14));
    const d = await call("POST", `${S}/opportunities`, A.admin1.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 4 * 3600e3).toISOString() });
    await call("POST", `${S}/opportunities/${d.body.opportunity.id}/publish`, A.admin1.token);
    return d.body.opportunity.id as string;
  }
  const smartmatch = async (p: P, appId?: string) => {
    const r = await call("GET", "/me/notifications?limit=100", p.token);
    return ((r.body.items ?? []) as Json[]).filter((n) => n.relatedEntityType === "smartmatch_application" && (!appId || n.relatedEntityId === appId));
  };
  const unread = (list: Json[]) => list.filter((n) => !n.readAt).length;

  // Synthetic people receiving care (never real data).
  const recipient = async (o: string, status = "active") =>
    (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Sintetico',$2,$3) RETURNING id`, [o, `R-${tag}`, status])).rows[0].id;
  const rA = await recipient(orgA);
  const rA2 = await recipient(orgA);
  const rArchived = await recipient(orgA, "archived");
  const rB = await recipient(orgB);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hijo','active')`, [A.family.userId, orgA, rA]);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [A.platform.userId]);

  const runtime = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await runtime.connect();
  /** Run one query as app_runtime with a given tenant context (RLS applies). */
  async function asRuntime<T extends pg.QueryResultRow>(userId: string, orgId: string, text: string, params: unknown[] = [], superadmin = false) {
    await runtime.query("BEGIN");
    try {
      await runtime.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`, [userId, orgId, superadmin ? "true" : "false"]);
      return (await runtime.query<T>(text, params)).rows;
    } finally { await runtime.query("ROLLBACK"); }
  }

  const approve = async (oppId: string, cg: P) => {
    const ap = await call("POST", `${S}/opportunities/${oppId}/applications`, cg.token, consent);
    const id = ap.body.application?.id as string;
    const d = await call("POST", `${S}/applications/${id}/decision`, A.admin1.token, { decision: "APPROVE", confirm: true });
    if (d.status !== 200 || d.body.outcome !== "APPROVED") throw new Error(`approve ${d.status} ${JSON.stringify(d.body)}`);
    return id;
  };
  const shiftsOf = async (oppId: string) => (await q(`SELECT shift_id FROM smartmatch_opportunities WHERE id=$1 AND shift_id IS NOT NULL`, [oppId])).rowCount;
  const shiftCount = async () => Number((await q<{ n: string }>(`SELECT count(*) n FROM shifts WHERE organization_id=$1`, [orgA])).rows[0].n);
  const listed = async (oppId: string) => ((await call("GET", `${S}/opportunities`, A.admin1.token)).body.opportunities as Json[] ?? []).find((o) => o.id === oppId);

  try {
    // ---------------------------------------------------------- before approval / permissions
    const opp1 = await opportunity(3);
    const early = await call("POST", `${S}/opportunities/${opp1}/shift`, A.admin1.token, { careRecipientId: rA });
    const draft0 = await call("GET", `${S}/opportunities/${opp1}/shift-draft`, A.admin1.token);
    check("T1 no shift before an approval (opportunity still published)",
      early.status === 409 && early.body.error === "OPPORTUNITY_NOT_FILLED" && draft0.body.canCreate === false, `status=${early.status}`);
    await approve(opp1, A.cg1);
    const sup = await call("GET", `${S}/opportunities/${opp1}/shift-draft`, A.supervisor.token);
    const supPost = await call("POST", `${S}/opportunities/${opp1}/shift`, A.supervisor.token, { careRecipientId: rA });
    check("T2 supervisor without SmartMatch authorization cannot use it", sup.status === 403 && supPost.status === 403, `${sup.status},${supPost.status}`);
    const bDraft = await call("GET", `${S}/opportunities/${opp1}/shift-draft`, B.admin.token);
    const bPost = await call("POST", `/organizations/${orgB}/smartmatch/opportunities/${opp1}/shift`, B.admin.token, { careRecipientId: rB });
    check("T3 agency B admin cannot see or use agency A's opportunity", [403, 404].includes(bDraft.status) && bPost.status === 404, `${bDraft.status},${bPost.status}`);
    const cgPost = await call("POST", `${S}/opportunities/${opp1}/shift`, A.cg1.token, { careRecipientId: rA });
    check("T4 caregiver cannot create the shift", cgPost.status === 403, `status=${cgPost.status}`);

    // ---------------------------------------------------------- deferred state + draft
    const deferred = await listed(opp1);
    check("T5 approved without shift: listed as FILLED with no shift (pending assignment)",
      deferred?.status === "FILLED" && deferred?.shift_id === null, JSON.stringify(deferred ?? null).slice(0, 100));
    const draft = await call("GET", `${S}/opportunities/${opp1}/shift-draft`, A.admin1.token);
    const draftLeak = JSON.stringify(draft.body).match(/first_name|last_name|care_recipient|Sintetico|email/i);
    check("T6 draft: approved caregiver, fixed schedule, live checks ready, no patient data",
      draft.status === 200 && draft.body.canCreate === true && draft.body.caregiver?.displayName === "Synthetic a-cg1"
      && draft.body.checks?.ready === true && !draftLeak, draftLeak?.[0] ?? `status=${draft.status}`);

    // ---------------------------------------------------------- validation (nothing created on failure)
    const before = await shiftCount();
    const fromB = await call("POST", `${S}/opportunities/${opp1}/shift`, A.admin1.token, { careRecipientId: rB });
    check("T7 person receiving care from another agency is refused", fromB.status === 400 && fromB.body.error === "RECIPIENT_NOT_IN_AGENCY", `status=${fromB.status}`);
    const archived = await call("POST", `${S}/opportunities/${opp1}/shift`, A.admin1.token, { careRecipientId: rArchived });
    check("T8 archived record of the agency is refused", archived.status === 400, `status=${archived.status}`);
    const moved = await call("POST", `${S}/opportunities/${opp1}/shift`, A.admin1.token, { careRecipientId: rA, scheduledStart: new Date().toISOString() });
    check("T9 schedule cannot be changed (fixed to the opportunity)", moved.status === 400, `status=${moved.status}`);
    check("T10 failed attempts created no shift and no link", (await shiftCount()) === before && (await shiftsOf(opp1)) === 0);

    // ---------------------------------------------------------- create
    const oppRow = (await q<{ starts_at: Date; ends_at: Date; role_label: string }>(`SELECT starts_at, ends_at, role_label FROM smartmatch_opportunities WHERE id=$1`, [opp1])).rows[0];
    const made = await call("POST", `${S}/opportunities/${opp1}/shift`, A.admin1.token, { careRecipientId: rA, instructions: "Llegar 10 min antes. Llaves en recepcion." });
    const shiftId = made.body.shift?.id as string;
    const row = (await q<{ scheduled_start: Date; scheduled_end: Date; required_role: string; status: string; care_recipient_id: string }>(`SELECT scheduled_start, scheduled_end, required_role, status, care_recipient_id FROM shifts WHERE id=$1`, [shiftId ?? randomUUID()])).rows[0];
    check("T11 admin creates the shift: opportunity schedule and role, chosen person, confirmed",
      made.status === 201 && !!row && row.scheduled_start.getTime() === oppRow.starts_at.getTime() && row.scheduled_end.getTime() === oppRow.ends_at.getTime()
      && row.required_role === oppRow.role_label && row.care_recipient_id === rA && row.status === "confirmed", `status=${made.status}`);
    const cal = await call("GET", `/organizations/${orgA}/shifts`, A.admin1.token);
    const inCal = ((cal.body.shifts ?? []) as Json[]).find((s) => s.id === shiftId);
    check("T12 the shift appears in the existing Turnos calendar with its assignment", !!inCal && inCal.assignment_count === 1, JSON.stringify(inCal ?? null).slice(0, 80));
    const mine = await call("GET", `/organizations/${orgA}/me/shifts`, A.cg1.token);
    check("T13 the approved caregiver sees it in her shifts", ((mine.body.shifts ?? []) as Json[]).some((s) => s.id === shiftId), `status=${mine.status}`);
    const notes = await call("GET", "/me/notifications?limit=100", A.cg1.token);
    const pending = ((notes.body.items ?? []) as Json[]).filter((n) => n.type === "SHIFT_ASSIGNMENT_PENDING" && n.relatedEntityId === made.body.assignment?.id);
    check("T14 caregiver notified through the existing assignment notification", pending.length === 1);
    const linked = await listed(opp1);
    check("T15 opportunity shows 'Turno creado' data: shift id + pending assignment",
      linked?.shift_id === shiftId && linked?.shift_assignment_status === "pending", JSON.stringify(linked ?? null).slice(0, 120));

    // ---------------------------------------------------------- duplicates and concurrency
    const again = await call("POST", `${S}/opportunities/${opp1}/shift`, A.admin2.token, { careRecipientId: rA2 });
    check("T16 a second shift for the same opportunity is refused", again.status === 409 && again.body.error === "SHIFT_ALREADY_CREATED" && (await shiftsOf(opp1)) === 1, `status=${again.status}`);
    const opp2 = await opportunity(4);
    await approve(opp2, A.cg2);
    const before2 = await shiftCount();
    const race = await Promise.all([A.admin1, A.admin2, A.admin1, A.admin2, A.admin1, A.admin2].map((p) =>
      call("POST", `${S}/opportunities/${opp2}/shift`, p.token, { careRecipientId: rA2 })));
    const codes = race.map((r) => r.status).sort().join(",");
    check("T17 six simultaneous requests (two admins): exactly one shift",
      race.filter((r) => r.status === 201).length === 1 && race.every((r) => r.status === 201 || r.status === 409)
      && (await shiftCount()) === before2 + 1 && (await shiftsOf(opp2)) === 1, codes);

    // ---------------------------------------------------------- server re-validation
    const opp3 = await opportunity(5);
    const o3 = (await q<{ starts_at: Date; ends_at: Date }>(`SELECT starts_at, ends_at FROM smartmatch_opportunities WHERE id=$1`, [opp3])).rows[0];
    const cg3m = (await q<{ id: string }>(`SELECT owm.id FROM organization_worker_memberships owm JOIN workers w ON w.id=owm.worker_id WHERE w.user_id=$1`, [A.cg3.userId])).rows[0].id;
    const other = await call("POST", `/organizations/${orgA}/shifts`, A.admin1.token, { careRecipientId: rA2, scheduledStart: o3.starts_at.toISOString(), scheduledEnd: o3.ends_at.toISOString() });
    const otherAssign = await call("POST", `/organizations/${orgA}/shifts/${other.body.shift?.id}/assignments`, A.admin1.token, { organizationWorkerMembershipId: cg3m });
    check("T18 existing Turnos endpoints still create and assign (regression)", other.status === 201 && otherAssign.status === 201, `${other.status},${otherAssign.status}`);
    // H1 (migration 110): a caregiver who already has a shift at that time can no longer be
    // approved -- the conflict is caught at approval, not later when creating the shift.
    const ap3 = await call("POST", `${S}/opportunities/${opp3}/applications`, A.cg3.token, consent);
    const before3 = await shiftCount();
    const blocked3 = await call("POST", `${S}/applications/${ap3.body.application?.id}/decision`, A.admin1.token, { decision: "APPROVE", confirm: true });
    const opp3Row = (await q<{ status: string }>(`SELECT status FROM smartmatch_opportunities WHERE id=$1`, [opp3])).rows[0];
    check("T19 schedule conflict with another shift is refused at approval and nothing is left behind",
      blocked3.status === 409 && blocked3.body.error === "APPROVAL_BLOCKED" && blocked3.body.checks?.noScheduleConflict === false
      && opp3Row.status === "PUBLISHED" && (await shiftCount()) === before3 && (await shiftsOf(opp3)) === 0,
      `status=${blocked3.status} ${blocked3.body.error} noScheduleConflict=${blocked3.body.checks?.noScheduleConflict} opp=${opp3Row.status}`);
    const opp4 = await opportunity(6);
    await approve(opp4, A.cg4);
    await q(`UPDATE credentials SET status='revoked' WHERE worker_id=$1`, [A.cg4.workerId]);
    const before4 = await shiftCount();
    const revoked = await call("POST", `${S}/opportunities/${opp4}/shift`, A.admin1.token, { careRecipientId: rA });
    const d4 = await call("GET", `${S}/opportunities/${opp4}/shift-draft`, A.admin1.token);
    check("T20 credential revoked after approval: re-checked on the server, refused, nothing created",
      revoked.status === 409 && revoked.body.error === "CAREGIVER_NOT_READY" && (await shiftCount()) === before4 && d4.body.canCreate === false, `status=${revoked.status}`);

    // ---------------------------------------------------------- private instructions
    const ins = (p: P) => call("GET", `/organizations/${orgA}/shifts/${shiftId}/private-instructions`, p.token);
    const [iAdmin, iSup, iCg, iOther] = await Promise.all([ins(A.admin1), ins(A.supervisor), ins(A.cg1), ins(A.cg2)]);
    check("T21 instructions readable by agency managers and the assigned caregiver",
      iAdmin.status === 200 && iSup.status === 200 && iCg.status === 200 && iCg.body.instructions?.instructions?.startsWith("Llegar"), `${iAdmin.status},${iSup.status},${iCg.status}`);
    const iB = await call("GET", `/organizations/${orgB}/shifts/${shiftId}/private-instructions`, B.admin.token);
    check("T22 not readable by another caregiver or by agency B", iOther.status === 404 && iB.status === 404, `${iOther.status},${iB.status}`);
    const famShift = await asRuntime(A.family.userId, orgA, `SELECT id FROM shifts WHERE id=$1`, [shiftId]);
    const famIns = await asRuntime(A.family.userId, orgA, `SELECT 1 FROM shift_private_instructions WHERE shift_id=$1`, [shiftId]);
    check("T23 family member: no access to the instructions (RLS)", famIns.length === 0, `family sees shift row: ${famShift.length}`);
    const supShift = await asRuntime(A.platform.userId, orgA, `SELECT id FROM shifts WHERE id=$1`, [shiftId], true);
    const supIns = await asRuntime(A.platform.userId, orgA, `SELECT 1 FROM shift_private_instructions WHERE shift_id=$1`, [shiftId], true);
    check("T24 ETNARA central super-admin: no shift row (078) and no instructions", supShift.length === 0 && supIns.length === 0, `${supShift.length},${supIns.length}`);
    const cgPut = await call("PUT", `/organizations/${orgA}/shifts/${shiftId}/private-instructions`, A.cg1.token, { instructions: "cambiado" });
    const adminPut = await call("PUT", `/organizations/${orgA}/shifts/${shiftId}/private-instructions`, A.admin1.token, { instructions: "Llegar 15 min antes." });
    check("T25 caregiver cannot edit instructions; admin can", cgPut.status === 404 && adminPut.status === 200 && adminPut.body.instructions?.instructions === "Llegar 15 min antes.", `${cgPut.status},${adminPut.status}`);
    const leakNotes = await q(`SELECT 1 FROM notifications WHERE related_entity_type='smartmatch_application' AND care_recipient_id IS NOT NULL`);
    check("T26 published opportunity and SmartMatch notifications still carry no patient", leakNotes.rowCount === 0
      && !JSON.stringify((await call("GET", `${S}/available-opportunities`, A.cg2.token)).body).includes("Sintetico"));

    // ---------------------------------------------------------- database invariants
    let immutable = false;
    try {
      await asRuntime(A.admin1.userId, orgA, `UPDATE smartmatch_opportunities SET shift_id=$1 WHERE id=$2`, [other.body.shift?.id, opp1]);
    } catch (e) { immutable = /SMARTMATCH_SHIFT_LINK_IMMUTABLE/.test((e as Error).message); }
    check("T27 the link cannot be moved to another shift (database)", immutable);
    let notFilled = false;
    const opp5 = await opportunity(7);
    try {
      await asRuntime(A.admin1.userId, orgA, `UPDATE smartmatch_opportunities SET shift_id=$1 WHERE id=$2`, [other.body.shift?.id, opp5]);
    } catch (e) { notFilled = (e as { code?: string }).code === "23514"; }
    check("T28 only FILLED opportunities can be linked (database)", notFilled);
    let crossOrg = false;
    const shiftB = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end) VALUES ($1,$2,now()+interval '9 days',now()+interval '9 days 4 hours') RETURNING id`, [orgB, rB])).rows[0].id;
    try { await q(`UPDATE smartmatch_opportunities SET shift_id=$1 WHERE id=$2`, [shiftB, opp4]); }
    catch (e) { crossOrg = (e as { code?: string }).code === "23503"; }
    check("T29 a shift of another agency can never be linked, even by a superuser", crossOrg);

    // ---------------------------------------------------------- caregiver response stays visible
    const respond = await call("POST", `/organizations/${orgA}/me/shifts/${shiftId}/respond`, A.cg1.token, { decision: "accepted" });
    const accepted = await listed(opp1);
    check("T30 caregiver accepts in Turnos; SmartMatch shows the accepted assignment",
      respond.status === 200 && accepted?.shift_assignment_status === "accepted", `status=${respond.status}`);
  } finally {
    await runtime.end();
    server.close();
    await pool.end();
    await db.end();
  }

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nSmartMatch -> Turnos: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
