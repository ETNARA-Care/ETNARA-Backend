/**
 * Verifies that accepting a shift adds the caregiver to the care recipient's
 * family-agency conversation (assignments.service syncAssignedWorkerConversationAccess).
 *
 * Before the fix the INSERT failed with "could not determine data type of
 * parameter $4" (an untyped `$n IS NOT NULL`); the error was caught and only
 * logged, so acceptance succeeded but the caregiver never joined the thread.
 *
 * Runs the real Express app against a disposable database prepared by
 * bootstrap:staging + seedDemo and logs in over HTTP as the demo users.
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
  const loggedErrors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { loggedErrors.push(args.map(String).join(" ")); originalError(...args); };

  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = new Client({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  await admin.connect();

  async function call(method: string, path: string, token: string | null, body?: Json) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json };
  }
  async function login(email: string) {
    const r = await call("POST", "/auth/login", null, { email, password: process.env.DEMO_PASSWORD });
    if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status}`);
    return r.body.token as string;
  }

  try {
    const adminToken = await login("admin@demo.etnara.care");
    const carlos = await login("carlos@demo.etnara.care");
    const me = await call("GET", "/me", carlos);
    const org = (me.body.organizations as Array<{ id: string }>)[0].id;
    const carlosUserId = (me.body.user as { id: string }).id;
    for (const t of [adminToken, carlos]) await call("POST", "/me/active-organization", t, { organizationId: org });
    const carlosMembership = ((await call("GET", `/organizations/${org}/me/worker-profile`, carlos)).body.workerProfile as { membershipId: string }).membershipId;

    // A recipient with a family-agency conversation that Carlos is not part of yet.
    const thread = await admin.query<{ id: string; care_recipient_id: string }>(`
      SELECT mt.id, mt.care_recipient_id FROM message_threads mt
      WHERE mt.organization_id = $1 AND mt.thread_type = 'family_agency' AND mt.care_recipient_id IS NOT NULL
      ORDER BY mt.created_at LIMIT 1`, [org]);
    if (!thread.rows[0]) throw new Error("No family-agency thread in the seeded organization.");
    const { id: threadId, care_recipient_id: recipientId } = thread.rows[0];
    await admin.query("DELETE FROM message_thread_participants WHERE message_thread_id = $1 AND user_id = $2", [threadId, carlosUserId]);
    const isParticipant = async () =>
      Number((await admin.query("SELECT count(*) FROM message_thread_participants WHERE message_thread_id = $1 AND user_id = $2", [threadId, carlosUserId])).rows[0].count) === 1;
    check("Before accepting, the caregiver is not in the conversation", !(await isParticipant()));

    const daysAhead = 2 + Math.floor(Math.random() * 300);
    const start = new Date(Date.now() + daysAhead * 86_400_000);
    const end = new Date(start.getTime() + 3 * 3_600_000);
    const shift = await call("POST", `/organizations/${org}/shifts`, adminToken, { careRecipientId: recipientId, scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() });
    if (shift.status !== 201) throw new Error(`create shift failed: ${shift.status} ${JSON.stringify(shift.body)}`);
    const shiftId = (shift.body.shift as { id: string }).id;
    const assign = await call("POST", `/organizations/${org}/shifts/${shiftId}/assignments`, adminToken, { organizationWorkerMembershipId: carlosMembership });
    if (assign.status !== 201) throw new Error(`assign failed: ${assign.status} ${JSON.stringify(assign.body)}`);

    const errorsBefore = loggedErrors.length;
    const accept = await call("POST", `/organizations/${org}/me/shifts/${shiftId}/respond`, carlos, { decision: "accepted" });
    check("Accepting the shift succeeds", accept.status < 300, `${accept.status}`);
    const syncErrors = loggedErrors.slice(errorsBefore).filter((line) => line.includes("messaging synchronization failed"));
    check("No messaging synchronization error is logged", syncErrors.length === 0, syncErrors[0] ?? "");
    check("After accepting, the caregiver is in the recipient's conversation", await isParticipant());

    const list = await call("GET", `/organizations/${org}/conversations`, carlos);
    const ids = ((list.body.conversations as Array<{ id: string }> | undefined) ?? []).map((c) => c.id);
    check("The caregiver sees the conversation in the app", list.status === 200 && ids.includes(threadId), `${list.status} · ${ids.length} conversations`);

    const other = await admin.query(`
      SELECT count(*) FROM message_thread_participants p JOIN message_threads mt ON mt.id = p.message_thread_id
      WHERE p.user_id = $1 AND mt.thread_type = 'family_agency' AND mt.care_recipient_id <> $2
        AND NOT EXISTS (SELECT 1 FROM assignments a JOIN organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id
                        JOIN workers w ON w.id = owm.worker_id JOIN shifts s ON s.id = a.shift_id
                        WHERE w.user_id = $1 AND s.care_recipient_id = mt.care_recipient_id)`, [carlosUserId, recipientId]);
    check("The caregiver is not added to conversations of recipients without an assignment", Number(other.rows[0].count) === 0, `extra=${other.rows[0].count}`);

    // RLS attack: the caregiver tries to join the conversation of a recipient
    // it has no assignment for, directly as app_runtime.
    const foreign = await admin.query<{ recipient: string; thread: string }>(`
      WITH r AS (
        INSERT INTO care_recipients (organization_id, first_name, last_name, status)
        VALUES ($1, 'Verificación', 'Ajena', 'active') RETURNING id
      ), t AS (
        INSERT INTO message_threads (organization_id, thread_type, care_recipient_id)
        SELECT $1, 'family_agency', id FROM r RETURNING id, care_recipient_id
      )
      SELECT care_recipient_id AS recipient, id AS thread FROM t`, [org]);
    const runtime = new Client({ connectionString: process.env.DATABASE_URL });
    await runtime.connect();
    let blocked = false;
    try {
      await runtime.query("BEGIN");
      await runtime.query("SELECT set_config('app.current_user_id', $1, true)", [carlosUserId]);
      await runtime.query("SELECT set_config('app.current_org_id', $1, true)", [org]);
      await runtime.query(
        "INSERT INTO message_thread_participants (organization_id, message_thread_id, user_id, can_write) VALUES ($1, $2, $3, true)",
        [org, foreign.rows[0].thread, carlosUserId],
      );
    } catch (error) {
      blocked = /row-level security/i.test(String(error));
    } finally {
      await runtime.query("ROLLBACK").catch(() => {});
      await runtime.end();
    }
    check("RLS: the caregiver cannot join a conversation of a recipient it is not assigned to", blocked);
  } finally {
    console.error = originalError;
    await admin.end();
    server.close();
  }

  console.log("\nAssignment acceptance · messaging sync\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Assignment messaging sync verification failed:", error);
  process.exit(1);
});
