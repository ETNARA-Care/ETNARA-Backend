/**
 * ETNARA Finanzas F0 — safe financial foundation, end to end over HTTP and as
 * app_runtime in PostgreSQL. Synthetic data only (.invalid e-mails).
 *
 * Proves, for the existing financial tables (timesheets, worker_financial_rates,
 * pay_periods, pay_period_timesheets) and the new finance_events:
 *  - amounts never land in audit_log, and financial audit rows are hidden from
 *    supervisors, caregivers and ETNARA central (H-01);
 *  - only ORGANIZATION_ADMIN reads or writes them at the database level (085,
 *    re-checked here), and ETNARA central is denied explicitly (H-06);
 *  - an approved timesheet cannot be changed, even by the table owner (H-03);
 *  - date ranges use Puerto Rico days, not UTC days (H-04);
 *  - an overlapping pay period answers 409, not 500 (H-05);
 *  - FINANZAS is a valid per-agency switch, off by default;
 *  - check-out, review and the supervisor operations center keep working.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });
const HOUR = 3600 * 1000;
const FINANCIAL_ACTIONS = [
  "WORKER_FINANCIAL_RATE_CHANGED", "TIMESHEET_CREATED", "TIMESHEET_APPROVED",
  "TIMESHEET_DISPUTED", "TIMESHEET_SKIPPED_LONG_VISIT", "PAY_PERIOD_CLOSED",
];
const MONEY_KEY = /cents|amount|rate/i;

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const runtime = new pg.Client({ connectionString: u.toString() });
  await runtime.connect();
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  const all: Array<{ status: number; body: Json }> = [];

  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    const out = { status: res.status, body: parsed };
    all.push(out);
    return out;
  }

  /** Runs `sql` as app_runtime with the given security context; always rolled back. */
  async function asSession<T extends pg.QueryResultRow = pg.QueryResultRow>(
    ctx: { userId: string; orgId: string; superadmin?: boolean }, sql: string, params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number; error?: string }> {
    await runtime.query("BEGIN");
    try {
      await runtime.query("SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)",
        [ctx.userId, ctx.orgId, ctx.superadmin ? "true" : "false"]);
      const r = await runtime.query<T>(sql, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    } catch (e) {
      return { rows: [], rowCount: 0, error: e instanceof Error ? e.message : String(e) };
    } finally {
      await runtime.query("ROLLBACK");
    }
  }

  async function agency(name: string) {
    const id = (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`${name} ${tag}`])).rows[0].id;
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'FIN') RETURNING id`, [id])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) SELECT $1,id,true,false FROM credential_types WHERE code='BLS'`, [rs]);
    return id;
  }
  type P = { email: string; userId: string; token: string; owm?: string; orgId: string };
  async function person(orgId: string, key: string, roles: string[], worker = false): Promise<P> {
    const email = `fin-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let owm: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Synthetic ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [owm, orgId]);
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) SELECT $1,id,'external_provider','active',current_date+365 FROM credential_types WHERE code='BLS'`, [workerId]);
      for (let d = 0; d < 7; d++) await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,'06:00','22:00')`, [owm, orgId, d]);
    }
    const p: P = { email, userId, token: "", owm, orgId };
    const r = await call("POST", "/auth/login", "", { email, password });
    if (r.status !== 200) throw new Error(`login ${email} ${r.status}`);
    p.token = r.body.token;
    await call("POST", "/me/active-organization", p.token, { organizationId: orgId });
    return p;
  }

  const orgA = await agency("Finanzas A");
  const orgB = await agency("Finanzas B");
  const adm = await person(orgA, "admin", ["ORGANIZATION_ADMIN"]);
  const sup = await person(orgA, "supervisor", ["SUPERVISOR"]);
  const cg = await person(orgA, "cg", ["WORKER"], true);
  const admB = await person(orgB, "adminb", ["ORGANIZATION_ADMIN"]);
  const fam = await person(orgA, "family", ["FAMILY"]);
  const centralUser = (await q<{ id: string }>(`INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id`, [`fin-central-${tag}@example.invalid`])).rows[0].id;
  await q("INSERT INTO platform_admins (user_id) VALUES ($1)", [centralUser]);
  const recipientId = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Sintetico',$2,'active') RETURNING id`, [orgA, `R-${tag}`])).rows[0].id;
  const O = `/organizations/${orgA}`;
  const central = { userId: centralUser, orgId: orgA, superadmin: true };

  let day = 3;
  async function visit() {
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day++, 14);
    const s = await call("POST", `${O}/shifts`, adm.token, { careRecipientId: recipientId, scheduledStart: new Date(start).toISOString(), scheduledEnd: new Date(start + 3 * HOUR).toISOString() });
    if (s.status !== 201) throw new Error(`shift ${s.status} ${JSON.stringify(s.body)}`);
    const id = s.body.shift.id as string;
    const a = await call("POST", `${O}/shifts/${id}/assignments`, adm.token, { organizationWorkerMembershipId: cg.owm });
    if (a.status !== 201) throw new Error(`assign ${a.status} ${JSON.stringify(a.body)}`);
    const r = await call("POST", `${O}/me/shifts/${id}/respond`, cg.token, { decision: "accepted" });
    if (r.status !== 200) throw new Error(`respond ${r.status} ${JSON.stringify(r.body)}`);
    await call("POST", `${O}/shifts/${id}/check-in`, cg.token, { verificationMethodCode: "CAREGIVER_SESSION" });
    await q(`UPDATE verification_events SET occurred_at = now() - interval '2 hours' WHERE shift_id = $1 AND event_type = 'check_in'`, [id]);
    const o = await call("POST", `${O}/shifts/${id}/check-out`, cg.token, {});
    if (o.status !== 201) throw new Error(`check-out ${o.status} ${JSON.stringify(o.body)}`);
    return (await q<{ id: string }>("SELECT id FROM timesheets WHERE shift_id = $1", [id])).rows[0].id;
  }
  /** Moves a pending timesheet to fixed instants (UTC ISO). */
  const placeAt = (id: string, inIso: string, outIso: string) =>
    q("UPDATE timesheets SET check_in_at=$2, check_out_at=$3 WHERE id=$1", [id, inIso, outIso]);

  try {
    // F01 The switch exists and is off unless ETNARA central turns it on.
    const sw = await q("INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'FINANZAS',false) RETURNING enabled", [orgA])
      .then((r) => r.rows[0]?.enabled === false).catch((e: Error) => e.message);
    check("F01 FINANZAS is a valid per-agency switch (stored off)", sw === true, String(sw));

    // F02 Rates: admin sets them over HTTP; supervisor is refused (regression).
    const rate = await call("PUT", `${O}/financial-rates/${cg.owm}`, adm.token, { payRateCents: 1500, billRateCents: 2500, currency: "USD" });
    const supRate = await call("GET", `${O}/financial-rates`, sup.token);
    check("F02 admin saves rates (200); supervisor GET rates is 403", rate.status === 200 && supRate.status === 403, `${rate.status}/${supRate.status}`);

    // F03 Check-out still records a timesheet with the rate snapshot (no 500).
    const ts1 = await visit();
    const ts2 = await visit();
    const snap = (await q<{ pay_rate_cents_snapshot: number; bill_rate_cents_snapshot: number; status: string }>("SELECT pay_rate_cents_snapshot, bill_rate_cents_snapshot, status FROM timesheets WHERE id=$1", [ts1])).rows[0];
    check("F03 check-out records a pending timesheet with the rate snapshot", snap?.status === "pending" && snap.pay_rate_cents_snapshot === 1500 && snap.bill_rate_cents_snapshot === 2500, JSON.stringify(snap));

    // ts1 -> 20 Mar (15:00 AST); ts2 -> 10 Mar 21:30 AST = 11 Mar 01:30 UTC.
    await placeAt(ts1, "2026-03-20T19:00:00Z", "2026-03-20T21:00:00Z");
    await placeAt(ts2, "2026-03-11T01:30:00Z", "2026-03-11T03:30:00Z");

    // F04 Review still works over HTTP.
    const appr = await call("POST", `${O}/timesheets/${ts1}/review`, adm.token, { decision: "approved" });
    check("F04 admin approves a pending timesheet (200)", appr.status === 200, `${appr.status} ${appr.body.error ?? ""}`);

    // F05 New audit_log rows carry no amounts.
    const fresh = await q<{ action: string; previous_value: Json | null; new_value: Json | null }>(
      "SELECT action, previous_value, new_value FROM audit_log WHERE organization_id=$1 AND action = ANY($2)", [orgA, FINANCIAL_ACTIONS]);
    const leaking = fresh.rows.filter((r) => [r.previous_value, r.new_value].some((v) => v && Object.keys(v).some((k) => MONEY_KEY.test(k))));
    check("F05 audit_log rows written in this run contain no rates or amounts", fresh.rows.length >= 2 && leaking.length === 0, `${fresh.rows.length} rows, ${leaking.length} with money: ${leaking.map((r) => r.action).join(",")}`);

    // F06-F08 Financial audit rows are invisible to caregiver, supervisor and ETNARA central.
    const fin = "SELECT count(*)::int n FROM audit_log WHERE action = ANY($1)";
    const cgA = await asSession<{ n: number }>({ userId: cg.userId, orgId: orgA }, fin, [FINANCIAL_ACTIONS]);
    const supA = await asSession<{ n: number }>({ userId: sup.userId, orgId: orgA }, fin, [FINANCIAL_ACTIONS]);
    const cenA = await asSession<{ n: number }>(central, fin, [FINANCIAL_ACTIONS]);
    const admA = await asSession<{ n: number }>({ userId: adm.userId, orgId: orgA }, fin, [FINANCIAL_ACTIONS]);
    check("F06 caregiver cannot read financial audit rows", cgA.rows[0]?.n === 0, JSON.stringify(cgA.rows[0] ?? cgA.error));
    check("F07 supervisor cannot read financial audit rows", supA.rows[0]?.n === 0, JSON.stringify(supA.rows[0] ?? supA.error));
    check("F08 ETNARA central cannot read financial audit rows", cenA.rows[0]?.n === 0, JSON.stringify(cenA.rows[0] ?? cenA.error));
    check("F09 the agency admin still reads its own financial audit trail", (admA.rows[0]?.n ?? 0) >= 2, JSON.stringify(admA.rows[0] ?? admA.error));

    // F10-F13 finance_events: admin-only, per agency, append-only.
    const fe = "SELECT action, previous_value, new_value FROM finance_events WHERE organization_id=$1";
    const feAdm = await asSession<{ action: string; new_value: Json }>({ userId: adm.userId, orgId: orgA }, fe, [orgA]);
    const rateEv = feAdm.rows.find((r) => r.action === "WORKER_FINANCIAL_RATE_CHANGED");
    const apprEv = feAdm.rows.find((r) => r.action === "TIMESHEET_APPROVED");
    check("F10 admin reads finance_events with the values (rate change and approval)",
      !feAdm.error && rateEv?.new_value?.pay_rate_cents === 1500 && apprEv?.new_value?.bill_amount_cents === 5000,
      feAdm.error ?? `${feAdm.rows.length} events`);
    const feB = await asSession<{ n: number }>({ userId: admB.userId, orgId: orgB }, "SELECT count(*)::int n FROM finance_events WHERE organization_id <> $1", [orgB]);
    check("F11 another agency's admin sees none of agency A's finance_events", feB.rows[0]?.n === 0, JSON.stringify(feB.rows[0] ?? feB.error));
    const feOthers = [
      await asSession<{ n: number }>({ userId: sup.userId, orgId: orgA }, "SELECT count(*)::int n FROM finance_events"),
      await asSession<{ n: number }>({ userId: cg.userId, orgId: orgA }, "SELECT count(*)::int n FROM finance_events"),
      await asSession<{ n: number }>(central, "SELECT count(*)::int n FROM finance_events"),
    ];
    check("F12 supervisor, caregiver and ETNARA central read 0 finance_events", feOthers.every((r) => r.rows[0]?.n === 0), feOthers.map((r) => r.rows[0]?.n ?? r.error).join("/"));
    const feUpd = await asSession({ userId: adm.userId, orgId: orgA }, "UPDATE finance_events SET action='X' WHERE organization_id=$1", [orgA]);
    const feDel = await asSession({ userId: adm.userId, orgId: orgA }, "DELETE FROM finance_events WHERE organization_id=$1", [orgA]);
    const feOwnerUpd = await q("UPDATE finance_events SET action='X' WHERE organization_id=$1", [orgA]).then(() => "updated").catch((e: Error) => e.message);
    check("F13 finance_events is append-only (admin UPDATE/DELETE refused, owner UPDATE refused)",
      Boolean(feUpd.error) && Boolean(feDel.error) && feOwnerUpd !== "updated" && ![feUpd.error, feDel.error, feOwnerUpd].some((m) => /does not exist/.test(String(m))), `${feUpd.error ?? "ok"} | ${feDel.error ?? "ok"} | ${feOwnerUpd}`);

    // F14 Pay period: close one range, then an overlapping range -> 409.
    const close1 = await call("POST", `${O}/pay-periods/close`, adm.token, { dateFrom: "2026-03-15", dateTo: "2026-03-25", cadence: "custom" });
    const close2 = await call("POST", `${O}/pay-periods/close`, adm.token, { dateFrom: "2026-03-19", dateTo: "2026-03-21", cadence: "custom" });
    check("F14 closing a period works (201); an overlapping period is 409 PAY_PERIOD_OVERLAP, not 500",
      close1.status === 201 && close2.status === 409 && close2.body.error === "PAY_PERIOD_OVERLAP", `${close1.status} / ${close2.status} ${close2.body.error ?? ""}`);

    // F15-F17 Database-level boundary on the existing financial tables.
    const tables = ["timesheets", "worker_financial_rates", "pay_periods", "pay_period_timesheets"];
    const ownerCounts: number[] = [], supCounts: Array<number | string | undefined> = [], cenCounts: Array<number | string | undefined> = [];
    for (const t of tables) {
      ownerCounts.push((await q<{ n: number }>(`SELECT count(*)::int n FROM ${t} WHERE organization_id=$1`, [orgA])).rows[0].n);
      const s = await asSession<{ n: number }>({ userId: sup.userId, orgId: orgA }, `SELECT count(*)::int n FROM ${t}`);
      supCounts.push(s.rows[0]?.n ?? s.error);
      const c = await asSession<{ n: number }>(central, `SELECT count(*)::int n FROM ${t}`);
      cenCounts.push(c.rows[0]?.n ?? c.error);
    }
    check("F15 seed visible to the owner in all four tables", ownerCounts.every((n) => n > 0), ownerCounts.join("/"));
    check("F16 supervisor reads 0 rows from timesheets, rates and pay periods (database)", supCounts.every((n) => n === 0), supCounts.join("/"));
    check("F17 ETNARA central reads 0 rows from timesheets, rates and pay periods (database)", cenCounts.every((n) => n === 0), cenCounts.join("/"));
    const supUpd = await asSession({ userId: sup.userId, orgId: orgA }, "UPDATE timesheets SET review_note='x' WHERE organization_id=$1 AND status='pending'", [orgA]);
    const supRateUpd = await asSession({ userId: sup.userId, orgId: orgA }, "UPDATE worker_financial_rates SET pay_rate_cents=1 WHERE organization_id=$1", [orgA]);
    check("F18 supervisor UPDATE on timesheets and rates touches 0 rows", !supUpd.error && supUpd.rowCount === 0 && !supRateUpd.error && supRateUpd.rowCount === 0,
      `${supUpd.rowCount} ${supUpd.error ?? ""} / ${supRateUpd.rowCount} ${supRateUpd.error ?? ""}`);

    // F19 An approved timesheet is immutable in the database, for the admin and the owner.
    const admUpd = await asSession({ userId: adm.userId, orgId: orgA }, "UPDATE timesheets SET approved_minutes=999, pay_amount_cents=1 WHERE id=$1", [ts1]);
    const ownerUpd = await q("UPDATE timesheets SET approved_minutes=999 WHERE id=$1", [ts1]).then(() => "updated").catch((e: Error) => e.message);
    const after = (await q<{ approved_minutes: number }>("SELECT approved_minutes FROM timesheets WHERE id=$1", [ts1])).rows[0];
    check("F19 approved timesheet cannot be changed (admin session and owner refused)",
      Boolean(admUpd.error) && ownerUpd !== "updated" && after.approved_minutes === 120, `${admUpd.error ?? `rows=${admUpd.rowCount}`} | ${ownerUpd} | ${after.approved_minutes}`);

    // F20 Puerto Rico days: 21:30 AST on 10 Mar belongs to 10 Mar, not 11 Mar.
    const d10 = await call("GET", `${O}/timesheets?dateFrom=2026-03-10&dateTo=2026-03-10`, adm.token);
    const d11 = await call("GET", `${O}/timesheets?dateFrom=2026-03-11&dateTo=2026-03-11`, adm.token);
    const in10 = (d10.body.timesheets ?? []).some((t: Json) => t.id === ts2);
    const in11 = (d11.body.timesheets ?? []).some((t: Json) => t.id === ts2);
    check("F20 a visit at 21:30 AST is listed on its Puerto Rico day", d10.status === 200 && in10 && !in11, `10 Mar: ${in10}, 11 Mar: ${in11}`);

    // F21 Operations center unchanged: the admin sees hours awaiting review (no
    // amounts in the alert); the supervisor gets 200 without hours (085, ETN-040).
    const opsAdm = await call("GET", `${O}/operations/center`, adm.token);
    const opsSup = await call("GET", `${O}/operations/center`, sup.token);
    const alert = (opsAdm.body.alerts ?? []).find((a: Json) => a.category === "pending_timesheet" && a.relatedEntityId === ts2);
    const supHours = (opsSup.body.alerts ?? []).filter((a: Json) => a.category === "pending_timesheet").length;
    check("F21 operations center: admin sees the pending hours (no amounts), supervisor 200 without hours",
      opsAdm.status === 200 && Boolean(alert) && !Object.keys(alert ?? {}).some((k) => MONEY_KEY.test(k)) && opsSup.status === 200 && supHours === 0,
      `${opsAdm.status} ${alert ? "found" : "missing"} / ${opsSup.status} supervisor hours=${supHours}`);

    // F23-F31 Negative access per role, at the database and over HTTP.
    const roles: Array<[string, { userId: string; orgId: string; superadmin?: boolean }]> = [
      ["caregiver", { userId: cg.userId, orgId: orgA }],
      ["family", { userId: fam.userId, orgId: orgA }],
      ["supervisor", { userId: sup.userId, orgId: orgA }],
      ["central", central],
      ["adminB(ctx A)", { userId: admB.userId, orgId: orgA }],
    ];
    const readLeaks: string[] = [];
    for (const [name, ctx] of roles) {
      for (const t of [...tables, "finance_events"]) {
        const r = await asSession<{ n: number }>(ctx, `SELECT count(*)::int n FROM ${t}`);
        if (r.error || r.rows[0]?.n !== 0) readLeaks.push(`${name}:${t}=${r.rows[0]?.n ?? r.error}`);
      }
      const a = await asSession<{ n: number }>(ctx, fin, [FINANCIAL_ACTIONS]);
      if (a.error || a.rows[0]?.n !== 0) readLeaks.push(`${name}:audit=${a.rows[0]?.n ?? a.error}`);
    }
    check("F23 caregiver, family, supervisor, ETNARA central and another agency's admin read 0 financial rows (5 tables + financial audit)",
      readLeaks.length === 0, readLeaks.join(" ") || "0 leaks");

    const writeLeaks: string[] = [];
    for (const [name, ctx] of roles) {
      const ins = await asSession(ctx, "INSERT INTO finance_events (organization_id,actor_user_id,action,entity_type,entity_id) VALUES ($1,$2,'FINANCE_FORGED','x',$1)", [orgA, ctx.userId]);
      if (!ins.error) writeLeaks.push(`${name}:insert finance_events`);
      const up = await asSession(ctx, "UPDATE timesheets SET review_note='x' WHERE organization_id=$1", [orgA]);
      if (!up.error && up.rowCount > 0) writeLeaks.push(`${name}:update timesheets=${up.rowCount}`);
      const ur = await asSession(ctx, "UPDATE worker_financial_rates SET bill_rate_cents=1 WHERE organization_id=$1", [orgA]);
      if (!ur.error && ur.rowCount > 0) writeLeaks.push(`${name}:update rates=${ur.rowCount}`);
      const ir = await asSession(ctx, "INSERT INTO worker_financial_rates (organization_worker_membership_id,organization_id,pay_rate_cents,bill_rate_cents,created_by_user_id,updated_by_user_id) VALUES ($1,$2,1,1,$3,$3) ON CONFLICT DO NOTHING", [cg.owm, orgA, ctx.userId]);
      if (!ir.error && ir.rowCount > 0) writeLeaks.push(`${name}:insert rates`);
      const ip = await asSession(ctx, "INSERT INTO pay_periods (organization_id,date_from,date_to,cadence,status) VALUES ($1,'2030-01-01','2030-01-02','custom','open')", [orgA]);
      if (!ip.error) writeLeaks.push(`${name}:insert pay_periods`);
    }
    check("F24 none of those roles can write finance_events, timesheets, rates or pay periods (database)",
      writeLeaks.length === 0, writeLeaks.join(" ") || "all refused");

    const forged = await asSession({ userId: adm.userId, orgId: orgA }, "INSERT INTO finance_events (organization_id,actor_user_id,action,entity_type,entity_id) VALUES ($1,$2,'FINANCE_FORGED','x',$1)", [orgB, adm.userId]);
    const asOther = await asSession({ userId: adm.userId, orgId: orgA }, "INSERT INTO finance_events (organization_id,actor_user_id,action,entity_type,entity_id) VALUES ($1,$2,'FINANCE_FORGED','x',$1)", [orgA, sup.userId]);
    check("F25 an admin cannot write finance_events for another agency or in another user's name", Boolean(forged.error) && Boolean(asOther.error),
      `${forged.error ?? "ALLOWED"} | ${asOther.error ?? "ALLOWED"}`);

    const httpPaths = [`${O}/financial-rates`, `${O}/timesheets?dateFrom=2026-03-01&dateTo=2026-03-31`, `${O}/pay-periods`, `${O}/pay-periods/preview?dateFrom=2026-03-01&dateTo=2026-03-31`];
    const httpLeaks: string[] = [];
    for (const [name, p] of [["caregiver", cg], ["family", fam], ["supervisor", sup], ["adminB", admB]] as const) {
      for (const path of httpPaths) {
        const r = await call("GET", path, p.token);
        if (r.status !== 403 || MONEY_KEY.test(JSON.stringify(r.body))) httpLeaks.push(`${name} ${path.split("?")[0].split("/").pop()}=${r.status}`);
      }
      const w = await call("PUT", `${O}/financial-rates/${cg.owm}`, p.token, { payRateCents: 1, billRateCents: 1, currency: "USD" });
      if (w.status !== 403) httpLeaks.push(`${name} PUT rate=${w.status}`);
    }
    check("F26 caregiver, family, supervisor and another agency's admin get 403 on every money route (HTTP, read and write)",
      httpLeaks.length === 0, httpLeaks.join(" ") || "all 403");

    const reapprove = await call("POST", `${O}/timesheets/${ts1}/review`, adm.token, { decision: "disputed", note: "reabrir" });
    check("F27 an approved timesheet cannot be re-reviewed over HTTP (409)", reapprove.status === 409, `${reapprove.status} ${reapprove.body.error ?? ""}`);

    const prev10 = await call("GET", `${O}/pay-periods/preview?dateFrom=2026-03-10&dateTo=2026-03-10&cadence=custom`, adm.token);
    const prev11 = await call("GET", `${O}/pay-periods/preview?dateFrom=2026-03-11&dateTo=2026-03-11&cadence=custom`, adm.token);
    check("F28 pay-period preview uses Puerto Rico days (21:30 AST pending visit counted on 10 Mar, not 11 Mar)",
      prev10.status === 200 && prev10.body.exceptions?.pending === 1 && prev11.body.exceptions?.pending === 0,
      `10 Mar pending=${prev10.body.exceptions?.pending} / 11 Mar pending=${prev11.body.exceptions?.pending}`);
    const edge = await call("POST", `${O}/pay-periods/close`, adm.token, { dateFrom: "2026-03-11", dateTo: "2026-03-12", cadence: "custom" });
    check("F29 a period starting the next PR day can close (the 21:30 AST pending visit is not in it)", edge.status === 201, `${edge.status} ${edge.body.error ?? ""}`);

    // F30 Two agencies: A's admin sees only A's financial rows; B's admin only B's.
    const isoA = await asSession<{ n: number }>({ userId: adm.userId, orgId: orgA }, "SELECT count(*)::int n FROM timesheets WHERE organization_id <> $1", [orgA]);
    const isoBctx = await asSession<{ n: number }>({ userId: admB.userId, orgId: orgB }, "SELECT (SELECT count(*) FROM timesheets) + (SELECT count(*) FROM worker_financial_rates) + (SELECT count(*) FROM pay_periods) + (SELECT count(*) FROM finance_events WHERE organization_id <> $1) AS n", [orgB]);
    check("F30 agency isolation: A's admin sees no other agency's timesheets; B's admin sees none of A's financial rows",
      isoA.rows[0]?.n === 0 && Number(isoBctx.rows[0]?.n) === 0, `${isoA.rows[0]?.n ?? isoA.error} / ${isoBctx.rows[0]?.n ?? isoBctx.error}`);

    // F22 No 500 in the whole run.
    const fives = all.filter((r) => r.status === 500);
    check("F22 no 500 in the whole run", fives.length === 0, fives.map((r) => JSON.stringify(r.body)).join(" "));
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
    await runtime.end();
    await db.end();
  }

  console.log("\nETNARA Finanzas F0 — safe financial foundation\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nFinance foundation: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Finance foundation verification failed:", error);
  process.exit(1);
});
