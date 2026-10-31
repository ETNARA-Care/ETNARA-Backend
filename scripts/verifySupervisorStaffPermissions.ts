/**
 * Supervisor permissions on personnel, credentials, compliance and access (auditoría B4, 27-oct-2026).
 *
 * Policy (085 + Equipo panel): SUPERVISOR manages shifts, residents, caregivers, incidents and
 * messages, and may invite caregivers and family; it does NOT manage the team (staff roles),
 * hours, rates, billing, SmartMatch, or agency-wide configuration. ORGANIZATION_ADMIN does everything.
 * Caregivers, family and other agencies never manage personnel.
 *
 * Calls the real Express app with real payloads as each actor and checks the expected answer:
 * "allow" = 2xx, "deny" = 403/404 (never 2xx, never 5xx). Denied writes must leave no row behind.
 * Synthetic data only, disposable databases only (bootstrap:staging + seedDemo).
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=<superuser url> DEMO_PASSWORD=<demo> \
 *   AUTHZ_DB_MODE=superuser|app_runtime npx tsx scripts/verifySupervisorStaffPermissions.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
const mode = process.env.AUTHZ_DB_MODE ?? "superuser";
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (!process.env.DEMO_PASSWORD) throw new Error("DEMO_PASSWORD is required");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");
if (mode !== "superuser" && mode !== "app_runtime") throw new Error("AUTHZ_DB_MODE must be superuser or app_runtime");

type Expect = "allow" | "deny";
const results: Array<{ check: string; pass: boolean; detail: string }> = [];

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = async (s: string, p: unknown[] = []) => (await db.query(s, p)).rows;

  if (mode === "app_runtime") {
    const pw = randomBytes(24).toString("hex");
    await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${pw}'`);
    const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = pw;
    process.env.DATABASE_URL = u.toString();
  } else process.env.DATABASE_URL = adminUrl;

  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const { hashPassword } = await import("../src/security/password.js");

  const org = (await q(`SELECT id FROM organizations WHERE name = 'Cuidado en Casa Demo'`))[0]?.id as string;
  if (!org) throw new Error("Casa Demo not found: run seedDemo first");
  // The demo seed used to give the supervisor ORGANIZATION_ADMIN; the policy under test is SUPERVISOR.
  await q(`DELETE FROM user_roles ur USING organization_memberships om, users u
            WHERE ur.organization_membership_id = om.id AND om.user_id = u.id AND u.email = 'supervisor@demo.etnara.care'`);
  await q(`INSERT INTO user_roles (organization_membership_id, organization_id, role_id)
           SELECT om.id, om.organization_id, r.id FROM organization_memberships om JOIN users u ON u.id = om.user_id, roles r
            WHERE u.email = 'supervisor@demo.etnara.care' AND om.organization_id = $1 AND r.code = 'SUPERVISOR'`, [org]);

  // Another agency's administrator.
  const tag = randomUUID().slice(0, 8);
  const otherOrg = (await q(`INSERT INTO organizations (name, organization_type, status) VALUES ($1, 'HOME_CARE_AGENCY', 'active') RETURNING id`, [`Rival ${tag}`]))[0].id;
  const otherPw = randomBytes(18).toString("hex");
  const otherUser = (await q(`INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id`, [`rival-${tag}@example.invalid`, await hashPassword(otherPw)]))[0].id;
  const otherM = (await q(`INSERT INTO organization_memberships (user_id, organization_id, status) VALUES ($1, $2, 'active') RETURNING id`, [otherUser, otherOrg]))[0].id;
  await q(`INSERT INTO user_roles (organization_membership_id, organization_id, role_id) SELECT $1, $2, id FROM roles WHERE code = 'ORGANIZATION_ADMIN'`, [otherM, otherOrg]);

  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, json };
  };
  const login = async (email: string, password = process.env.DEMO_PASSWORD!) => {
    const r = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    const token = ((await r.json()) as { token?: string }).token;
    if (!token) throw new Error(`login failed for ${email}`);
    return token;
  };
  const actors = {
    admin: await login("admin@demo.etnara.care"),
    supervisor: await login("supervisor@demo.etnara.care"),
    caregiver: await login("maria@demo.etnara.care"),
    family: await login("familia@demo.etnara.care"),
    otherAgencyAdmin: await login(`rival-${tag}@example.invalid`, otherPw),
  };
  type Actor = keyof typeof actors;
  const expectFor = (allowed: Actor[]) => (a: Actor): Expect => (allowed.includes(a) ? "allow" : "deny");
  const managers = expectFor(["admin", "supervisor"]);
  const adminOnly = expectFor(["admin"]);

  const check = (name: string, actor: Actor, expected: Expect, status: number) => {
    const ok = expected === "allow" ? status >= 200 && status < 300 : status === 403 || status === 404;
    results.push({ check: `${name} [${actor}] ${expected}`, pass: ok, detail: `status=${status}` });
  };

  const A = `/organizations/${org}`;
  const credType = (await q(`SELECT code FROM credential_types ORDER BY code LIMIT 1`))[0].code as string;
  // Fixtures are written directly (superuser connection), so the checks below measure only the
  // authorization of each route, also in app_runtime mode. A fresh caregiver per actor: writes never collide.
  const freshWorker = async () => {
    const workerId = (await q(`INSERT INTO workers (display_name) VALUES ($1) RETURNING id`, [`Sintetica ${randomUUID().slice(0, 6)}`]))[0].id as string;
    const membershipId = (await q(`INSERT INTO organization_worker_memberships (worker_id, organization_id, status, internal_role) VALUES ($1, $2, 'active', 'CNA') RETURNING id`, [workerId, org]))[0].id as string;
    return { membershipId, workerId };
  };
  const freshCredential = async (workerId: string) =>
    (await q(`INSERT INTO credentials (worker_id, credential_type_id, issuing_entity_type, status)
              SELECT $1, id, 'government', 'active' FROM credential_types WHERE code = $2 RETURNING id`, [workerId, credType]))[0].id as string;
  // A credential with a presented document (reviewable), as the caregiver's upload would leave it.
  const adminUserId = (await q(`SELECT id FROM users WHERE email = 'admin@demo.etnara.care'`))[0].id as string;
  const freshReviewableCredential = async (workerId: string) => {
    const credentialId = await freshCredential(workerId);
    const file = (await q(`INSERT INTO stored_files (scope_type, owner_worker_id, storage_key, content_type, original_filename, size_bytes, uploaded_by_user_id)
                           VALUES ('PLATFORM_PROFESSIONAL', $1, $2, 'application/pdf', 'licencia.pdf', 1024, $3) RETURNING id`,
      [workerId, `synthetic/${randomUUID()}.pdf`, adminUserId]))[0].id;
    const doc = (await q(`INSERT INTO documents (worker_id, credential_type_id, file_id)
                          SELECT $1, credential_type_id, $2 FROM credentials WHERE id = $3 RETURNING id`, [workerId, file, credentialId]))[0].id;
    await q(`UPDATE credentials SET document_id = $1 WHERE id = $2`, [doc, credentialId]);
    return credentialId;
  };

  for (const actor of Object.keys(actors) as Actor[]) {
    const t = actors[actor];
    const w = await freshWorker();
    const cred = await freshCredential(w.workerId);
    const workersBefore = Number((await q(`SELECT count(*) FROM organization_worker_memberships WHERE organization_id = $1`, [org]))[0].count);

    // Personnel: read, add, edit, deactivate.
    check("GET workers (roster)", actor, managers(actor), (await call("GET", `${A}/workers`, t)).status);
    check("GET workers/:id (profile + credential status)", actor, managers(actor), (await call("GET", `${A}/workers/${w.membershipId}`, t)).status);
    const created = await call("POST", `${A}/workers`, t, { displayName: `Nueva ${actor}`, internalRole: "HHA" });
    check("POST workers (Añadir personal)", actor, managers(actor), created.status);
    if (managers(actor) === "deny") {
      const after = Number((await q(`SELECT count(*) FROM organization_worker_memberships WHERE organization_id = $1`, [org]))[0].count);
      results.push({ check: `POST workers [${actor}] leaves no row`, pass: after === workersBefore, detail: `${workersBefore}->${after}` });
    }
    check("PATCH workers/:id (edit)", actor, managers(actor), (await call("PATCH", `${A}/workers/${w.membershipId}`, t, { displayName: "Editada" })).status);
    check("PATCH workers/:id (deactivate)", actor, managers(actor), (await call("PATCH", `${A}/workers/${w.membershipId}`, t, { status: "inactive" })).status);
    {
      // Deactivation must change the status and leave an audit row (it used to fail with 500 for everyone).
      const st = (await q(`SELECT status FROM organization_worker_memberships WHERE id = $1`, [w.membershipId]))[0].status;
      const audits = Number((await q(`SELECT count(*) FROM audit_log WHERE action = 'WORKER_MEMBERSHIP_STATUS_CHANGED' AND entity_id = $1`, [w.membershipId]))[0].count);
      const expected = managers(actor) === "allow" ? { st: "inactive", audits: 1 } : { st: "active", audits: 0 };
      results.push({ check: `PATCH workers [${actor}] status=${expected.st} audit=${expected.audits}`, pass: st === expected.st && audits === expected.audits, detail: `${st} audit=${audits}` });
      if (managers(actor) === "allow") {
        check("PATCH workers/:id (reactivate)", actor, "allow", (await call("PATCH", `${A}/workers/${w.membershipId}`, t, { status: "active" })).status);
      }
    }

    // Credentials: read, create, edit, review.
    check("GET credentials", actor, managers(actor), (await call("GET", `${A}/workers/${w.workerId}/credentials`, t)).status);
    check("POST credentials", actor, managers(actor), (await call("POST", `${A}/workers/${w.workerId}/credentials`, t, { credentialTypeCode: credType, issuingEntityType: "government" })).status);
    check("PATCH credential (revoke)", actor, managers(actor), (await call("PATCH", `${A}/workers/${w.workerId}/credentials/${cred}`, t, { status: "revoked" })).status);
    if (managers(actor) === "deny") {
      const st = (await q(`SELECT status FROM credentials WHERE id = $1`, [cred]))[0].status;
      results.push({ check: `PATCH credential [${actor}] status unchanged`, pass: st !== "revoked", detail: st });
    }
    check("GET credential review queue", actor, managers(actor), (await call("GET", `${A}/credentials/review-queue`, t)).status);
    const cred2 = await freshReviewableCredential(w.workerId);
    check("POST credential review (approve)", actor, managers(actor), (await call("POST", `${A}/workers/${w.membershipId}/credentials/${cred2}/review`, t, { reviewStatus: "approved" })).status);

    // Compliance: per-caregiver status (operational) vs agency-wide policy (configuration).
    check("GET workers/:id/compliance", actor, managers(actor), (await call("GET", `${A}/workers/${w.membershipId}/compliance`, t)).status);
    check("GET compliance/configuration", actor, managers(actor), (await call("GET", `${A}/compliance/configuration`, t)).status);
    const policyBefore = (await q(`SELECT md5(coalesce(string_agg(r.id::text || r.is_mandatory::text || r.requires_organization_review::text, ',' ORDER BY r.id), '')) h
                                     FROM requirements r JOIN requirement_sets s ON s.id = r.requirement_set_id WHERE s.organization_id = $1`, [org]))[0].h;
    const put = await call("PUT", `${A}/compliance/configuration`, t, { workerRole: "CNA", requirements: [{ credentialTypeCode: credType, isMandatory: false, requiresOrganizationReview: false }] });
    check("PUT compliance/configuration (agency policy)", actor, adminOnly(actor), put.status);
    if (adminOnly(actor) === "deny") {
      const policyAfter = (await q(`SELECT md5(coalesce(string_agg(r.id::text || r.is_mandatory::text || r.requires_organization_review::text, ',' ORDER BY r.id), '')) h
                                      FROM requirements r JOIN requirement_sets s ON s.id = r.requirement_set_id WHERE s.organization_id = $1`, [org]))[0].h;
      results.push({ check: `PUT compliance/configuration [${actor}] policy unchanged`, pass: policyAfter === policyBefore, detail: "" });
    }
    check("GET compliance/audit", actor, managers(actor), (await call("GET", `${A}/compliance/audit`, t)).status);

    // Access: caregiver invitation (allowed to managers) vs staff team and roles (admin only).
    const w2 = await freshWorker();
    check("POST access-invitations (caregiver)", actor, managers(actor), (await call("POST", `${A}/access-invitations`, t, { type: "worker", email: `inv-${randomUUID().slice(0, 6)}@example.invalid`, workerMembershipId: w2.membershipId })).status);
    check("GET team (staff and roles)", actor, adminOnly(actor), (await call("GET", `${A}/team`, t)).status);
    check("POST team/invitations (staff)", actor, adminOnly(actor), (await call("POST", `${A}/team/invitations`, t, { email: `staff-${randomUUID().slice(0, 6)}@example.invalid`, role: "ORGANIZATION_ADMIN" })).status);
    const supM = (await q(`SELECT om.id FROM organization_memberships om JOIN users u ON u.id = om.user_id WHERE u.email = 'supervisor@demo.etnara.care'`))[0].id;
    if (actor !== "admin") {
      check("POST team/roles (self-promote to admin)", actor, "deny", (await call("POST", `${A}/team/roles`, t, { membershipId: supM, role: "ORGANIZATION_ADMIN", enabled: true })).status);
      const roles = (await q(`SELECT string_agg(r.code, ',') c FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.organization_membership_id = $1`, [supM]))[0].c;
      results.push({ check: `POST team/roles [${actor}] supervisor still SUPERVISOR`, pass: roles === "SUPERVISOR", detail: roles });
    }
  }

  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}  ${r.detail}`);
  console.log(`SUPERVISOR_STAFF_PERMISSIONS mode=${mode} total=${results.length} failed=${failed.length}`);
  server.close(); await pool.end(); await db.end();
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
