/**
 * Production security hotfix (migration 088): each fixed weakness is attacked
 * over real HTTP (server as app_runtime) and with direct RLS probes, and the
 * legitimate flows that touch the same tables are exercised (check-in/out,
 * rejection, family notices, password reset path). Synthetic data only.
 * Runs on main's schema: no SmartMatch tables required.
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
    (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgA = await org(`HF A ${tag}`);
  const orgB = await org(`HF B ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  for (const o of [orgA, orgB]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'HF') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  }
  type P = { email: string; userId: string; token: string; workerId?: string; membershipId?: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `hf-${key}-${tag}@example.invalid`;
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
  const notices = async (p: P, type: string) => ((await call("GET", "/me/notifications?limit=100", p.token)).body.items ?? [] as Json[]).filter((n: Json) => n.type === type);
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

  const touched = async (userId: string, orgId: string, text: string, params: unknown[]) => {
    try { return (await asRuntime(userId, orgId, text + " RETURNING 1", params)).length; } catch { return -1; }
  };
  try {
    // ================================================================ A. users
    const otherEmail = await touched(A.cg1.userId, orgA, `UPDATE users SET email = 'attacker@example.invalid' WHERE id = $1`, [A.admin.userId]);
    const otherPwd = await touched(A.cg1.userId, orgA, `UPDATE users SET password_hash = 'x' WHERE id = $1`, [A.admin.userId]);
    const famPwd = await touched(A.family.userId, orgA, `UPDATE users SET password_hash = 'x' WHERE id = $1`, [A.admin.userId]);
    const ownPwd = await touched(A.cg1.userId, orgA, `UPDATE users SET password_hash = password_hash WHERE id = $1`, [A.cg1.userId]);
    const insertUser = await touched(A.admin.userId, orgA, `INSERT INTO users (email, password_hash, status) VALUES ('x-${tag}@example.invalid','x','active')`, []);
    check("A1 no member can change another user's e-mail or password (caregiver, relative)", otherEmail <= 0 && otherPwd <= 0 && famPwd <= 0, `${otherEmail},${otherPwd},${famPwd}`);
    check("A2 own password still updatable (reset flow); the API role cannot create users", ownPwd === 1 && insertUser === -1, `${ownPwd},${insertUser}`);
    const relogin = await call("POST", "/auth/login", "", { email: A.admin.email, password });
    const reads = await asRuntime(A.cg1.userId, orgA, `SELECT id FROM users WHERE id = $1`, [A.admin.userId]);
    check("A3 logins and reads of colleagues unchanged", relogin.status === 200 && reads.length === 1, `${relogin.status},${reads.length}`);

    // Full password-reset flow over HTTP (the only API write on users).
    const { hashToken } = await import("../src/security/sessionToken.js");
    const resetRaw = randomBytes(32).toString("hex");
    await q(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`, [A.cg5.userId, hashToken(resetRaw)]);
    const newPassword = randomBytes(12).toString("hex");
    const reset = await call("POST", "/auth/password-reset/confirm", "", { token: resetRaw, password: newPassword });
    const loginNew = await call("POST", "/auth/login", "", { email: A.cg5.email, password: newPassword });
    const loginOld = await call("POST", "/auth/login", "", { email: A.cg5.email, password });
    check("A4 password reset over HTTP still works (new password in, old password out)", reset.status === 200 && loginNew.status === 200 && loginOld.status === 401, `${reset.status},${loginNew.status},${loginOld.status}`);

    // ================================================================ B. shifts
    const sMine = await shift(A.cg1, 300, 60);
    const patchTimes = await call("PATCH", `/organizations/${orgA}/shifts/${sMine}`, A.cg1.token, { scheduledEnd: at(60 * 24 * 365) });
    const patchStatus = await call("PATCH", `/organizations/${orgA}/shifts/${sMine}`, A.cg1.token, { status: "completed" });
    check("B1 a caregiver cannot edit their shift's times or status over HTTP (403)", patchTimes.status === 403 && patchStatus.status === 403, `${patchTimes.status},${patchStatus.status}`);
    const rOther = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Otra','Persona-${tag}') RETURNING id`, [orgA])).rows[0].id;
    const dbTimes = await touched(A.cg1.userId, orgA, `UPDATE shifts SET scheduled_end = scheduled_end + interval '365 days' WHERE id = $1`, [sMine]);
    const dbPerson = await touched(A.cg1.userId, orgA, `UPDATE shifts SET care_recipient_id = $2 WHERE id = $1`, [sMine, rOther]);
    const dbDelete = await touched(A.cg1.userId, orgA, `DELETE FROM shifts WHERE id = $1`, [sMine]);
    check("B2 at DB level a caregiver cannot move, re-point or delete their shift", dbTimes <= 0 && dbPerson <= 0 && dbDelete <= 0, `${dbTimes},${dbPerson},${dbDelete}`);
    const mgrPatch = await call("PATCH", `/organizations/${orgA}/shifts/${sMine}`, A.admin.token, { scheduledEnd: at(300 + 90) });
    const supPatch = await call("PATCH", `/organizations/${orgA}/shifts/${sMine}`, A.supervisor.token, { scheduledEnd: at(300 + 120) });
    check("B3 managers (admin, supervisor) still edit shifts", mgrPatch.status === 200 && supPatch.status === 200, `${mgrPatch.status},${supPatch.status}`);
    const sCancel = await shift(A.cg2, 400, 60);
    await call("POST", `/organizations/${orgA}/shifts/${sCancel}/cancel`, A.admin.token, {});
    const revive = await call("PATCH", `/organizations/${orgA}/shifts/${sCancel}`, A.admin.token, { status: "confirmed" });
    check("B4 a cancelled shift can never be revived (409)", revive.status === 409 && revive.body.error === "SHIFT_STATUS_CANCELLED_IS_FINAL", `${revive.status} ${revive.body.error}`);
    // Legitimate caregiver flows on the same table.
    const sWork = await shift(A.cg3, 5, 60);
    const cin = await call("POST", `/organizations/${orgA}/shifts/${sWork}/check-in`, A.cg3.token, { verificationMethodCode: "CAREGIVER_SESSION" });
    const midStatus = (await q<{ status: string }>(`SELECT status::text AS status FROM shifts WHERE id=$1`, [sWork])).rows[0].status;
    const cout = await call("POST", `/organizations/${orgA}/shifts/${sWork}/check-out`, A.cg3.token, {});
    const endStatus = (await q<{ status: string }>(`SELECT status::text AS status FROM shifts WHERE id=$1`, [sWork])).rows[0].status;
    check("B5 caregiver check-in / check-out still move the shift to in_progress / completed", cin.status === 201 && midStatus === "in_progress" && [200, 201].includes(cout.status) && endStatus === "completed", `${cin.status},${midStatus},${cout.status},${endStatus}`);
    const sDecline = await shift(A.cg4, 500, 60, "pending");
    const decl = await call("POST", `/organizations/${orgA}/me/shifts/${sDecline}/respond`, A.cg4.token, { decision: "rejected", reason: "No puedo" });
    const declStatus = (await q<{ status: string }>(`SELECT status::text AS status FROM shifts WHERE id=$1`, [sDecline])).rows[0].status;
    check("B6 a caregiver can still decline (shift back to unassigned)", decl.status === 200 && declStatus === "unassigned", `${decl.status},${declStatus}`);
    const famStarted = await notices(A.family, "SHIFT_STARTED");
    check("B7 the family is still notified when the caregiver starts (relationship read as caregiver)", famStarted.length >= 1, `n=${famStarted.length}`);

    // ================================================================ C. family relationships
    const rB2 = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Tercera','Persona-${tag}') RETURNING id`, [orgA])).rows[0].id;
    const otherFam = await person("a-other-family", orgA, ["FAMILY"]);
    const otherRel = (await q<{ id: string }>(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hijo','active') RETURNING id`, [otherFam.userId, orgA, rB2])).rows[0].id;
    otherFam.token = (await call("POST", "/auth/login", "", { email: otherFam.email, password })).body.token;
    await call("POST", "/me/active-organization", otherFam.token, { organizationId: orgA });
    const famSees = (await asRuntime<{ care_recipient_id: string }>(A.family.userId, orgA, `SELECT care_recipient_id FROM family_relationships`)).map((r) => r.care_recipient_id);
    check("C1 a relative reads only relationships of their own person", famSees.length >= 1 && famSees.every((id) => id === rA), famSees.length + "");
    const ownRel = (await q<{ id: string }>(`SELECT id FROM family_relationships WHERE user_id=$1`, [A.family.userId])).rows[0].id;
    const flags = await touched(A.family.userId, orgA, `UPDATE family_relationships SET can_participate_in_verification = true, can_view_photos = NOT can_view_photos WHERE id = $1`, [ownRel]);
    const repoint = await touched(A.family.userId, orgA, `UPDATE family_relationships SET care_recipient_id = $2 WHERE id = $1`, [ownRel, rB2]);
    const selfLink = await touched(A.family.userId, orgA, `INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'x','active')`, [A.family.userId, orgA, rB2]);
    const killOther = await touched(A.family.userId, orgA, `DELETE FROM family_relationships WHERE id = $1`, [otherRel]);
    check("C2 at DB level a relative cannot change their permissions, re-point, self-link or delete others", flags <= 0 && repoint <= 0 && selfLink <= 0 && killOther <= 0, `${flags},${repoint},${selfLink},${killOther}`);
    const revFam = await call("POST", `/organizations/${orgA}/care-recipients/${rB2}/family/${otherRel}/revoke`, A.family.token, {});
    const revCg = await call("POST", `/organizations/${orgA}/care-recipients/${rB2}/family/${otherRel}/revoke`, A.cg1.token, {});
    const stillActive = (await q<{ status: string }>(`SELECT status::text AS status FROM family_relationships WHERE id=$1`, [otherRel])).rows[0].status;
    const revSup = await call("POST", `/organizations/${orgA}/care-recipients/${rB2}/family/${otherRel}/revoke`, A.supervisor.token, {});
    const revoked = (await q<{ status: string }>(`SELECT status::text AS status FROM family_relationships WHERE id=$1`, [otherRel])).rows[0].status;
    check("C3 over HTTP only managers revoke family access (relative/caregiver 403, supervisor 200)",
      revFam.status === 403 && revCg.status === 403 && stillActive === "active" && revSup.status === 200 && revoked === "revoked", `${revFam.status},${revCg.status},${revSup.status}`);
    const famRecipients = await call("GET", "/me/care-recipients", A.family.token);
    check("C4 the relative's own portal still lists their person", famRecipients.status === 200 && JSON.stringify(famRecipients.body).includes(rA), `status=${famRecipients.status}`);

    // ================================================================ D. notifications
    const towerNotices = await asRuntime(A.platform.userId, orgA, `SELECT id FROM notifications WHERE user_id <> $1`, [A.platform.userId], true);
    const ownNotices = await call("GET", "/me/notifications?limit=10", A.admin.token);
    check("D1 ETNARA central / Tower no longer reads other users' notifications; users still read their own",
      towerNotices.length === 0 && ownNotices.status === 200, `${towerNotices.length},${ownNotices.status}`);
  } finally {
    await runtime.end();
    server.close();
    await pool.end();
    await db.end();
  }

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nProduction security hotfix: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
