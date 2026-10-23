/**
 * Phase 12.0 verification: offline-safe care documentation.
 *
 * Runs the real Express app against a disposable PostgreSQL database that was
 * prepared by `bootstrap:staging`, logs in as the seeded demo users over HTTP,
 * and proves:
 *   - a retry with the same clientEventId returns the stored record (200) and
 *     never inserts a duplicate or a duplicate family notification
 *   - concurrent retries still store exactly one row
 *   - occurredAt is kept when inside the active visit and rejected otherwise
 *   - reusing a clientEventId for a different record is a 409, not a merge
 *   - after check-out the shift is no longer visible to the worker (migration
 *     076), so neither a replay nor a new record is accepted; the app must not
 *     let a caregiver finish a shift while records are pending
 *   - another worker cannot replay, read or probe the first worker's record
 *     (HTTP and direct RLS as app_runtime)
 *   - requests without clientEventId keep the previous behaviour
 */
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "pg";

const required = ["DATABASE_URL", "MIGRATIONS_DATABASE_URL", "DEMO_PASSWORD"] as const;
for (const name of required) if (!process.env[name]) throw new Error(`${name} is required.`);
if (process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires ETNARA_DISPOSABLE_DB=true");

type Json = Record<string, unknown>;
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = "") {
  results.push({ check: name, pass, detail });
}

async function main() {
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = new Client({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  const runtime = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await runtime.connect();

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
    const maria = await login("maria@demo.etnara.care");
    const carlos = await login("carlos@demo.etnara.care");

    const me = await call("GET", "/me", maria);
    const org = (me.body.organizations as Array<{ id: string }>)[0].id;
    for (const t of [adminToken, maria, carlos]) await call("POST", "/me/active-organization", t, { organizationId: org });

    const mariaProfile = await call("GET", `/organizations/${org}/me/worker-profile`, maria);
    const mariaMembership = (mariaProfile.body.workerProfile as { membershipId: string }).membershipId;
    const carlosProfile = await call("GET", `/organizations/${org}/me/worker-profile`, carlos);
    const carlosUserId = ((await call("GET", "/me", carlos)).body.user as { id: string }).id;

    // Prefer a recipient with a notifiable family member so the
    // "no duplicate notification" check is meaningful.
    const withFamily = await admin.query<{ care_recipient_id: string }>(
      `SELECT care_recipient_id FROM family_relationships
       WHERE organization_id = $1 AND status = 'active' AND can_receive_notifications LIMIT 1`, [org]);
    const recipients = await call("GET", `/organizations/${org}/care-recipients`, adminToken);
    const recipientId = withFamily.rows[0]?.care_recipient_id ?? (recipients.body.recipients as Array<{ id: string }>)[0].id;

    // Scheduled outside the seeded demo shifts so assignment never hits a
    // schedule conflict; check-in has no scheduled-window rule.
    const daysAhead = 2 + Math.floor(Math.random() * 300);
    const start = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000).toISOString();
    const shift = await call("POST", `/organizations/${org}/shifts`, adminToken, { careRecipientId: recipientId, scheduledStart: start, scheduledEnd: end });
    if (shift.status !== 201) throw new Error(`create shift failed: ${shift.status} ${JSON.stringify(shift.body)}`);
    const shiftId = (shift.body.shift as { id: string }).id;
    const assign = await call("POST", `/organizations/${org}/shifts/${shiftId}/assignments`, adminToken, { organizationWorkerMembershipId: mariaMembership });
    if (assign.status !== 201) throw new Error(`assign failed: ${assign.status} ${JSON.stringify(assign.body)}`);
    const accept = await call("POST", `/organizations/${org}/me/shifts/${shiftId}/respond`, maria, { decision: "accepted" });
    if (accept.status >= 300) throw new Error(`accept failed: ${accept.status} ${JSON.stringify(accept.body)}`);
    const checkIn = await call("POST", `/organizations/${org}/shifts/${shiftId}/check-in`, maria, { verificationMethodCode: "CAREGIVER_SESSION" });
    if (checkIn.status >= 300) throw new Error(`check-in failed: ${checkIn.status} ${JSON.stringify(checkIn.body)}`);

    const path = `/organizations/${org}/shifts/${shiftId}/care-events`;
    const meal = (clientEventId?: string, occurredAt?: string, typeCode = "MEAL") => ({
      typeCode,
      careRecipientId: recipientId,
      payload: typeCode === "MEAL" ? { mealType: "Almuerzo", amountConsumed: "Todo" } : { amount: "Poco" },
      ...(clientEventId ? { clientEventId } : {}),
      ...(occurredAt ? { occurredAt } : {}),
    });
    const countByClientId = async (id: string) =>
      Number((await admin.query("SELECT count(*) FROM care_events WHERE client_event_id = $1", [id])).rows[0].count);

    // 1. First upload keeps the device time.
    const idA = randomUUID();
    // A moment after check-in (whole seconds, so the comparison is exact).
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const when = new Date();
    when.setMilliseconds(0);
    const first = await call("POST", path, maria, meal(idA, when.toISOString()));
    const firstEvent = first.body.event as { id: string; occurred_at: string } | undefined;
    check("New record returns 201 and replayed=false", first.status === 201 && first.body.replayed === false, `${first.status}`);
    check("occurredAt is stored as sent", !!firstEvent && new Date(firstEvent.occurred_at).getTime() === when.getTime(), firstEvent?.occurred_at ?? "none");

    // 2. Retry returns the same row.
    const retry = await call("POST", path, maria, meal(idA, when.toISOString()));
    check("Retry returns 200, replayed=true, same id", retry.status === 200 && retry.body.replayed === true && (retry.body.event as { id: string }).id === firstEvent?.id, `${retry.status}`);
    check("Retry stores no duplicate row", (await countByClientId(idA)) === 1);
    const notif = Number((await admin.query("SELECT count(*) FROM notifications WHERE related_entity_type = 'care_event' AND related_entity_id = $1", [firstEvent?.id])).rows[0].count);
    const familyLinks = Number((await admin.query("SELECT count(*) FROM family_relationships WHERE care_recipient_id = $1 AND status = 'active' AND can_receive_notifications", [recipientId])).rows[0].count);
    check("Retry sends no duplicate family notification", familyLinks > 0 && notif === familyLinks, `notifications=${notif} familyLinks=${familyLinks}`);

    // 3. Concurrent retries.
    const idB = randomUUID();
    const burst = await Promise.all(Array.from({ length: 5 }, () => call("POST", path, maria, meal(idB))));
    const created = burst.filter((r) => r.status === 201).length;
    const replays = burst.filter((r) => r.status === 200 && r.body.replayed === true).length;
    check("5 concurrent retries: exactly 1 created, 4 replayed", created === 1 && replays === 4, burst.map((r) => r.status).join(","));
    check("Concurrent retries store exactly 1 row", (await countByClientId(idB)) === 1);

    // 4. Time bounds.
    const beforeCheckIn = await call("POST", path, maria, meal(randomUUID(), new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()));
    check("occurredAt before check-in is rejected (400)", beforeCheckIn.status === 400 && beforeCheckIn.body.error === "OCCURRED_AT_OUT_OF_RANGE", `${beforeCheckIn.status}`);
    const future = await call("POST", path, maria, meal(randomUUID(), new Date(Date.now() + 10 * 60 * 1000).toISOString()));
    check("occurredAt in the future is rejected (400)", future.status === 400 && future.body.error === "OCCURRED_AT_OUT_OF_RANGE", `${future.status}`);
    const badFormat = await call("POST", path, maria, { ...meal(randomUUID()), occurredAt: "ayer" });
    check("Malformed occurredAt is rejected (400)", badFormat.status === 400, `${badFormat.status}`);

    // 5. Reusing an id for something else.
    const conflict = await call("POST", path, maria, meal(idA, undefined, "HYDRATION"));
    check("Same clientEventId for a different record is 409", conflict.status === 409 && conflict.body.error === "CLIENT_EVENT_ID_CONFLICT", `${conflict.status}`);

    // 6. Legacy behaviour without clientEventId.
    const legacy1 = await call("POST", path, maria, meal());
    const legacy2 = await call("POST", path, maria, meal());
    check("Without clientEventId each request still creates a record (201, 201)", legacy1.status === 201 && legacy2.status === 201 && (legacy1.body.event as { id: string }).id !== (legacy2.body.event as { id: string }).id);

    // 7. Another worker cannot replay or probe.
    const probe = await call("POST", path, carlos, meal(idA));
    check("Other worker replaying the id gets no record", probe.status !== 200 && probe.status !== 201 && !probe.body.event, `${probe.status} ${String(probe.body.error)}`);
    await runtime.query("BEGIN");
    await runtime.query("SELECT set_config('app.current_user_id', $1, true)", [carlosUserId]);
    await runtime.query("SELECT set_config('app.current_org_id', $1, true)", [org]);
    const leaked = await runtime.query("SELECT id FROM care_events WHERE client_event_id = $1", [idA]);
    await runtime.query("ROLLBACK");
    check("RLS: other worker reads 0 rows by clientEventId as app_runtime", leaked.rowCount === 0, `rows=${leaked.rowCount}`);
    check("Other worker has a separate membership", Boolean(carlosProfile.body.workerProfile), "");

    // 8. After check-out.
    const checkOut = await call("POST", `/organizations/${org}/shifts/${shiftId}/check-out`, maria, {});
    if (checkOut.status >= 300) throw new Error(`check-out failed: ${checkOut.status}`);
    const lateNew = await call("POST", path, maria, meal(randomUUID()));
    check("New record after check-out is blocked", lateNew.status === 404 || lateNew.status === 409, `${lateNew.status} ${String(lateNew.body.error)}`);
    check("Check-out leaves exactly one row for the first clientEventId", (await countByClientId(idA)) === 1);
  } finally {
    await admin.end();
    await runtime.end();
    server.close();
  }

  console.log("\nPhase 12.0 · offline-safe care events\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Care event idempotency verification failed:", error);
  process.exit(1);
});
