/**
 * Phase 12.4a verification: the old "tenant_isolation" policies no longer give
 * every member of an organization read/write access to everything.
 *
 * Runs as app_runtime (NOBYPASSRLS) against a disposable database prepared by
 * bootstrap:staging + seedDemo (086 applied). Every attempt runs in its own
 * transaction that is rolled back, so nothing is changed.
 */
import { Client } from "pg";

for (const name of ["DATABASE_URL", "MIGRATIONS_DATABASE_URL"] as const) {
  if (!process.env[name]) throw new Error(`${name} is required.`);
}
if (process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires ETNARA_DISPOSABLE_DB=true");

const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });

const TABLES = [
  "assignment_history", "assignments", "consent_records", "family_invitations", "organization_memberships",
  "organization_worker_memberships", "professional_scope", "user_roles", "verification_events",
  "verification_overrides", "worker_eligibility", "worker_roles",
];

async function main() {
  const admin = new Client({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  const runtime = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await runtime.connect();

  async function as<T>(userId: string, orgId: string | null, work: (c: Client) => Promise<T>): Promise<T | Error> {
    await runtime.query("BEGIN");
    try {
      await runtime.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
      await runtime.query("SELECT set_config('app.current_org_id', $1, true)", [orgId ?? ""]);
      await runtime.query("SELECT set_config('app.is_superadmin', 'false', true)");
      return await work(runtime);
    } catch (error) {
      return error as Error;
    } finally {
      await runtime.query("ROLLBACK");
    }
  }
  const count = async (c: Client, q: string, p: unknown[] = []) => Number((await c.query<{ n: string }>(q, p)).rows[0].n);
  const changed = (v: unknown) => (v instanceof Error ? (/row-level security/i.test(v.message) ? 0 : -1) : (v as { rowCount: number }).rowCount);
  const blocked = (v: unknown) => changed(v) === 0;
  const one = async <T extends Record<string, unknown>>(q: string, p: unknown[] = []) => (await admin.query<T>(q, p)).rows[0];

  try {
    const userId = async (email: string) => (await one<{ id: string }>("SELECT id FROM users WHERE email = $1", [email])).id;
    const familyUser = await userId("familia@demo.etnara.care");
    const carlosUser = await userId("carlos@demo.etnara.care");
    const mariaUser = await userId("maria@demo.etnara.care");
    const adminUser = await userId("admin@demo.etnara.care");
    const org = (await one<{ organization_id: string }>("SELECT organization_id FROM organization_memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1", [adminUser])).organization_id;
    const workerMembership = async (u: string) => (await one<{ id: string }>(
      "SELECT owm.id FROM organization_worker_memberships owm JOIN workers w ON w.id = owm.worker_id WHERE w.user_id = $1 AND owm.organization_id = $2", [u, org])).id;
    const carlosOwm = await workerMembership(carlosUser);
    const mariaOwm = await workerMembership(mariaUser);
    const mariaEvent = (await one<{ id: string; shift_id: string }>("SELECT id, shift_id FROM verification_events WHERE organization_worker_membership_id = $1 LIMIT 1", [mariaOwm]));
    const mariaAssignment = (await one<{ id: string }>("SELECT id FROM assignments WHERE organization_worker_membership_id = $1 AND response_status = 'pending' LIMIT 1", [mariaOwm]));
    // Fixture: a pending shift offer for Carlos (removed at the end).
    const carlosPending = (await one<{ id: string }>(`
      INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, care_recipient_id, role_in_shift, response_status)
      SELECT organization_id, shift_id, $1, care_recipient_id, role_in_shift, 'pending' FROM assignments WHERE id = $2 RETURNING id`, [carlosOwm, mariaAssignment.id]));
    const workerRoleId = (await one<{ id: string }>("SELECT id FROM roles WHERE code = 'WORKER'")).id;
    const totalEvents = await count(admin, "SELECT count(*) AS n FROM verification_events WHERE organization_id = $1", [org]);

    // A plain supervisor (the seeded supervisor@ account is an administrator).
    const supervisorUser = (await one<{ id: string }>(`
      WITH u AS (INSERT INTO users (email, password_hash, status) VALUES ('sup-124a-${Date.now()}@example.invalid', 'x', 'active') RETURNING id),
           m AS (INSERT INTO organization_memberships (user_id, organization_id, status) SELECT u.id, $1, 'active' FROM u RETURNING id, organization_id),
           r AS (INSERT INTO user_roles (organization_membership_id, organization_id, role_id) SELECT m.id, m.organization_id, roles.id FROM m, roles WHERE roles.code = 'SUPERVISOR' RETURNING 1)
      SELECT (SELECT id FROM u) AS id, (SELECT count(*) FROM r) AS n`, [org])).id;

    // An outsider: administrator of a separate agency.
    const outsider = await one<{ user_id: string; org: string }>(`
      WITH o AS (INSERT INTO organizations (name, organization_type, status) VALUES ('Agencia Ajena 12.4a', 'HOME_CARE_AGENCY', 'active') RETURNING id),
           u AS (INSERT INTO users (email, password_hash, status) VALUES ('ajena-${Date.now()}@example.invalid', 'x', 'active') RETURNING id),
           m AS (INSERT INTO organization_memberships (user_id, organization_id, status) SELECT u.id, o.id, 'active' FROM u, o RETURNING id, organization_id),
           r AS (INSERT INTO user_roles (organization_membership_id, organization_id, role_id) SELECT m.id, m.organization_id, roles.id FROM m, roles WHERE roles.code = 'ORGANIZATION_ADMIN' RETURNING 1)
      SELECT (SELECT id FROM u) AS user_id, (SELECT id FROM o) AS org, (SELECT count(*) FROM r) AS n`);

    // Family member ----------------------------------------------------------
    const famDelete = await as(familyUser, org, (c) => c.query("DELETE FROM verification_events WHERE organization_id = $1", [org]));
    const famUpdate = await as(familyUser, org, (c) => c.query("UPDATE verification_events SET location_lat = 0 WHERE organization_id = $1", [org]));
    check("Family cannot delete or change check-ins", blocked(famDelete) && blocked(famUpdate), `delete=${changed(famDelete)} update=${changed(famUpdate)}`);
    const famAccept = await as(familyUser, org, (c) => c.query("UPDATE assignments SET response_status = 'accepted' WHERE id = $1", [mariaAssignment.id]));
    const famDropAssign = await as(familyUser, org, (c) => c.query("DELETE FROM assignments WHERE organization_id = $1", [org]));
    check("Family cannot accept or remove shifts", blocked(famAccept) && blocked(famDropAssign), `accept=${changed(famAccept)} delete=${changed(famDropAssign)}`);
    const famOwm = await as(familyUser, org, (c) => c.query("UPDATE organization_worker_memberships SET status = 'inactive' WHERE organization_id = $1", [org]));
    const famElig = await as(familyUser, org, (c) => c.query("DELETE FROM worker_eligibility WHERE organization_id = $1", [org]));
    const famRoles = await as(familyUser, org, (c) => c.query("DELETE FROM worker_roles WHERE organization_id = $1", [org]));
    check("Family cannot change caregivers' records", blocked(famOwm) && blocked(famElig) && blocked(famRoles), `owm=${changed(famOwm)} eligibility=${changed(famElig)} roles=${changed(famRoles)}`);
    const famInvite = await as(familyUser, org, (c) => c.query("UPDATE family_invitations SET status = 'revoked' WHERE organization_id = $1", [org]));
    const famConsent = await as(familyUser, org, (c) => c.query("DELETE FROM consent_records WHERE organization_id = $1", [org]));
    check("Family cannot change invitations or consents", blocked(famInvite) && blocked(famConsent), `invitations=${changed(famInvite)} consents=${changed(famConsent)}`);
    const famReads = await as(familyUser, org, (c) => count(c, "SELECT count(*) AS n FROM verification_events"));
    const famAllowed = await as(familyUser, org, (c) => count(c, `SELECT count(*) AS n FROM verification_events ve WHERE EXISTS (
      SELECT 1 FROM shifts s JOIN family_relationships fr ON fr.care_recipient_id = s.care_recipient_id
      WHERE s.id = ve.shift_id AND fr.user_id = $1 AND fr.status = 'active')`, [familyUser]));
    check("Family reads only its relative's visits", typeof famReads === "number" && famReads === famAllowed, `reads=${String(famReads)} own-relative=${String(famAllowed)} total=${totalEvents}`);

    // Caregiver -------------------------------------------------------------
    const cgReads = await as(carlosUser, org, (c) => count(c, "SELECT count(*) AS n FROM verification_events WHERE organization_worker_membership_id = $1", [mariaOwm]));
    check("A caregiver cannot read another caregiver's check-ins (with location)", cgReads === 0, String(cgReads));
    const cgDelete = await as(carlosUser, org, (c) => c.query("DELETE FROM verification_events WHERE id = $1", [mariaEvent.id]));
    check("A caregiver cannot delete another caregiver's check-in", blocked(cgDelete), String(changed(cgDelete)));
    const cgAccept = await as(carlosUser, org, (c) => c.query("UPDATE assignments SET response_status = 'declined' WHERE id = $1", [mariaAssignment.id]));
    check("A caregiver cannot answer another caregiver's shift", blocked(cgAccept), String(changed(cgAccept)));
    const cgOwn = await as(carlosUser, org, (c) => c.query("UPDATE assignments SET response_status = 'accepted' WHERE id = $1", [carlosPending.id]));
    check("A caregiver can still answer its own pending shift", changed(cgOwn) === 1, cgOwn instanceof Error ? cgOwn.message : String(changed(cgOwn)));
    const cgOwm = await as(carlosUser, org, (c) => c.query("UPDATE organization_worker_memberships SET status = 'inactive' WHERE id = $1", [mariaOwm]));
    const cgRole = await as(carlosUser, org, (c) => c.query("INSERT INTO worker_roles (organization_id, organization_worker_membership_id, role_label) VALUES ($1, $2, 'RN')", [org, carlosOwm]));
    const cgScope = await as(carlosUser, org, (c) => c.query("DELETE FROM professional_scope WHERE organization_id = $1", [org]));
    const cgOverride = await as(carlosUser, org, (c) => c.query("DELETE FROM verification_overrides WHERE organization_id = $1", [org]));
    const cgHistory = await as(carlosUser, org, (c) => c.query("DELETE FROM assignment_history WHERE organization_id = $1", [org]));
    check("A caregiver cannot change caregiver records, roles, scope, overrides or history",
      blocked(cgOwm) && blocked(cgRole) && blocked(cgScope) && blocked(cgOverride) && blocked(cgHistory),
      `owm=${changed(cgOwm)} role=${changed(cgRole)} scope=${changed(cgScope)} override=${changed(cgOverride)} history=${changed(cgHistory)}`);
    const cgSelfRole = await as(carlosUser, org, (c) => c.query(
      "INSERT INTO user_roles (organization_membership_id, organization_id, role_id) SELECT id, organization_id, (SELECT id FROM roles WHERE code = 'ORGANIZATION_ADMIN') FROM organization_memberships WHERE user_id = $1 AND organization_id = $2",
      [carlosUser, org]));
    check("A caregiver cannot give itself a staff role", blocked(cgSelfRole), String(changed(cgSelfRole)));
    const cgEligOther = await as(carlosUser, org, (c) => c.query("UPDATE worker_eligibility SET computed_at = now() WHERE organization_worker_membership_id = $1", [mariaOwm]));
    const cgEligOwnRows = await count(admin, "SELECT count(*) AS n FROM worker_eligibility WHERE organization_worker_membership_id = $1", [carlosOwm]);
    const cgEligOwn = await as(carlosUser, org, (c) => c.query("UPDATE worker_eligibility SET computed_at = now() WHERE organization_worker_membership_id = $1", [carlosOwm]));
    check("Eligibility: a caregiver's check-in may refresh its own, never another's", blocked(cgEligOther) && changed(cgEligOwn) === cgEligOwnRows,
      `other=${changed(cgEligOther)} own=${changed(cgEligOwn)}/${cgEligOwnRows}`);
    const open = await as(carlosUser, org, (c) => c.query<{ open: boolean }>("SELECT app_shift_has_open_check_in($1) AS open", [mariaEvent.shift_id]));
    const expectedOpen = (await one<{ open: boolean }>(`SELECT EXISTS (SELECT 1 FROM verification_events a WHERE a.shift_id = $1 AND a.event_type = 'check_in'
      AND NOT EXISTS (SELECT 1 FROM verification_events b WHERE b.shift_id = a.shift_id AND b.organization_worker_membership_id = a.organization_worker_membership_id
      AND b.event_type = 'check_out' AND b.occurred_at > a.occurred_at)) AS open`, [mariaEvent.shift_id])).open;
    check("Check-out still knows whether a co-worker is on the shift", !(open instanceof Error) && open.rows[0].open === expectedOpen, `${open instanceof Error ? open.message : open.rows[0].open} expected=${expectedOpen}`);
    const outsiderOpen = await as(outsider.user_id, outsider.org, (c) => c.query<{ open: boolean }>("SELECT app_shift_has_open_check_in($1) AS open", [mariaEvent.shift_id]));
    check("…and that helper says nothing about another agency's shifts", !(outsiderOpen instanceof Error) && outsiderOpen.rows[0].open === false, String(outsiderOpen instanceof Error ? outsiderOpen.message : outsiderOpen.rows[0].open));

    // Staff still work --------------------------------------------------------
    const supReads = await as(supervisorUser, org, (c) => count(c, "SELECT count(*) AS n FROM verification_events"));
    const supAssign = await as(supervisorUser, org, (c) => c.query("UPDATE assignments SET role_in_shift = role_in_shift WHERE id = $1", [mariaAssignment.id]));
    check("Supervisors still see every check-in and manage shifts", supReads === totalEvents && changed(supAssign) === 1, `reads=${String(supReads)}/${totalEvents} update=${changed(supAssign)}`);
    const supOwm = await as(supervisorUser, org, (c) => c.query("UPDATE organization_worker_memberships SET updated_at = now() WHERE id = $1", [mariaOwm]));
    const supWorkerRole = await as(supervisorUser, org, (c) => c.query("UPDATE user_roles SET role_id = role_id WHERE organization_id = $1 AND role_id = $2", [org, workerRoleId]));
    check("Supervisors still manage caregivers; changing roles stays administrator-only (085)", changed(supOwm) === 1 && changed(supWorkerRole) === 0,
      `owm=${changed(supOwm)} role-update=${changed(supWorkerRole)}`);
    // Own records of visits not yet closed (a closed visit is hidden from the caregiver by 076).
    const ownOpen = "SELECT count(*) AS n FROM verification_events ve JOIN shifts s ON s.id = ve.shift_id WHERE ve.organization_worker_membership_id = $1 AND s.status <> 'completed'";
    const cgOwnReads = await as(carlosUser, org, (c) => count(c, ownOpen, [carlosOwm]));
    const cgOwnTotal = await count(admin, ownOpen, [carlosOwm]);
    check("A caregiver still reads its own check-ins", cgOwnReads === cgOwnTotal, `${String(cgOwnReads)}/${cgOwnTotal}`);
    const famAssignments = await as(familyUser, org, (c) => count(c, "SELECT count(*) AS n FROM assignments"));
    const famRolesRead = await as(familyUser, org, (c) => count(c, "SELECT count(*) AS n FROM user_roles"));
    check("Family can still find who to message (reads stay inside the agency)", typeof famAssignments === "number" && famAssignments > 0 && typeof famRolesRead === "number" && famRolesRead > 0,
      `assignments=${String(famAssignments)} roles=${String(famRolesRead)}`);
    const selfLookup = await as(mariaUser, null, (c) => count(c, "SELECT count(*) AS n FROM organization_memberships WHERE user_id = $1", [mariaUser]));
    const selfRoles = await as(mariaUser, null, (c) => count(c, "SELECT count(*) AS n FROM user_roles ur JOIN organization_memberships om ON om.id = ur.organization_membership_id WHERE om.user_id = $1", [mariaUser]));
    check("Sign-in still finds a person's own agencies and roles (no agency chosen)", typeof selfLookup === "number" && selfLookup > 0 && typeof selfRoles === "number" && selfRoles > 0, `memberships=${String(selfLookup)} roles=${String(selfRoles)}`);

    // Another agency ---------------------------------------------------------
    const leaks: string[] = [];
    for (const table of TABLES) {
      const seen = await as(outsider.user_id, outsider.org, (c) => count(c, `SELECT count(*) AS n FROM ${table} WHERE organization_id = $1`, [org]));
      const wrongOrg = await as(outsider.user_id, org, (c) => count(c, `SELECT count(*) AS n FROM ${table} WHERE organization_id = $1`, [org]));
      if (seen !== 0 || wrongOrg !== 0) leaks.push(`${table}=${String(seen)}/${String(wrongOrg)}`);
    }
    check("Another agency sees nothing in any of the 12 tables (even naming our agency)", leaks.length === 0, leaks.join(" ") || "0 rows everywhere");
    const outsiderWrite = await as(outsider.user_id, org, (c) => c.query("DELETE FROM assignments WHERE organization_id = $1", [org]));
    check("Another agency cannot change our shifts", blocked(outsiderWrite), String(changed(outsiderWrite)));

    // No permissive FOR ALL tenant_isolation policy is left -------------------
    const leftovers = (await admin.query<{ t: string }>(`
      SELECT tablename AS t FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE '%tenant_isolation' AND permissive = 'PERMISSIVE' AND cmd = 'ALL'`)).rows.map((r) => r.t);
    check("No open (permissive, read+write) tenant_isolation policy remains", leftovers.length === 0, leftovers.join(",") || "none");

    await admin.query("DELETE FROM assignments WHERE id = $1", [carlosPending.id]);
    await admin.query("DELETE FROM user_roles WHERE organization_membership_id IN (SELECT id FROM organization_memberships WHERE user_id = $1)", [supervisorUser]);
    await admin.query("DELETE FROM organization_memberships WHERE user_id = $1", [supervisorUser]);
    await admin.query("DELETE FROM users WHERE id = $1", [supervisorUser]);
    await admin.query("DELETE FROM user_roles WHERE organization_id = $1", [outsider.org]);
    await admin.query("DELETE FROM organization_memberships WHERE organization_id = $1", [outsider.org]);
    await admin.query("DELETE FROM users WHERE id = $1", [outsider.user_id]);
    await admin.query("DELETE FROM organizations WHERE id = $1", [outsider.org]).catch(() => undefined);
  } finally {
    await runtime.end();
    await admin.end();
  }

  console.log("\nPhase 12.4a · closing the open tenant policies\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Tenant policy closure verification failed:", error);
  process.exit(1);
});
