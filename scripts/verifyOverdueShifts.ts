/**
 * Overdue shifts (B5 audit, 28-oct-2026): a confirmed shift whose scheduled end has
 * passed without ever starting.
 *
 * Proves, with the real app against a disposable database (bootstrap:staging + seedDemo,
 * demo caregiver Carlos, who is eligible):
 *   - «Comenzar turno» (check-in) is refused after the scheduled end: 409
 *     CHECK_IN_OUTSIDE_WINDOW, nothing stored, shift unchanged, no timesheet, no notice;
 *   - «Llegué» and «En camino» keep their existing windows (409);
 *   - a check-in made in time while offline and synced after the end is still accepted
 *     with its real time (and its timesheet stays pending for agency review);
 *   - a current shift starts and finishes as before;
 *   - the agency's audited correction (supervisor override) still works;
 *   - nothing is cancelled or rewritten: the overdue shift stays in the caregiver's list
 *     with its status and assignment;
 *   - the agency's operations center now flags shifts that ended in the last 7 days
 *     without a check-in (it used to drop them at the scheduled end); other agency: 403.
 */
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

for (const name of ["DATABASE_URL", "MIGRATIONS_DATABASE_URL", "DEMO_PASSWORD"] as const) {
  if (!process.env[name]) throw new Error(`${name} is required.`);
}
if (process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires ETNARA_DISPOSABLE_DB=true");

type Json = Record<string, any>;
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });
const HOUR = 3_600_000;

async function main() {
  const runtimeMode = new URL(process.env.DATABASE_URL!).username === "app_runtime";
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const db = new Client({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  await db.connect();

  async function call(method: string, path: string, token: string | null, body?: Json) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json, raw: text };
  }
  async function login(email: string) {
    const r = await call("POST", "/auth/login", null, { email, password: process.env.DEMO_PASSWORD });
    if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status}`);
    return r.body.token as string;
  }

  let enCaminoBefore: boolean | null = null;
  let org = "";
  try {
    const admin = await login("admin@demo.etnara.care");
    const carlos = await login("carlos@demo.etnara.care");
    org = (await db.query(`SELECT om.organization_id FROM organization_memberships om JOIN users u ON u.id=om.user_id WHERE u.email='carlos@demo.etnara.care' AND om.status='active' ORDER BY om.created_at LIMIT 1`)).rows[0].organization_id;
    for (const t of [admin, carlos]) await call("POST", "/me/active-organization", t, { organizationId: org });
    const owm = (await db.query(`SELECT owm.id FROM organization_worker_memberships owm JOIN workers w ON w.id=owm.worker_id JOIN users u ON u.id=w.user_id WHERE u.email='carlos@demo.etnara.care' AND owm.organization_id=$1`, [org])).rows[0].id as string;
    const tag = randomUUID().slice(0, 8);
    const recipient = (await db.query(`INSERT INTO care_recipients (organization_id, first_name, last_name, status) VALUES ($1,'Vencida',$2,'active') RETURNING id`, [org, `Prueba-${tag}`])).rows[0].id as string;

    // «En camino» / «Llegué» are pilot features: switch EN_CAMINO on for this run, restore after.
    enCaminoBefore = (await db.query(`SELECT enabled FROM organization_features WHERE organization_id=$1 AND feature_code='EN_CAMINO'`, [org])).rows[0]?.enabled ?? null;
    await db.query(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'EN_CAMINO',true) ON CONFLICT (organization_id, feature_code) DO UPDATE SET enabled = true`, [org]);

    async function shift(startOffsetH: number, hours: number) {
      const s = (await db.query(`INSERT INTO shifts (organization_id, care_recipient_id, scheduled_start, scheduled_end, status)
        VALUES ($1,$2, now() + make_interval(secs => $3), now() + make_interval(secs => $4), 'confirmed') RETURNING id`,
        [org, recipient, startOffsetH * 3600, (startOffsetH + hours) * 3600])).rows[0].id as string;
      await db.query(`INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, response_status) VALUES ($1,$2,$3,'accepted')`, [org, s, owm]);
      return s;
    }
    const past = await shift(-24 * 33, 2); // like 25-sep seen on 28-oct
    const recent = await shift(-50, 2); // ended 2 days ago, never started
    const endedNow = await shift(-2.2, 2); // ended 12 min ago
    const current = await shift(-0.5, 2); // started 30 min ago
    const P = `/organizations/${org}/shifts`;
    const snapshot = async (id: string) => (await db.query(`SELECT s.status, s.updated_at, a.response_status,
        (SELECT count(*) FROM verification_events v WHERE v.shift_id = s.id)::int AS events,
        (SELECT count(*) FROM shift_arrivals x WHERE x.shift_id = s.id)::int AS arrivals,
        (SELECT count(*) FROM timesheets t WHERE t.shift_id = s.id)::int AS sheets,
        (SELECT count(*) FROM notifications n WHERE n.related_entity_id = s.id AND n.notification_type IN ('SHIFT_STARTED','SHIFT_COMPLETED'))::int AS notices
      FROM shifts s JOIN assignments a ON a.shift_id = s.id WHERE s.id = $1`, [id])).rows[0];
    const before = await snapshot(past);

    // 1. Overdue shift: no start, no arrival, no «en camino», no check-out.
    // Production connects as superuser (RLS bypassed): the code answers 409. With
    // app_runtime, RLS already hides a caregiver's shift once it ended (081): 404.
    const refused = (r: { status: number; body: Json }, code: string) =>
      runtimeMode ? r.status === 404 : r.status === 409 && r.body?.error === code;
    const ci = await call("POST", `${P}/${past}/check-in`, carlos, { verificationMethodCode: "CAREGIVER_SESSION" });
    check(`Turno vencido: «Comenzar turno» rechazado (${runtimeMode ? "404, RLS" : "409 CHECK_IN_OUTSIDE_WINDOW"})`, refused(ci, "CHECK_IN_OUTSIDE_WINDOW"), `${ci.status} ${ci.raw}`);
    const ciOff = await call("POST", `${P}/${past}/check-in`, carlos, { verificationMethodCode: "CAREGIVER_SESSION", clientEventId: randomUUID(), occurredAt: new Date(Date.now() - 60_000).toISOString(), recordedOffline: true });
    check("Turno vencido: tampoco con un registro «sin conexión» de ahora", refused(ciOff, "CHECK_IN_OUTSIDE_WINDOW"), `${ciOff.status} ${ciOff.raw}`);
    const ciOld = await call("POST", `${P}/${past}/check-in`, carlos, { verificationMethodCode: "CAREGIVER_SESSION", clientEventId: randomUUID(), occurredAt: new Date(Date.now() - 24 * 33 * HOUR + HOUR).toISOString(), recordedOffline: true });
    check("Turno vencido: un registro «sin conexión» de hace 33 días se rechaza (400, más de 7 días)", ciOld.status === 400 && ciOld.body?.error === "OCCURRED_AT_OUT_OF_RANGE", `${ciOld.status} ${ciOld.raw}`);
    const arr = await call("POST", `${P}/${past}/arrival`, carlos, {});
    check("Turno vencido: «Llegué» rechazado (regla 107)", refused(arr, "ARRIVAL_OUTSIDE_WINDOW"), `${arr.status} ${arr.raw}`);
    const route = await call("POST", `${P}/${past}/journey/en-route`, carlos, {});
    check("Turno vencido: «En camino» rechazado (regla 113)", runtimeMode ? route.status === 404 || route.status === 409 : route.status === 409 && /OUTSIDE_WINDOW|TIME_INVALID/.test(route.raw), `${route.status} ${route.raw}`);
    const co = await call("POST", `${P}/${past}/check-out`, carlos, {});
    check("Turno vencido: «Finalizar» sin inicio rechazado", refused(co, "NO_ACTIVE_CHECK_IN"), `${co.status} ${co.raw}`);
    const after = await snapshot(past);
    check("Turno vencido: nada se guardó ni cambió (estado, asignación, registros, horas, avisos)",
      JSON.stringify(before) === JSON.stringify(after) && after.status === "confirmed" && after.response_status === "accepted" && after.events === 0 && after.arrivals === 0 && after.sheets === 0 && after.notices === 0,
      JSON.stringify(after));

    // 2. History preserved, nothing cancelled automatically.
    const stored = (await db.query(`SELECT status FROM shifts WHERE id = $1`, [past])).rows[0];
    check("El turno vencido se conserva tal cual (sin cancelar ni reescribir)", stored?.status === "confirmed", stored?.status);
    if (!runtimeMode) {
      const mine = await call("GET", `/organizations/${org}/me/shifts`, carlos);
      const row = (mine.body?.shifts ?? []).find((s: Json) => s.id === past);
      check("Producción (superusuario): sigue en la lista de la cuidadora (el portal lo separa como vencido)", !!row && row.status === "confirmed", `${mine.status} ${row?.status}`);
    }

    // 3. Offline check-in made in time, synced after the end: accepted with its real time.
    const realStart = new Date(Date.now() - 20 * 60_000).toISOString();
    // Only in superuser mode: with app_runtime the shift is already hidden by RLS (081)
    // once it ended, so this offline replay gets 404 (existing behaviour, see report).
    if (!runtimeMode) {
    const late = await call("POST", `${P}/${endedNow}/check-in`, carlos, { verificationMethodCode: "CAREGIVER_SESSION", clientEventId: randomUUID(), occurredAt: realStart, recordedOffline: true });
    check("Inicio hecho a tiempo sin señal y enviado después del final: aceptado con su hora real (201)", late.status === 201, `${late.status} ${late.raw}`);
    const lateOut = await call("POST", `${P}/${endedNow}/check-out`, carlos, {});
    const sheet = (await db.query(`SELECT status, check_in_at FROM timesheets WHERE shift_id = $1`, [endedNow])).rows[0];
    check("…su salida se registra y la hoja de horas queda «pendiente» para revisión de la agencia", lateOut.status === 201 && sheet?.status === "pending" && new Date(sheet.check_in_at).toISOString() === new Date(realStart).toISOString(), `${lateOut.status} ${JSON.stringify(sheet)}`);
    }

    // 4. Regression: a current shift starts and finishes as before.
    const cur = await call("POST", `${P}/${current}/check-in`, carlos, { verificationMethodCode: "CAREGIVER_SESSION" });
    const curOut = await call("POST", `${P}/${current}/check-out`, carlos, {});
    check("Turno en horario: comenzar (201) y finalizar (201) como siempre", cur.status === 201 && curOut.status === 201, `${cur.status}/${curOut.status}`);

    // 5. Operations center: overdue shifts of the last 7 days are flagged for the agency.
    const ops = await call("GET", `/organizations/${org}/operations/center`, admin);
    const alerts = (ops.body?.alerts ?? ops.body?.center?.alerts ?? []) as Json[];
    const flagged = alerts.find((a) => a.relatedEntityId === recent);
    check("Centro de operaciones: turno terminado hace 2 días sin entrada aparece para revisar", ops.status === 200 && !!flagged && flagged.key === `missed_check_in:${recent}` && flagged.title === "Turno terminado sin registro de entrada", `${ops.status} ${JSON.stringify(flagged)}`);
    check("Centro de operaciones: los de más de 7 días no se acumulan (el de hace 33 días no aparece)", !alerts.some((a) => a.relatedEntityId === past));
    check("Centro de operaciones: un turno con entrada registrada no se marca", !alerts.some((a) => a.relatedEntityId === current) && (runtimeMode || !alerts.some((a) => a.relatedEntityId === endedNow)));
    const opsCg = await call("GET", `/organizations/${org}/operations/center`, carlos);
    check("Centro de operaciones: la cuidadora no tiene acceso (403)", opsCg.status === 403, `${opsCg.status}`);

    // 6. The agency's audited correction still works on the overdue shift.
    const ov = await call("POST", `${P}/${recent}/verification/supervisor-override`, admin, { organizationWorkerMembershipId: owm, eventType: "check_in", reason: "Verificación: corrección administrativa auditada" });
    const ovRow = ov.body?.event?.id ? (await db.query(`SELECT o.reason, o.authorized_by_user_id IS NOT NULL AS who FROM verification_overrides o WHERE o.verification_event_id = $1`, [ov.body.event.id])).rows[0] : null;
    check("Corrección de la agencia (override) sigue disponible y queda auditada con motivo", ov.status === 201 && ovRow?.who === true && /corrección/.test(ovRow?.reason ?? ""), `${ov.status} ${JSON.stringify(ovRow)}`);
    const ovCg = await call("POST", `${P}/${past}/verification/supervisor-override`, carlos, { organizationWorkerMembershipId: owm, eventType: "check_in", reason: "intento" });
    check("La cuidadora no puede usar la corrección administrativa (403)", ovCg.status === 403, `${ovCg.status}`);
  } finally {
    if (org) {
      if (enCaminoBefore === null) await db.query(`DELETE FROM organization_features WHERE organization_id=$1 AND feature_code='EN_CAMINO'`, [org]);
      else await db.query(`UPDATE organization_features SET enabled=$2 WHERE organization_id=$1 AND feature_code='EN_CAMINO'`, [org, enCaminoBefore]);
    }
    await db.end();
    server.close();
  }

  console.log(`\nOverdue shifts (${runtimeMode ? "app_runtime, RLS" : "superuser"})\n`);
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail.replace(/\|/g, "/").slice(0, 200)} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
