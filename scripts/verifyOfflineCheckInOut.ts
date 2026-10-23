/**
 * Phase 12.4 verification: check-in / check-out recorded without signal, and
 * the 7-day session for caregiver-only accounts.
 *
 * Real Express app over HTTP against a disposable database prepared by
 * bootstrap:staging + seedDemo (087 applied).
 */
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "pg";

for (const name of ["DATABASE_URL", "MIGRATIONS_DATABASE_URL", "DEMO_PASSWORD"] as const) {
  if (!process.env[name]) throw new Error(`${name} is required.`);
}
if (process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires ETNARA_DISPOSABLE_DB=true");

type Json = Record<string, unknown>;
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });
const HOUR = 3600 * 1000;

async function main() {
  const { createApp } = await import("../src/app.js");
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
  async function loginFull(email: string) {
    const r = await call("POST", "/auth/login", null, { email, password: process.env.DEMO_PASSWORD });
    if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status}`);
    return r.body as { token: string; expiresAt: string; keepSignedIn: boolean };
  }
  const hoursLeft = (iso: string) => Math.round((new Date(iso).getTime() - Date.now()) / HOUR);

  try {
    // Sessions -----------------------------------------------------------------
    const carlosLogin = await loginFull("carlos@demo.etnara.care");
    const adminLogin = await loginFull("admin@demo.etnara.care");
    const familyLogin = await loginFull("familia@demo.etnara.care");
    check("A caregiver-only account gets a 7-day session it may keep on the device",
      carlosLogin.keepSignedIn === true && hoursLeft(carlosLogin.expiresAt) === 168, `${carlosLogin.keepSignedIn} ${hoursLeft(carlosLogin.expiresAt)}h`);
    check("Administrators and family keep the short session",
      !adminLogin.keepSignedIn && !familyLogin.keepSignedIn && hoursLeft(adminLogin.expiresAt) <= 12 && hoursLeft(familyLogin.expiresAt) <= 12,
      `admin=${adminLogin.keepSignedIn}/${hoursLeft(adminLogin.expiresAt)}h family=${familyLogin.keepSignedIn}/${hoursLeft(familyLogin.expiresAt)}h`);
    const adminToken = adminLogin.token;
    const carlos = carlosLogin.token;
    const org = ((await call("GET", "/me", adminToken)).body.organizations as Array<{ id: string }>)[0].id;
    for (const t of [adminToken, carlos]) await call("POST", "/me/active-organization", t, { organizationId: org });

    // Promoted to supervisor -> short session again.
    const carlosOwm = ((await call("GET", `/organizations/${org}/me/worker-profile`, carlos)).body.workerProfile as { membershipId: string }).membershipId;
    await call("POST", `/organizations/${org}/team/roles`, adminToken, { workerMembershipId: carlosOwm, role: "SUPERVISOR", enabled: true });
    const asSupervisor = await loginFull("carlos@demo.etnara.care");
    await call("POST", `/organizations/${org}/team/roles`, adminToken, { workerMembershipId: carlosOwm, role: "SUPERVISOR", enabled: false });
    check("A caregiver who is also a supervisor gets the short session", !asSupervisor.keepSignedIn && hoursLeft(asSupervisor.expiresAt) <= 12,
      `${asSupervisor.keepSignedIn} ${hoursLeft(asSupervisor.expiresAt)}h`);

    // Shift for Carlos ---------------------------------------------------------
    const recipients = await call("GET", `/organizations/${org}/care-recipients`, adminToken);
    const recipientId = (recipients.body.recipients as Array<{ id: string }>)[0].id;
    const daysAhead = 2 + Math.floor(Math.random() * 300);
    const start = new Date(Date.now() + daysAhead * 24 * HOUR).toISOString();
    const end = new Date(Date.now() + daysAhead * 24 * HOUR + 3 * HOUR).toISOString();
    const shift = await call("POST", `/organizations/${org}/shifts`, adminToken, { careRecipientId: recipientId, scheduledStart: start, scheduledEnd: end });
    const shiftId = (shift.body.shift as { id: string }).id;
    await call("POST", `/organizations/${org}/shifts/${shiftId}/assignments`, adminToken, { organizationWorkerMembershipId: carlosOwm });
    await call("POST", `/organizations/${org}/me/shifts/${shiftId}/respond`, carlos, { decision: "accepted" });
    const inPath = `/organizations/${org}/shifts/${shiftId}/check-in`;
    const outPath = `/organizations/${org}/shifts/${shiftId}/check-out`;

    // Time validation.
    const future = await call("POST", inPath, carlos, { verificationMethodCode: "CAREGIVER_SESSION", clientEventId: randomUUID(), occurredAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
    const tooOld = await call("POST", inPath, carlos, { verificationMethodCode: "CAREGIVER_SESSION", clientEventId: randomUUID(), occurredAt: new Date(Date.now() - 8 * 24 * HOUR).toISOString() });
    check("A time in the future or older than 7 days is rejected (400)", future.status === 400 && tooOld.status === 400 && future.body.error === "OCCURRED_AT_OUT_OF_RANGE",
      `future=${future.status} old=${tooOld.status}`);

    // Offline check-in (happened 40 minutes ago, arrives now).
    const inId = randomUUID();
    const inAt = new Date(Date.now() - 40 * 60 * 1000);
    inAt.setMilliseconds(0);
    const checkIn = await call("POST", inPath, carlos, { verificationMethodCode: "CAREGIVER_SESSION", clientEventId: inId, occurredAt: inAt.toISOString() });
    const inEvent = checkIn.body.event as { id: string; occurred_at: string; recorded_offline: boolean } | undefined;
    check("Offline check-in keeps the real time and is marked 'sin conexión' (201)",
      checkIn.status === 201 && new Date(inEvent!.occurred_at).getTime() === inAt.getTime() && inEvent!.recorded_offline === true,
      `${checkIn.status} ${inEvent?.occurred_at} offline=${inEvent?.recorded_offline}`);
    const replayIn = await call("POST", inPath, carlos, { verificationMethodCode: "CAREGIVER_SESSION", clientEventId: inId, occurredAt: inAt.toISOString() });
    check("Sending the same check-in again returns the stored one (200), no duplicate",
      replayIn.status === 200 && replayIn.body.replayed === true && (replayIn.body.event as { id: string }).id === inEvent!.id,
      `${replayIn.status} replayed=${String(replayIn.body.replayed)}`);
    const concurrent = await Promise.all([0, 1, 2].map(() => call("POST", inPath, carlos, { verificationMethodCode: "CAREGIVER_SESSION", clientEventId: inId, occurredAt: inAt.toISOString() })));
    const rowsIn = Number((await admin.query("SELECT count(*) AS n FROM verification_events WHERE shift_id = $1 AND event_type = 'check_in'", [shiftId])).rows[0].n);
    check("Retries arriving together still leave one check-in", concurrent.every((r) => r.status === 200) && rowsIn === 1, `${concurrent.map((r) => r.status).join(",")} rows=${rowsIn}`);

    // Check-out validation and offline check-out.
    const beforeIn = await call("POST", outPath, carlos, { clientEventId: randomUUID(), occurredAt: new Date(inAt.getTime() - 60 * 1000).toISOString() });
    check("A check-out before its check-in is rejected (400)", beforeIn.status === 400, `${beforeIn.status}`);
    const outId = randomUUID();
    const outAt = new Date(Date.now() - 10 * 60 * 1000);
    outAt.setMilliseconds(0);
    const checkOut = await call("POST", outPath, carlos, { clientEventId: outId, occurredAt: outAt.toISOString() });
    const outEvent = checkOut.body.event as { id: string; occurred_at: string; recorded_offline: boolean } | undefined;
    check("Offline check-out keeps the real time and is marked 'sin conexión' (201)",
      checkOut.status === 201 && new Date(outEvent!.occurred_at).getTime() === outAt.getTime() && outEvent!.recorded_offline === true,
      `${checkOut.status} ${outEvent?.occurred_at}`);
    const replayOut = await call("POST", outPath, carlos, { clientEventId: outId, occurredAt: outAt.toISOString() });
    check("Sending the same check-out again after the shift closed returns the stored one (200)",
      replayOut.status === 200 && (replayOut.body.event as { id: string } | undefined)?.id === outEvent!.id, `${replayOut.status} ${String(replayOut.body.error ?? "")}`);
    const replayInLate = await call("POST", inPath, carlos, { verificationMethodCode: "CAREGIVER_SESSION", clientEventId: inId, occurredAt: inAt.toISOString() });
    check("…and a late retry of the check-in too (200)", replayInLate.status === 200, `${replayInLate.status}`);
    const sheet = await admin.query<{ minutes: number }>(
      "SELECT round(extract(epoch FROM (check_out_at - check_in_at)) / 60)::int AS minutes FROM timesheets WHERE shift_id = $1", [shiftId]).catch(() => ({ rows: [] as Array<{ minutes: number }> }));
    check("Hours are counted from the real times (30 min)", sheet.rows[0]?.minutes === 30, `${sheet.rows[0]?.minutes ?? "no timesheet"}`);

    // What the agency sees.
    const visit = await call("GET", `/organizations/${org}/shifts/${shiftId}/visit-verification`, adminToken);
    const events = (visit.body.events as Array<{ eventType: string; recordedOffline: boolean }> | undefined) ?? [];
    check("The agency sees both records marked 'sin conexión'", events.length === 2 && events.every((e) => e.recordedOffline === true) && visit.body.status === "completed",
      `${visit.status} ${events.map((e) => `${e.eventType}:${e.recordedOffline}`).join(" ")} ${String(visit.body.status)}`);

    const sheets = await call("GET", `/organizations/${org}/timesheets?dateFrom=${new Date(Date.now() - 48 * HOUR).toISOString().slice(0, 10)}&dateTo=${new Date(Date.now() + 24 * HOUR).toISOString().slice(0, 10)}`, adminToken);
    const row = ((sheets.body.timesheets as Array<{ shift_id: string; recorded_offline: boolean }> | undefined) ?? []).find((t) => t.shift_id === shiftId);
    check("Agency hours show the visit as recorded without signal", row?.recorded_offline === true, `${sheets.status} ${String(row?.recorded_offline)}`);

    // A short outage: arrives within seconds but the device says it waited.
    const shift3 = await call("POST", `/organizations/${org}/shifts`, adminToken, { careRecipientId: recipientId, scheduledStart: new Date(new Date(start).getTime() + 10 * HOUR).toISOString(), scheduledEnd: new Date(new Date(start).getTime() + 12 * HOUR).toISOString() });
    const shift3Id = (shift3.body.shift as { id: string }).id;
    await call("POST", `/organizations/${org}/shifts/${shift3Id}/assignments`, adminToken, { organizationWorkerMembershipId: carlosOwm });
    await call("POST", `/organizations/${org}/me/shifts/${shift3Id}/respond`, carlos, { decision: "accepted" });
    const shortIn = await call("POST", `/organizations/${org}/shifts/${shift3Id}/check-in`, carlos, { verificationMethodCode: "CAREGIVER_SESSION", clientEventId: randomUUID(), occurredAt: new Date(Date.now() - 5000).toISOString(), recordedOffline: true });
    await call("POST", `/organizations/${org}/shifts/${shift3Id}/check-out`, carlos, {});
    check("A short outage is still marked 'sin conexión' when the phone waited for signal",
      shortIn.status === 201 && (shortIn.body.event as { recorded_offline: boolean }).recorded_offline === true, `${shortIn.status}`);

    // Online behaviour unchanged.
    const shift2 = await call("POST", `/organizations/${org}/shifts`, adminToken, { careRecipientId: recipientId, scheduledStart: new Date(new Date(start).getTime() + 5 * HOUR).toISOString(), scheduledEnd: new Date(new Date(start).getTime() + 7 * HOUR).toISOString() });
    const shift2Id = (shift2.body.shift as { id: string }).id;
    await call("POST", `/organizations/${org}/shifts/${shift2Id}/assignments`, adminToken, { organizationWorkerMembershipId: carlosOwm });
    await call("POST", `/organizations/${org}/me/shifts/${shift2Id}/respond`, carlos, { decision: "accepted" });
    const onlineIn = await call("POST", `/organizations/${org}/shifts/${shift2Id}/check-in`, carlos, { verificationMethodCode: "CAREGIVER_SESSION" });
    const onlineOut = await call("POST", `/organizations/${org}/shifts/${shift2Id}/check-out`, carlos, {});
    check("Without signal fields, check-in/out work as before and are not marked offline",
      onlineIn.status === 201 && onlineOut.status === 201 && (onlineIn.body.event as { recorded_offline: boolean }).recorded_offline === false,
      `${onlineIn.status},${onlineOut.status}`);

    // Another caregiver cannot replay Carlos's ids.
    const maria = (await loginFull("maria@demo.etnara.care")).token;
    await call("POST", "/me/active-organization", maria, { organizationId: org });
    const steal = await call("POST", inPath, maria, { verificationMethodCode: "CAREGIVER_SESSION", clientEventId: inId });
    check("Another caregiver cannot use someone else's record id", steal.status === 404 || steal.status === 409, `${steal.status} ${String(steal.body.error)}`);
  } finally {
    await admin.end();
    server.close();
  }

  console.log("\nPhase 12.4 · offline check-in/out and caregiver session\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Offline check-in/out verification failed:", error);
  process.exit(1);
});
