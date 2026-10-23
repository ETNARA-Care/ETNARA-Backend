/**
 * Phase 12.2 verification: agency team invitations + administrator-only money.
 *
 * Real Express app, real logins and the real activation endpoint against a
 * disposable database prepared by bootstrap:staging + seedDemo (085 applied).
 * Direct RLS attacks run as app_runtime with each user's session context.
 */
import type { AddressInfo } from "node:net";
import { Client } from "pg";

for (const name of ["DATABASE_URL", "MIGRATIONS_DATABASE_URL", "DEMO_PASSWORD"] as const) {
  if (!process.env[name]) throw new Error(`${name} is required.`);
}
if (process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires ETNARA_DISPOSABLE_DB=true");

type Json = Record<string, unknown>;
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });

async function main() {
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = new Client({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  const runtime = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await runtime.connect();

  async function call(method: string, path: string, token: string | null, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json };
  }
  async function login(email: string, password = process.env.DEMO_PASSWORD) {
    const r = await call("POST", "/auth/login", null, { email, password });
    if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status}`);
    return r.body.token as string;
  }
  async function asRuntime<T>(userId: string, orgId: string, work: () => Promise<T>): Promise<T | Error> {
    await runtime.query("BEGIN");
    try {
      await runtime.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
      await runtime.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
      return await work();
    } catch (error) {
      return error as Error;
    } finally {
      await runtime.query("ROLLBACK");
    }
  }
  const rls = (value: unknown) => value instanceof Error && /row-level security/i.test(value.message);
  const rows = (value: unknown) => (value instanceof Error ? -1 : (value as { rowCount: number }).rowCount);

  try {
    const adminToken = await login("admin@demo.etnara.care");
    const carlos = await login("carlos@demo.etnara.care");
    const family = await login("familia@demo.etnara.care");
    const me = await call("GET", "/me", adminToken);
    const org = (me.body.organizations as Array<{ id: string }>)[0].id;
    for (const t of [adminToken, carlos, family]) await call("POST", "/me/active-organization", t, { organizationId: org });
    const ids = async (email: string) => (await admin.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email])).rows[0].id;
    const adminUserId = await ids("admin@demo.etnara.care");
    const carlosUserId = await ids("carlos@demo.etnara.care");
    const familyUserId = await ids("familia@demo.etnara.care");
    const roleId = async (code: string) => (await admin.query<{ id: string }>("SELECT id FROM roles WHERE code = $1", [code])).rows[0].id;
    const membershipOf = async (userId: string) => (await admin.query<{ id: string }>("SELECT id FROM organization_memberships WHERE user_id = $1 AND organization_id = $2", [userId, org])).rows[0].id;

    // Administrator manages the team.
    const team = await call("GET", `/organizations/${org}/team`, adminToken);
    const members = (team.body.members as Array<{ email: string; isYou: boolean }> | undefined) ?? [];
    check("Administrator lists the team", team.status === 200 && members.some((m) => m.email === "admin@demo.etnara.care" && m.isYou), `${team.status}`);

    const supervisorEmail = `supervisora-${Date.now()}@example.invalid`;
    const invite = await call("POST", `/organizations/${org}/team/invitations`, adminToken, { email: supervisorEmail, role: "SUPERVISOR" });
    check("Administrator invites a supervisor (201)", invite.status === 201 && typeof invite.body.token === "string", `${invite.status}`);
    const listed = await call("GET", `/organizations/${org}/team`, adminToken);
    const pending = (listed.body.invitations as Array<{ email: string; role: string }> | undefined) ?? [];
    check("The pending invitation shows with role Supervisor", pending.some((i) => i.email === supervisorEmail && i.role === "SUPERVISOR"));

    const inspect = await call("GET", `/platform/admin-invitations/inspect?token=${invite.body.token}`, null);
    check("Activation page shows the supervisor role", inspect.status === 200 && (inspect.body.invitation as Json)?.target_name === "Supervisor de la organización", `${inspect.status} ${(inspect.body.invitation as Json)?.target_name}`);
    const activate = await call("POST", "/platform/admin-invitations/activate", null, { token: invite.body.token, password: "Supervisora-Segura-2026!" });
    check("The supervisor activates the invitation", activate.status === 201, `${activate.status}`);
    const supervisorUserId = await ids(supervisorEmail);
    const roles = await admin.query<{ code: string }>(`
      SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN organization_memberships om ON om.id = ur.organization_membership_id
      WHERE om.user_id = $1 AND om.organization_id = $2`, [supervisorUserId, org]);
    check("The new account has exactly the SUPERVISOR role", roles.rows.length === 1 && roles.rows[0].code === "SUPERVISOR", roles.rows.map((r) => r.code).join(","));

    const supervisor = await login(supervisorEmail, "Supervisora-Segura-2026!");
    await call("POST", "/me/active-organization", supervisor, { organizationId: org });

    // Supervisor: operations yes, team and money no.
    const supShifts = await call("GET", `/organizations/${org}/shifts`, supervisor);
    const supResidents = await call("GET", `/organizations/${org}/care-recipients`, supervisor);
    check("Supervisor still manages shifts and residents", supShifts.status === 200 && supResidents.status === 200, `shifts=${supShifts.status} residents=${supResidents.status}`);
    const supTeam = await call("GET", `/organizations/${org}/team`, supervisor);
    const supInvite = await call("POST", `/organizations/${org}/team/invitations`, supervisor, { email: `otro-${Date.now()}@example.invalid`, role: "ORGANIZATION_ADMIN" });
    check("Supervisor cannot see or invite the team (403)", supTeam.status === 403 && supInvite.status === 403, `list=${supTeam.status} invite=${supInvite.status}`);
    const money = await Promise.all([
      call("GET", `/organizations/${org}/financial-rates`, supervisor),
      call("GET", `/organizations/${org}/timesheets?dateFrom=2026-10-01&dateTo=2026-10-31`, supervisor),
      call("GET", `/organizations/${org}/pay-periods`, supervisor),
    ]);
    check("Supervisor cannot see rates, hours or pay periods (403)", money.every((r) => r.status === 403), money.map((r) => r.status).join(","));
    const adminMoney = await Promise.all([
      call("GET", `/organizations/${org}/financial-rates`, adminToken),
      call("GET", `/organizations/${org}/timesheets?dateFrom=2026-10-01&dateTo=2026-10-31`, adminToken),
      call("GET", `/organizations/${org}/pay-periods`, adminToken),
    ]);
    check("Administrator still sees rates, hours and pay periods", adminMoney.every((r) => r.status === 200), adminMoney.map((r) => r.status).join(","));

    const carlosTeam = await call("GET", `/organizations/${org}/team`, carlos);
    const familyTeam = await call("GET", `/organizations/${org}/team`, family);
    check("Caregiver and family cannot see the team (403)", carlosTeam.status === 403 && familyTeam.status === 403, `${carlosTeam.status},${familyTeam.status}`);

    // Validation and lifecycle.
    const memberAgain = await call("POST", `/organizations/${org}/team/invitations`, adminToken, { email: "carlos@demo.etnara.care", role: "SUPERVISOR" });
    check("Inviting an existing member is rejected (409)", memberAgain.status === 409, `${memberAgain.status}`);
    const badRole = await call("POST", `/organizations/${org}/team/invitations`, adminToken, { email: "x@example.invalid", role: "PLATFORM_SUPERADMIN" });
    const extra = await call("POST", `/organizations/${org}/team/invitations`, adminToken, { email: "x@example.invalid", role: "SUPERVISOR", organizationId: org });
    check("Invalid role or extra fields are rejected (400)", badRole.status === 400 && extra.status === 400, `${badRole.status},${extra.status}`);
    const toRevoke = await call("POST", `/organizations/${org}/team/invitations`, adminToken, { email: `revocar-${Date.now()}@example.invalid`, role: "ORGANIZATION_ADMIN" });
    const revokeId = (toRevoke.body.invitation as { id: string }).id;
    const revoke = await call("POST", `/organizations/${org}/team/invitations/${revokeId}/revoke`, adminToken);
    const afterRevoke = await call("POST", "/platform/admin-invitations/activate", null, { token: toRevoke.body.token, password: "Otra-Clave-Segura-2026!" });
    check("A revoked invitation can no longer be activated", revoke.status === 200 && afterRevoke.status >= 400, `revoke=${revoke.status} activate=${afterRevoke.status}`);

    // Direct database attacks as app_runtime.
    const adminRole = await roleId("ORGANIZATION_ADMIN");
    const workerRole = await roleId("WORKER");
    const carlosMembership = await membershipOf(carlosUserId);
    const supervisorMembership = await membershipOf(supervisorUserId);
    const familyMembership = await membershipOf(familyUserId);
    const adminMembership = await membershipOf(adminUserId);
    const insertRole = (membership: string, role: string) => () =>
      runtime.query("INSERT INTO user_roles (organization_membership_id, organization_id, role_id) VALUES ($1, $2, $3)", [membership, org, role]);

    const r1 = await asRuntime(carlosUserId, org, insertRole(carlosMembership, adminRole));
    check("RLS: a caregiver cannot make itself administrator", rls(r1), r1 instanceof Error ? r1.message.slice(0, 50) : "inserted");
    const r2 = await asRuntime(familyUserId, org, insertRole(familyMembership, adminRole));
    check("RLS: a family member cannot make itself administrator", rls(r2), r2 instanceof Error ? r2.message.slice(0, 50) : "inserted");
    const r3 = await asRuntime(supervisorUserId, org, insertRole(supervisorMembership, adminRole));
    check("RLS: a supervisor cannot make itself administrator", rls(r3), r3 instanceof Error ? r3.message.slice(0, 50) : "inserted");
    const r4 = await asRuntime(supervisorUserId, org, insertRole(supervisorMembership, workerRole));
    check("RLS: a supervisor may still grant the WORKER role", !(r4 instanceof Error), r4 instanceof Error ? r4.message.slice(0, 50) : "allowed");
    const r5 = await asRuntime(carlosUserId, org, () => runtime.query("DELETE FROM user_roles WHERE organization_membership_id = $1", [adminMembership]));
    check("RLS: a caregiver cannot remove the administrator's role", rows(r5) === 0 || rls(r5), `rowCount=${rows(r5)}`);
    const r6 = await asRuntime(supervisorUserId, org, () => runtime.query("UPDATE organization_memberships SET status = 'revoked' WHERE id = $1", [adminMembership]));
    check("RLS: a supervisor cannot revoke the administrator's access", rows(r6) === 0 || rls(r6), `rowCount=${rows(r6)}`);
    const r7 = await asRuntime(carlosUserId, org, () => runtime.query("UPDATE organization_memberships SET status = 'active' WHERE organization_id = $1", [org]));
    check("RLS: a caregiver cannot change memberships", rows(r7) === 0 || rls(r7), `rowCount=${rows(r7)}`);
    const r8 = await asRuntime(supervisorUserId, org, () => runtime.query(
      "INSERT INTO access_invitations (organization_id, invited_by_user_id, invitation_type, staff_role, email, token_hash, expires_at) VALUES ($1, $2, 'organization_admin', 'ORGANIZATION_ADMIN', 'x@example.invalid', md5(random()::text) || md5(random()::text), now() + interval '1 day')",
      [org, supervisorUserId]));
    check("RLS: a supervisor cannot create an administrator invitation", rls(r8), r8 instanceof Error ? r8.message.slice(0, 50) : "inserted");
    const r9 = await asRuntime(supervisorUserId, org, async () => (await runtime.query("SELECT count(*) FROM access_invitations WHERE invitation_type = 'organization_admin'")).rows[0].count);
    check("RLS: a supervisor cannot read administrator invitations", r9 === "0", String(r9));
    const r10 = await asRuntime(supervisorUserId, org, async () => {
      const a = (await runtime.query("SELECT count(*) FROM worker_financial_rates")).rows[0].count;
      const b = (await runtime.query("SELECT count(*) FROM timesheets")).rows[0].count;
      const c = (await runtime.query("SELECT count(*) FROM pay_periods")).rows[0].count;
      return `${a},${b},${c}`;
    });
    check("RLS: a supervisor reads 0 rates, hours and pay periods", r10 === "0,0,0", String(r10));
    const r11 = await asRuntime(supervisorUserId, org, () => runtime.query(
      "INSERT INTO worker_financial_rates (organization_id, organization_worker_membership_id, pay_rate_cents, bill_rate_cents, currency, updated_by_user_id) SELECT organization_id, id, 1, 1, 'USD', $2 FROM organization_worker_memberships WHERE organization_id = $1 LIMIT 1",
      [org, supervisorUserId]));
    check("RLS: a supervisor cannot write rates", rls(r11) || (r11 instanceof Error), r11 instanceof Error ? r11.message.slice(0, 50) : "inserted");

    // The ETNARA platform keeps inviting an agency's first administrator.
    const platformUser = (await admin.query<{ user_id: string }>("SELECT user_id FROM platform_admins WHERE revoked_at IS NULL LIMIT 1")).rows[0]?.user_id;
    if (platformUser) {
      await runtime.query("BEGIN");
      let platformOk = false; let detail = "";
      try {
        await runtime.query("SELECT set_config('app.current_user_id', $1, true), set_config('app.current_org_id', '', true), set_config('app.is_superadmin', 'true', true)", [platformUser]);
        const inserted = await runtime.query(
          "INSERT INTO access_invitations (organization_id, invited_by_user_id, invitation_type, email, token_hash, expires_at) VALUES ($1, $2, 'organization_admin', 'primer-admin@example.invalid', md5(random()::text) || md5(random()::text), now() + interval '1 day') RETURNING staff_role",
          [org, platformUser]);
        platformOk = inserted.rows[0]?.staff_role === "ORGANIZATION_ADMIN"; detail = String(inserted.rows[0]?.staff_role);
      } catch (error) { detail = (error as Error).message.slice(0, 60); } finally { await runtime.query("ROLLBACK"); }
      check("The ETNARA platform can still invite an agency administrator (defaults to ORGANIZATION_ADMIN)", platformOk, detail);
    }

    // Another agency's administrator, even forging this organization's context.
    const other = await admin.query<{ org: string; user: string }>(`
      WITH o AS (INSERT INTO organizations (name, organization_type, status) VALUES ('Otra Agencia Equipo', 'HOME_CARE_AGENCY', 'active') RETURNING id),
           u AS (INSERT INTO users (email, status) VALUES ('otra-equipo-' || gen_random_uuid() || '@example.invalid', 'active') RETURNING id),
           m AS (INSERT INTO organization_memberships (user_id, organization_id, status) SELECT u.id, o.id, 'active' FROM u, o RETURNING id, organization_id),
           r AS (INSERT INTO user_roles (organization_membership_id, organization_id, role_id) SELECT m.id, m.organization_id, roles.id FROM m, roles WHERE roles.code = 'ORGANIZATION_ADMIN' RETURNING 1)
      SELECT (SELECT id FROM o) AS org, (SELECT id FROM u) AS user, (SELECT count(*) FROM r) AS roles`);
    const r12 = await asRuntime(other.rows[0].user, org, insertRole(carlosMembership, adminRole));
    check("RLS: another agency's administrator cannot grant roles here", r12 instanceof Error, r12 instanceof Error ? r12.message.slice(0, 50) : "inserted");
    const r13 = await asRuntime(other.rows[0].user, org, async () => (await runtime.query("SELECT count(*) FROM worker_financial_rates")).rows[0].count);
    check("RLS: another agency's administrator reads 0 rates here", r13 === "0" || r13 instanceof Error, String(r13));
  } finally {
    await admin.end();
    await runtime.end();
    server.close();
  }

  console.log("\nPhase 12.2 · team invitations and administrator authority\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Team and admin authority verification failed:", error);
  process.exit(1);
});
