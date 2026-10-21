/**
 * Phase 12.1 verification: care recipient address and directions.
 *
 * Real Express app + real logins against a disposable PostgreSQL database
 * prepared by bootstrap:staging + seedDemo. Proves who can read and write
 * care_recipient_locations (migration 082):
 *   - managers read and write
 *   - a worker reads only while assigned to a not-yet-ended shift
 *   - unassigned workers, family members and other organizations get nothing
 *   - workers cannot write; payloads are validated
 * Direct RLS attacks run as app_runtime with forged session context.
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
  async function login(email: string) {
    const r = await call("POST", "/auth/login", null, { email, password: process.env.DEMO_PASSWORD });
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

  try {
    const adminToken = await login("admin@demo.etnara.care");
    const carlos = await login("carlos@demo.etnara.care");
    const maria = await login("maria@demo.etnara.care");
    const family = await login("familia@demo.etnara.care");
    const me = await call("GET", "/me", adminToken);
    const org = (me.body.organizations as Array<{ id: string }>)[0].id;
    for (const t of [adminToken, carlos, maria, family]) await call("POST", "/me/active-organization", t, { organizationId: org });
    const carlosUserId = ((await call("GET", "/me", carlos)).body.user as { id: string }).id;
    const familyUserId = ((await call("GET", "/me", family)).body.user as { id: string }).id;
    const carlosMembership = ((await call("GET", `/organizations/${org}/me/worker-profile`, carlos)).body.workerProfile as { membershipId: string }).membershipId;

    // Recipient the family member is linked to, and a fresh recipient for worker lifecycle checks.
    const familyRecipient = (await admin.query<{ id: string }>(
      "SELECT care_recipient_id AS id FROM family_relationships WHERE user_id = $1 AND status = 'active' LIMIT 1", [familyUserId])).rows[0].id;
    const created = await call("POST", `/organizations/${org}/care-recipients`, adminToken, { firstName: "Dirección", lastName: "Verificación" });
    const recipient = (created.body.recipient as { id: string }).id;
    const path = (id: string) => `/organizations/${org}/care-recipients/${id}/location`;
    const address = { addressLine: "Carr. 156 km 12.3, Bo. Quebrada Grande", municipality: "Barranquitas", accessNotes: "Casa amarilla con portón verde, después de la iglesia", latitude: 18.186123, longitude: -66.306456 };

    // Manager writes and reads.
    const put = await call("PUT", path(recipient), adminToken, address);
    check("Manager saves the address (200)", put.status === 200, `${put.status}`);
    const putFamilyRecipient = await call("PUT", path(familyRecipient), adminToken, { ...address, accessNotes: "Casa del familiar" });
    check("Manager saves the address of the family-linked recipient (200)", putFamilyRecipient.status === 200, `${putFamilyRecipient.status}`);
    const read = await call("GET", path(recipient), adminToken);
    const loc = read.body.location as Json | null;
    check("Manager reads it back exactly", read.status === 200 && loc?.municipality === "Barranquitas" && loc?.latitude === 18.186123 && loc?.longitude === -66.306456, `${read.status}`);

    const supervisor = await login("supervisor@demo.etnara.care");
    await call("POST", "/me/active-organization", supervisor, { organizationId: org });
    const supRead = await call("GET", path(recipient), supervisor);
    const supWrite = await call("PUT", path(recipient), supervisor, address);
    check("Supervisor reads and writes the address", supRead.status === 200 && supWrite.status === 200, `read=${supRead.status} write=${supWrite.status}`);

    // Validation.
    const loneLat = await call("PUT", path(recipient), adminToken, { latitude: 18.2 });
    check("Latitude without longitude is rejected (400)", loneLat.status === 400, `${loneLat.status}`);
    const tooLong = await call("PUT", path(recipient), adminToken, { accessNotes: "x".repeat(501) });
    check("Notes over 500 characters are rejected (400)", tooLong.status === 400, `${tooLong.status}`);
    const extra = await call("PUT", path(recipient), adminToken, { ...address, organizationId: "00000000-0000-0000-0000-000000000000" });
    check("Unknown fields such as organizationId are rejected (400)", extra.status === 400, `${extra.status}`);

    // Worker lifecycle.
    const before = await call("GET", path(recipient), carlos);
    check("Worker without an assignment gets 404", before.status === 404, `${before.status}`);
    const daysAhead = 2 + Math.floor(Math.random() * 300);
    const start = new Date(Date.now() + daysAhead * 86_400_000);
    const shift = await call("POST", `/organizations/${org}/shifts`, adminToken, { careRecipientId: recipient, scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 3 * 3_600_000).toISOString() });
    const shiftId = (shift.body.shift as { id: string }).id;
    const assign = await call("POST", `/organizations/${org}/shifts/${shiftId}/assignments`, adminToken, { organizationWorkerMembershipId: carlosMembership });
    if (assign.status !== 201) throw new Error(`assign failed: ${assign.status} ${JSON.stringify(assign.body)}`);
    const assigned = await call("GET", path(recipient), carlos);
    check("Assigned worker with an upcoming shift reads the address", assigned.status === 200 && (assigned.body.location as Json | null)?.access_notes === address.accessNotes, `${assigned.status}`);
    const otherWorker = await call("GET", path(recipient), maria);
    check("Another, unassigned worker still gets 404", otherWorker.status === 404, `${otherWorker.status}`);
    const workerWrite = await call("PUT", path(recipient), carlos, { addressLine: "Cambiada por el cuidador" });
    check("Worker cannot change the address (403)", workerWrite.status === 403, `${workerWrite.status}`);
    const cancel = await call("POST", `/organizations/${org}/shifts/${shiftId}/cancel`, adminToken, { reason: "Verificación" });
    const afterCancel = await call("GET", path(recipient), carlos);
    check("After the shift is cancelled the worker loses access (404)", cancel.status < 300 && afterCancel.status === 404, `cancel=${cancel.status} read=${afterCancel.status}`);

    // Family.
    const familyRead = await call("GET", path(familyRecipient), family);
    check("Family member of the recipient gets 404 (no address in the family app)", familyRead.status === 404, `${familyRead.status}`);
    const familyRls = await asRuntime(familyUserId, org, async () =>
      (await runtime.query("SELECT count(*) FROM care_recipient_locations WHERE care_recipient_id = $1", [familyRecipient])).rows[0].count);
    check("RLS: family member reads 0 rows directly", familyRls === "0", String(familyRls));

    // Worker direct attacks.
    const workerRls = await asRuntime(carlosUserId, org, async () =>
      (await runtime.query("SELECT count(*) FROM care_recipient_locations WHERE care_recipient_id = $1", [recipient])).rows[0].count);
    check("RLS: worker whose shift was cancelled reads 0 rows for that recipient", workerRls === "0", String(workerRls));
    // Whatever the worker can see must be backed by a live assignment (seeded shifts may legitimately exist).
    const visible = await asRuntime(carlosUserId, org, async () =>
      (await runtime.query<{ id: string }>("SELECT care_recipient_id AS id FROM care_recipient_locations")).rows.map((r) => r.id));
    const backed = visible instanceof Error ? [] : (await admin.query<{ id: string }>(`
      SELECT DISTINCT s.care_recipient_id AS id FROM assignments a
      JOIN shifts s ON s.id = a.shift_id
      JOIN organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id
      JOIN workers w ON w.id = owm.worker_id
      WHERE w.user_id = $1 AND a.organization_id = $2 AND owm.status = 'active'
        AND a.response_status IN ('pending', 'accepted') AND s.status IN ('unassigned', 'confirmed', 'in_progress')
        AND s.scheduled_end > now()`, [carlosUserId, org])).rows.map((r) => r.id);
    const unbacked = visible instanceof Error ? ["error"] : visible.filter((id) => !backed.includes(id));
    check("RLS: every address a worker can read is backed by a live assignment", unbacked.length === 0, `visible=${visible instanceof Error ? "error" : visible.length} unbacked=${unbacked.length}`);
    const workerInsert = await asRuntime(carlosUserId, org, async () =>
      runtime.query("UPDATE care_recipient_locations SET address_line = 'x'"));
    const updatedRows = workerInsert instanceof Error ? -1 : (workerInsert as { rowCount: number }).rowCount;
    check("RLS: worker direct UPDATE changes 0 rows, even on addresses it can read", updatedRows === 0, `rowCount=${updatedRows}`);
    const workerNewRow = await asRuntime(carlosUserId, org, async () =>
      runtime.query("INSERT INTO care_recipient_locations (care_recipient_id, organization_id, address_line) VALUES ($1, $2, 'x')", [recipient, org]));
    check("RLS: worker direct INSERT is rejected", workerNewRow instanceof Error && /row-level security/i.test(workerNewRow.message), workerNewRow instanceof Error ? workerNewRow.message.slice(0, 60) : "inserted");

    // Another organization's manager.
    const other = await admin.query<{ org: string; user: string }>(`
      WITH o AS (INSERT INTO organizations (name, organization_type, status) VALUES ('Otra Agencia Verificación', 'HOME_CARE_AGENCY', 'active') RETURNING id),
           u AS (INSERT INTO users (email, status) VALUES ('otra-agencia-' || gen_random_uuid() || '@example.invalid', 'active') RETURNING id),
           m AS (INSERT INTO organization_memberships (user_id, organization_id, status) SELECT u.id, o.id, 'active' FROM u, o RETURNING id, organization_id),
           r AS (INSERT INTO user_roles (organization_membership_id, organization_id, role_id) SELECT m.id, m.organization_id, roles.id FROM m, roles WHERE roles.code = 'ORGANIZATION_ADMIN' RETURNING 1)
      SELECT (SELECT id FROM o) AS org, (SELECT id FROM u) AS user, (SELECT count(*) FROM r) AS roles`);
    const otherOrg = other.rows[0].org;
    const otherUser = other.rows[0].user;
    const crossRead = await asRuntime(otherUser, otherOrg, async () =>
      (await runtime.query("SELECT count(*) FROM care_recipient_locations WHERE care_recipient_id = $1", [recipient])).rows[0].count);
    check("RLS: another agency's manager reads 0 rows", crossRead === "0", String(crossRead));
    const forged = await asRuntime(otherUser, org, async () =>
      (await runtime.query("SELECT count(*) FROM care_recipient_locations")).rows[0].count);
    check("RLS: another agency's manager forging this org context reads 0 rows", forged === "0" || forged instanceof Error, String(forged));
    const crossInsert = await asRuntime(otherUser, otherOrg, async () =>
      runtime.query("INSERT INTO care_recipient_locations (care_recipient_id, organization_id, address_line) VALUES ($1, $2, 'x')", [recipient, otherOrg]));
    check("Another agency cannot attach an address to this agency's recipient", crossInsert instanceof Error, crossInsert instanceof Error ? crossInsert.message.slice(0, 60) : "inserted");
  } finally {
    await admin.end();
    await runtime.end();
    server.close();
  }

  console.log("\nPhase 12.1 · recipient address and directions\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Recipient location verification failed:", error);
  process.exit(1);
});
