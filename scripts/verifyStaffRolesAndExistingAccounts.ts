/**
 * Phase 12.3 verification: staff roles for people already in the agency, and
 * accepting a staff invitation with an existing ETNARA account.
 *
 * Real Express app and logins against a disposable database prepared by
 * bootstrap:staging + seedDemo (085 applied).
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
  const { hashPassword } = await import("../src/security/password.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = new Client({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  await admin.connect();

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
  const rolesOf = async (email: string, orgId: string) => (await admin.query<{ code: string }>(`
    SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    JOIN organization_memberships om ON om.id = ur.organization_membership_id JOIN users u ON u.id = om.user_id
    WHERE u.email = $1 AND om.organization_id = $2 ORDER BY r.code`, [email, orgId])).rows.map((r) => r.code).join(",");

  try {
    const adminToken = await login("admin@demo.etnara.care");
    let carlos = await login("carlos@demo.etnara.care");
    const me = await call("GET", "/me", adminToken);
    const org = (me.body.organizations as Array<{ id: string }>)[0].id;
    for (const t of [adminToken, carlos]) await call("POST", "/me/active-organization", t, { organizationId: org });
    const carlosWorker = ((await call("GET", `/organizations/${org}/me/worker-profile`, carlos)).body.workerProfile as { membershipId: string }).membershipId;
    const rolesPath = `/organizations/${org}/team/roles`;

    // A caregiver becomes a supervisor and keeps working shifts.
    const promote = await call("POST", rolesPath, adminToken, { workerMembershipId: carlosWorker, role: "SUPERVISOR", enabled: true });
    check("Administrator makes a caregiver a supervisor (200)", promote.status === 200, `${promote.status}`);
    check("The caregiver keeps WORKER and gains SUPERVISOR", (await rolesOf("carlos@demo.etnara.care", org)) === "SUPERVISOR,WORKER", await rolesOf("carlos@demo.etnara.care", org));
    carlos = await login("carlos@demo.etnara.care");
    await call("POST", "/me/active-organization", carlos, { organizationId: org });
    const asManager = await call("GET", `/organizations/${org}/operations/center`, carlos);
    const asWorker = await call("GET", `/organizations/${org}/me/shifts`, carlos);
    const money = await call("GET", `/organizations/${org}/financial-rates`, carlos);
    check("Now sees the agency's shifts, still sees own shifts, still no money", asManager.status === 200 && asWorker.status === 200 && money.status === 403, `agency=${asManager.status} mine=${asWorker.status} money=${money.status}`);
    const team = await call("GET", `/organizations/${org}/team`, adminToken);
    const listed = ((team.body.members as Array<{ email: string; workerMembershipId: string | null }> | undefined) ?? []).find((m) => m.email === "carlos@demo.etnara.care");
    check("The team lists the supervisor linked to its caregiver profile", listed?.workerMembershipId === carlosWorker, String(listed?.workerMembershipId));
    const selfPromote = await call("POST", rolesPath, carlos, { workerMembershipId: carlosWorker, role: "ORGANIZATION_ADMIN", enabled: true });
    check("A supervisor cannot make itself administrator (403)", selfPromote.status === 403, `${selfPromote.status}`);
    const demote = await call("POST", rolesPath, adminToken, { workerMembershipId: carlosWorker, role: "SUPERVISOR", enabled: false });
    const afterDemote = await call("GET", `/organizations/${org}/operations/center`, carlos);
    check("Removing the supervisor role takes agency access away again", demote.status === 200 && afterDemote.status === 403 && (await rolesOf("carlos@demo.etnara.care", org)) === "WORKER", `remove=${demote.status} agency=${afterDemote.status}`);

    // Guards.
    const adminMembership = ((team.body.members as Array<{ email: string; membershipId: string }>).find((m) => m.email === "admin@demo.etnara.care"))!.membershipId;
    const removeSelf = await call("POST", rolesPath, adminToken, { membershipId: adminMembership, role: "ORGANIZATION_ADMIN", enabled: false });
    check("An administrator cannot remove its own administrator role (409)", removeSelf.status === 409 && removeSelf.body.error === "CANNOT_REMOVE_OWN_ADMIN", `${removeSelf.status} ${removeSelf.body.error}`);
    const both = await call("POST", rolesPath, adminToken, { membershipId: adminMembership, workerMembershipId: carlosWorker, role: "SUPERVISOR", enabled: true });
    const badRole = await call("POST", rolesPath, adminToken, { workerMembershipId: carlosWorker, role: "PLATFORM_SUPERADMIN", enabled: true });
    check("Ambiguous target or invalid role is rejected (400)", both.status === 400 && badRole.status === 400, `${both.status},${badRole.status}`);
    const created = await call("POST", `/organizations/${org}/workers`, adminToken, { displayName: "Cuidadora Sin Cuenta", internalRole: "HHA" });
    const noAccountId = (created.body.membership as { id: string } | undefined)?.id;
    const noAccount = await call("POST", rolesPath, adminToken, { workerMembershipId: noAccountId, role: "SUPERVISOR", enabled: true });
    check("A caregiver without an activated account cannot get a staff role yet (409)", noAccount.status === 409 && noAccount.body.error === "NO_ACCOUNT_YET", `${created.status} ${noAccount.status} ${noAccount.body.error}`);
    const otherOrgWorker = await call("POST", rolesPath, adminToken, { workerMembershipId: "00000000-0000-4000-8000-000000000000", role: "SUPERVISOR", enabled: true });
    check("An unknown caregiver is not found (404)", otherOrgWorker.status === 404, `${otherOrgWorker.status}`);

    // Another agency invites an existing ETNARA account (María).
    const otherAdminEmail = `otra-admin-${Date.now()}@example.invalid`;
    const otherAdminPassword = "Otra-Agencia-Segura-2026!";
    const other = await admin.query<{ org: string }>(`
      WITH o AS (INSERT INTO organizations (name, organization_type, status) VALUES ('Otra Agencia Cuentas', 'HOME_CARE_AGENCY', 'active') RETURNING id),
           u AS (INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id),
           m AS (INSERT INTO organization_memberships (user_id, organization_id, status) SELECT u.id, o.id, 'active' FROM u, o RETURNING id, organization_id),
           r AS (INSERT INTO user_roles (organization_membership_id, organization_id, role_id) SELECT m.id, m.organization_id, roles.id FROM m, roles WHERE roles.code = 'ORGANIZATION_ADMIN' RETURNING 1)
      SELECT (SELECT id FROM o) AS org, (SELECT count(*) FROM r) AS roles`, [otherAdminEmail, await hashPassword(otherAdminPassword)]);
    const otherOrg = other.rows[0].org;
    const otherAdmin = await login(otherAdminEmail, otherAdminPassword);
    await call("POST", "/me/active-organization", otherAdmin, { organizationId: otherOrg });
    const invite = await call("POST", `/organizations/${otherOrg}/team/invitations`, otherAdmin, { email: "maria@demo.etnara.care", role: "SUPERVISOR" });
    const token = invite.body.token as string;
    check("Another agency invites an existing account (201)", invite.status === 201 && typeof token === "string", `${invite.status}`);
    const inspect = await call("GET", `/platform/admin-invitations/inspect?token=${token}`, null);
    check("The activation page knows the account already exists", (inspect.body.invitation as Json)?.account_exists === true, String((inspect.body.invitation as Json)?.account_exists));
    const newAccount = await call("POST", "/platform/admin-invitations/activate", null, { token, password: "Nueva-Clave-Segura-2026!" });
    check("It cannot be used to create a second account (409)", newAccount.status === 409, `${newAccount.status}`);
    const unauth = await call("POST", "/platform/admin-invitations/accept", null, { token });
    check("Accepting requires signing in (401)", unauth.status === 401, `${unauth.status}`);
    const wrongPerson = await call("POST", "/platform/admin-invitations/accept", carlos, { token });
    check("Someone else signed in cannot accept it", wrongPerson.status >= 400 && wrongPerson.status < 500, `${wrongPerson.status} ${wrongPerson.body.error}`);
    const maria = await login("maria@demo.etnara.care");
    const accept = await call("POST", "/platform/admin-invitations/accept", maria, { token });
    check("The invited person accepts with her existing account (201)", accept.status === 201, `${accept.status} ${accept.body.error ?? ""}`);
    const mariaMe = await call("GET", "/me", maria);
    const orgs = (mariaMe.body.organizations as Array<{ id: string; roles: string[] }>) ?? [];
    check("She now belongs to both agencies, each with its own role", orgs.length === 2 && orgs.find((o) => o.id === otherOrg)?.roles.join(",") === "SUPERVISOR" && orgs.find((o) => o.id === org)?.roles.join(",") === "WORKER", orgs.map((o) => `${o.id === org ? "demo" : "otra"}:${o.roles.join("+")}`).join(" "));
    const reuse = await call("POST", "/platform/admin-invitations/accept", maria, { token });
    check("The invitation cannot be used twice", reuse.status >= 400, `${reuse.status}`);
  } finally {
    await admin.end();
    server.close();
  }

  console.log("\nPhase 12.3 · staff roles and existing accounts\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Staff roles verification failed:", error);
  process.exit(1);
});
