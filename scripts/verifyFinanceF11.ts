/**
 * ETNARA Finanzas F1.1 (migration 121) — cancelling scheduled price changes,
 * deactivating holidays and the negative-margin flag, end to end over HTTP and
 * as app_runtime in PostgreSQL. Synthetic data only (.invalid e-mails).
 *
 * Covers: cancel rules (only before it takes effect, reason, admin only,
 * FINANZAS on), reopening exactly the version that had been closed (also in a
 * chain of scheduled versions), nothing forgeable in the database (admin and
 * owner), concurrency, the 121 backfill, holidays deactivated / reactivated and
 * never deleted, per-role and per-agency isolation, ETNARA central denied,
 * history with values and audit_log without amounts, the negative margin flag
 * (never a block), invalid dates answered with 400, and no 500 in the run.
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
const MONEY_KEY = /cents|amount|rate|margin/i;
const TABLES = ["finance_services", "finance_rates", "billing_clients", "billing_client_recipients", "finance_holidays", "recipient_finance_defaults", "shift_finance_terms"];

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
  const { resetFeatureWriteLimitForTests } = await import("../src/middleware/featureWriteLimit.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  const all: Array<{ status: number; body: Json }> = [];

  async function call(method: string, path: string, token: string, body?: Json) {
    resetFeatureWriteLimitForTests();
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
  async function asSession<T extends pg.QueryResultRow = pg.QueryResultRow>(
    ctx: { userId: string; orgId: string; superadmin?: boolean }, sqlText: string, params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number; error?: string }> {
    await runtime.query("BEGIN");
    try {
      await runtime.query("SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)",
        [ctx.userId, ctx.orgId, ctx.superadmin ? "true" : "false"]);
      const r = await runtime.query<T>(sqlText, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    } catch (e) {
      return { rows: [], rowCount: 0, error: e instanceof Error ? e.message : String(e) };
    } finally {
      await runtime.query("ROLLBACK");
    }
  }

  async function agency(name: string, finanzas: boolean) {
    const id = (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`${name} ${tag}`])).rows[0].id;
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'FIN') RETURNING id`, [id])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) SELECT $1,id,true,false FROM credential_types WHERE code='BLS'`, [rs]);
    if (finanzas) await q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'FINANZAS',true)`, [id]);
    return id;
  }
  type P = { email: string; userId: string; token: string; owm?: string; orgId: string };
  async function person(orgId: string, key: string, roles: string[], worker = false): Promise<P> {
    const email = `f11-${key}-${tag}@example.invalid`;
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

  const orgA = await agency("F11 A", true);
  const orgB = await agency("F11 B", true);
  const orgC = await agency("F11 C apagado", false);
  const adm = await person(orgA, "admin", ["ORGANIZATION_ADMIN"]);
  const sup = await person(orgA, "supervisor", ["SUPERVISOR"]);
  const cg = await person(orgA, "cg", ["WORKER"], true);
  const cg2 = await person(orgA, "cg2", ["WORKER"], true);
  const fam = await person(orgA, "family", ["FAMILY"]);
  const admB = await person(orgB, "adminb", ["ORGANIZATION_ADMIN"]);
  const admC = await person(orgC, "adminc", ["ORGANIZATION_ADMIN"]);
  const centralUser = (await q<{ id: string }>(`INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id`, [`f11-central-${tag}@example.invalid`])).rows[0].id;
  await q("INSERT INTO platform_admins (user_id) VALUES ($1)", [centralUser]);
  const central = { userId: centralUser, orgId: orgA, superadmin: true };
  const recipientA = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Maria',$2,'active') RETURNING id`, [orgA, `Rivera-${tag}`])).rows[0].id;
  const recipientC = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Ana',$2,'active') RETURNING id`, [orgC, `C-${tag}`])).rows[0].id;
  const today = (await q<{ d: string }>(`SELECT to_char((now() AT TIME ZONE 'America/Puerto_Rico')::date,'YYYY-MM-DD') d`)).rows[0].d;
  const day = (n: number) => { const [y, m, d] = today.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const F = `/organizations/${orgA}/finance`;

  const shiftForTomorrow = async (recipient: string, worker: P, hours: number) => {
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2, 14);
    const s = await call("POST", `/organizations/${orgA}/shifts`, adm.token, { careRecipientId: recipient, scheduledStart: new Date(start).toISOString(), scheduledEnd: new Date(start + hours * HOUR).toISOString() });
    const id = s.body.shift?.id as string;
    await call("POST", `/organizations/${orgA}/shifts/${id}/assignments`, adm.token, { organizationWorkerMembershipId: worker.owm });
    await call("POST", `/organizations/${orgA}/me/shifts/${id}/respond`, worker.token, { decision: "accepted" });
    return id;
  };
  const resolve = (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return call("GET", `${F}/rates/resolve?${qs}`, adm.token);
  };
  const rate = (serviceId: string, body: Json) => call("POST", `${F}/services/${serviceId}/rates`, adm.token, body);
  const cancel = (rateId: string, body: Json, token = adm.token, f = F) => call("POST", `${f}/rates/${rateId}/cancel`, token, body);
  const row = async (id: string) => (await q<Json>(`SELECT id, to_char(effective_from,'YYYY-MM-DD') f, to_char(effective_to,'YYYY-MM-DD') t,
      superseded_by_rate_id sb, to_char(superseded_previous_to,'YYYY-MM-DD') sp, cancelled_at, cancel_reason, ended_at FROM finance_rates WHERE id=$1`, [id])).rows[0];
  const amountOn = async (serviceId: string, date: string) => (await resolve({ serviceId, date })).body.billing?.amountCents ?? null;

  try {
    const svc = (await call("POST", `${F}/services`, adm.token, { name: "Cuido en el hogar", unit: "hour" })).body.service.id as string;
    const svc2 = (await call("POST", `${F}/services`, adm.token, { name: "Cuido hospitalario", unit: "hour" })).body.service.id as string;

    // C01 A in force from today; B (a typo: 250.00 instead of 25.00) scheduled for day+10.
    const A = (await rate(svc, { rateKind: "client", amountCents: 2500 })).body.rate?.id as string;
    const noReason = await rate(svc, { rateKind: "client", amountCents: 25000, effectiveFrom: day(10) });
    const Bres = await rate(svc, { rateKind: "client", amountCents: 25000, effectiveFrom: day(10), reason: "Ajuste anual" });
    const B = Bres.body.rate?.id as string;
    const a1 = await row(A);
    check("C01 scheduling day+10 closes the version in force at day+9 and records which version closed it (and its previous end)",
      noReason.status === 400 && Bres.status === 201 && a1.t === day(9) && a1.sb === B && a1.sp === null && (await amountOn(svc, day(10))) === 25000,
      `${noReason.status} ${Bres.status} A.to=${a1.t} sb=${a1.sb === B} sp=${a1.sp}`);

    // C02 Who may cancel: only the agency's admin, with a reason, FINANZAS on.
    const missing = await cancel(B, {});
    const short = await cancel(B, { reason: "x" });
    const bySup = await cancel(B, { reason: "Error de tecleo" }, sup.token);
    const byCg = await cancel(B, { reason: "Error de tecleo" }, cg.token);
    const byFam = await cancel(B, { reason: "Error de tecleo" }, fam.token);
    const byB = await cancel(B, { reason: "Error de tecleo" }, admB.token, `/organizations/${orgB}/finance`);
    const byBInA = await cancel(B, { reason: "Error de tecleo" }, admB.token);
    const centralDb = await asSession(central, "UPDATE finance_rates SET cancelled_at=now(), cancelled_by_user_id=$2, cancel_reason='Central' WHERE id=$1", [B, centralUser]);
    const supDb = await asSession({ userId: sup.userId, orgId: orgA }, "UPDATE finance_rates SET cancelled_at=now(), cancelled_by_user_id=$2, cancel_reason='Supervisor' WHERE id=$1", [B, sup.userId]);
    const stillLive = (await row(B)).cancelled_at === null;
    check("C02 cancel needs a reason (400) and the agency's admin: supervisor, caregiver, family 403; another agency 404; ETNARA central and supervisor change 0 rows in the database",
      missing.status === 400 && short.status === 400 && bySup.status === 403 && byCg.status === 403 && byFam.status === 403
        && byB.status === 404 && [403, 404].includes(byBInA.status) && (centralDb.error !== undefined || centralDb.rowCount === 0)
        && (supDb.error !== undefined || supDb.rowCount === 0) && stillLive,
      `${missing.status},${short.status},${bySup.status},${byCg.status},${byFam.status},${byB.status},${byBInA.status} central=${centralDb.error ?? centralDb.rowCount} sup=${supDb.error ?? supDb.rowCount}`);

    // C03 Cancelling B reopens A; B is kept (cancelled) and no longer counts anywhere.
    const ok = await cancel(B, { reason: "Error de tecleo: 250 en vez de 25" });
    const a2 = await row(A); const b2 = await row(B);
    const list = await call("GET", `${F}/services/${svc}/rates`, adm.token);
    const bListed = (list.body.rates ?? []).find((r: Json) => r.id === B);
    const services = (await call("GET", `${F}/services`, adm.token)).body.services ?? [];
    const sRow = services.find((s: Json) => s.id === svc);
    check("C03 cancel 200: A is in force again with no end, B is kept as «cancelled» with its reason, day+10 bills 2500, no «next change» is announced",
      ok.status === 200 && ok.body.reopened?.id === A && a2.t === null && a2.sb === null && a2.ended_at === null
        && b2.cancelled_at !== null && b2.cancel_reason === "Error de tecleo: 250 en vez de 25"
        && bListed?.status === "cancelled" && bListed?.cancel_reason === b2.cancel_reason
        && (await amountOn(svc, day(10))) === 2500 && sRow?.client_cents === 2500 && sRow?.next_change === null,
      `${ok.status} A.to=${a2.t} B=${bListed?.status} d10=${await amountOn(svc, day(10))} next=${sRow?.next_change}`);

    // C04 A cancelled version is final.
    const again = await cancel(B, { reason: "Otra vez" });
    const endCancelled = await call("POST", `${F}/rates/${B}/end`, adm.token, { effectiveTo: day(20), reason: "Fin" });
    const ownerTouch = await q("UPDATE finance_rates SET cancel_reason='cambiado' WHERE id=$1", [B]).then(() => "updated").catch((e: Error) => e.message);
    const ownerUncancel = await q("UPDATE finance_rates SET cancelled_at=NULL, cancelled_by_user_id=NULL, cancel_reason=NULL WHERE id=$1", [B]).then(() => "updated").catch((e: Error) => e.message);
    check("C04 a cancelled version cannot be cancelled again, ended or un-cancelled (409; owner refused too)",
      again.status === 409 && again.body.error === "FINANCE_RATE_CANCELLED" && endCancelled.status === 409
        && /FINANCE_RATE_CANCELLED/.test(ownerTouch) && /FINANCE_RATE_CANCELLED/.test(ownerUncancel),
      `${again.status} ${again.body.error} end=${endCancelled.status} | ${ownerTouch} | ${ownerUncancel}`);

    // C05 Nothing already in force (or past) can be cancelled.
    const inForce = await cancel(A, { reason: "Intento" });
    const ownerInForce = await q("UPDATE finance_rates SET cancelled_at=now(), cancelled_by_user_id=$2, cancel_reason='Dueño' WHERE id=$1", [A, adm.userId]).then(() => "updated").catch((e: Error) => e.message);
    const tomorrowRate = (await rate(svc2, { rateKind: "client", amountCents: 3000, effectiveFrom: day(1), reason: "Nuevo servicio" })).body.rate?.id as string;
    const tomorrowOk = await cancel(tomorrowRate, { reason: "Se pospone" });
    check("C05 a version in force since today is refused (409 FINANCE_RATE_ALREADY_IN_FORCE, owner refused too); one starting tomorrow can still be cancelled",
      inForce.status === 409 && inForce.body.error === "FINANCE_RATE_ALREADY_IN_FORCE" && /FINANCE_RATE_ALREADY_IN_FORCE/.test(ownerInForce)
        && tomorrowOk.status === 200 && tomorrowOk.body.reopened === null,
      `${inForce.status} ${inForce.body.error} | ${ownerInForce} | tomorrow=${tomorrowOk.status}`);

    // C06 The right price can then be scheduled on the same day the cancelled one had.
    const C = (await rate(svc, { rateKind: "client", amountCents: 2700, effectiveFrom: day(10), reason: "Ajuste anual corregido" }));
    const a3 = await row(A);
    check("C06 after cancelling, the corrected price can start on the same day (201); A again ends at day+9",
      C.status === 201 && a3.t === day(9) && a3.sb === C.body.rate?.id && (await amountOn(svc, day(10))) === 2700,
      `${C.status} ${C.body.error ?? ""} A.to=${a3.t} d10=${await amountOn(svc, day(10))}`);

    // C07 Chain: A (→ d9), C (d10 → d19), D (d20 →). Cancelling C reopens A only to day+19; D untouched.
    const D = (await rate(svc, { rateKind: "client", amountCents: 2900, effectiveFrom: day(20), reason: "Segundo ajuste" })).body.rate?.id as string;
    const cId = C.body.rate?.id as string;
    const c1 = await row(cId);
    const cc = await cancel(cId, { reason: "El primer ajuste no procede" });
    const a4 = await row(A); const d4 = await row(D);
    const prices = [await amountOn(svc, day(9)), await amountOn(svc, day(15)), await amountOn(svc, day(19)), await amountOn(svc, day(20)), await amountOn(svc, day(60))];
    check("C07 chain: cancelling the middle version reopens A up to the day before the next one (day+19); the later version stays as it was",
      c1.t === day(19) && cc.status === 200 && a4.t === day(19) && d4.f === day(20) && d4.t === null && d4.cancelled_at === null
        && prices.join(",") === "2500,2500,2500,2900,2900",
      `C.to=${c1.t} ${cc.status} A.to=${a4.t} D=${d4.f}..${d4.t} prices=${prices.join(",")}`);

    // C08 Nothing can be forged directly in the database (admin session and owner).
    const extend = await asSession({ userId: adm.userId, orgId: orgA }, "UPDATE finance_rates SET effective_to=NULL WHERE id=$1", [A]);
    const forgeSb = await asSession({ userId: adm.userId, orgId: orgA }, "UPDATE finance_rates SET superseded_by_rate_id=$2, superseded_previous_to=NULL WHERE id=$1", [A, D]);
    const ownerExtend = await q("UPDATE finance_rates SET effective_to=NULL, ended_at=NULL, ended_by_user_id=NULL, end_reason=NULL WHERE id=$1", [A]).then(() => "updated").catch((e: Error) => e.message);
    const insCancelled = await asSession({ userId: adm.userId, orgId: orgA },
      "INSERT INTO finance_rates (organization_id,service_id,rate_kind,scope,amount_cents,effective_from,created_by_user_id,cancelled_at,cancelled_by_user_id,cancel_reason) VALUES ($1,$2,'caregiver','general',100,$3::date,$4,now(),$4,'forjado')",
      [orgA, svc, day(40), adm.userId]);
    const otherActor = await asSession({ userId: adm.userId, orgId: orgA }, "UPDATE finance_rates SET cancelled_at=now(), cancelled_by_user_id=$2, cancel_reason='Otro' WHERE id=$1", [D, sup.userId]);
    const del = await q("DELETE FROM finance_rates WHERE id=$1", [cId]).then(() => "deleted").catch((e: Error) => e.message);
    check("C08 database refuses: extending a window, forging «closed by», inserting a cancelled row, cancelling in someone else's name, deleting (admin session and owner)",
      /END_ONLY_EARLIER/.test(extend.error ?? "") && /IMMUTABLE/.test(forgeSb.error ?? "") && /END_ONLY_EARLIER/.test(ownerExtend)
        && /IMMUTABLE/.test(insCancelled.error ?? "") && /IMMUTABLE/.test(otherActor.error ?? "") && /IMMUTABLE/.test(del),
      [extend.error, forgeSb.error, ownerExtend, insCancelled.error, otherActor.error, del].map((e) => (e ?? "OK").slice(0, 40)).join(" | "));

    // C09 Concurrency: 6 cancels of the same version at once → exactly one wins; cancel racing a new version keeps 0 overlaps.
    const E = (await rate(svc2, { rateKind: "caregiver", amountCents: 1800, effectiveFrom: day(5), reason: "Programado" })).body.rate?.id as string;
    const burst = await Promise.all(Array.from({ length: 6 }, () => cancel(E, { reason: "Cancelación simultánea" })));
    const wins = burst.filter((r) => r.status === 200).length;
    const G0 = (await rate(svc2, { rateKind: "client", amountCents: 3100, effectiveFrom: day(12), reason: "Programado" })).body.rate?.id as string;
    const race = await Promise.all([cancel(G0, { reason: "Carrera" }), rate(svc2, { rateKind: "client", amountCents: 3300, effectiveFrom: day(20), reason: "Carrera" })]);
    const overlaps = (await q<{ n: number }>(`SELECT count(*)::int n FROM finance_rates a JOIN finance_rates b ON a.id < b.id
        AND a.organization_id=b.organization_id AND a.service_id=b.service_id AND a.rate_kind=b.rate_kind AND a.scope=b.scope AND a.day_type=b.day_type
        AND a.billing_client_id IS NOT DISTINCT FROM b.billing_client_id AND a.organization_worker_membership_id IS NOT DISTINCT FROM b.organization_worker_membership_id
        AND a.cancelled_at IS NULL AND b.cancelled_at IS NULL
        AND daterange(a.effective_from,a.effective_to,'[]') && daterange(b.effective_from,b.effective_to,'[]')
      WHERE a.organization_id=$1`, [orgA])).rows[0].n;
    check("C09 six simultaneous cancels: one 200, five 409; a cancel racing a new scheduled version ends with 0 overlapping live versions",
      wins === 1 && burst.filter((r) => r.status === 409).length === 5 && race.every((r) => [200, 201, 409].includes(r.status)) && overlaps === 0,
      `${burst.map((r) => r.status).join(",")} race=${race.map((r) => r.status).join(",")} overlaps=${overlaps}`);

    // C09b Same line, opposite operations at the same instant, 8 rounds each: no deadlock surfaces as a 500
    // (cancel/end take the service lock first, like createRate) and the line never ends up overlapping.
    const statuses: number[] = [];
    const raceClient = (await call("POST", `${F}/clients`, adm.token, { fullName: "Cliente carrera" })).body.client.id as string;
    for (let i = 0; i < 8; i++) {
      const s = (await call("POST", `${F}/services`, adm.token, { name: `Carrera ${i}`, unit: "hour" })).body.service.id as string;
      await rate(s, { rateKind: "client", amountCents: 2000 });
      const fut = (await rate(s, { rateKind: "client", amountCents: 2100, effectiveFrom: day(12), reason: "Programado" })).body.rate?.id as string;
      const special = (await rate(s, { rateKind: "client", scope: "client", billingClientId: raceClient, amountCents: 1900 })).body.rate?.id as string;
      const r = await Promise.all([
        cancel(fut, { reason: "Carrera" }),
        rate(s, { rateKind: "client", amountCents: 2200, effectiveFrom: day(20), reason: "Carrera" }),
        call("POST", `${F}/rates/${special}/end`, adm.token, { effectiveTo: day(30), reason: "Carrera" }),
        rate(s, { rateKind: "client", scope: "client", billingClientId: raceClient, amountCents: 1950, effectiveFrom: day(25), reason: "Carrera" }),
      ]);
      statuses.push(...r.map((x) => x.status));
    }
    const overlaps2 = (await q<{ n: number }>(`SELECT count(*)::int n FROM finance_rates a JOIN finance_rates b ON a.id < b.id
        AND a.organization_id=b.organization_id AND a.service_id=b.service_id AND a.rate_kind=b.rate_kind AND a.scope=b.scope AND a.day_type=b.day_type
        AND a.billing_client_id IS NOT DISTINCT FROM b.billing_client_id AND a.organization_worker_membership_id IS NOT DISTINCT FROM b.organization_worker_membership_id
        AND a.cancelled_at IS NULL AND b.cancelled_at IS NULL
        AND daterange(a.effective_from,a.effective_to,'[]') && daterange(b.effective_from,b.effective_to,'[]')
      WHERE a.organization_id=$1`, [orgA])).rows[0].n;
    check("C09b 8 rounds of cancel vs new version and end vs new version on the same line at the same instant: never a 500, 0 overlaps",
      statuses.every((s) => [200, 201, 409].includes(s)) && overlaps2 === 0,
      `statuses=${[...new Set(statuses)].join("/")} 500s=${statuses.filter((s) => s === 500).length} overlaps=${overlaps2}`);

    // C10 History and audit.
    const ev = await asSession<{ action: string; has: boolean }>({ userId: adm.userId, orgId: orgA },
      "SELECT action, (new_value ? 'amount_cents') AS has FROM finance_events WHERE action IN ('FINANCE_RATE_CANCELLED','FINANCE_RATE_REOPENED') ORDER BY occurred_at");
    const audit = await q<{ previous_value: Json | null; new_value: Json | null }>("SELECT previous_value, new_value FROM audit_log WHERE organization_id=$1 AND action IN ('FINANCE_RATE_CANCELLED','FINANCE_RATE_REOPENED','FINANCE_HOLIDAY_DEACTIVATED')", [orgA]);
    const supAudit = await asSession<{ n: number }>({ userId: sup.userId, orgId: orgA }, "SELECT count(*)::int n FROM audit_log WHERE action LIKE 'FINANCE_RATE_C%'");
    const histList = (await call("GET", `${F}/services/${svc}/rates`, adm.token)).body.history ?? [];
    check("C10 finance_events keeps the values of every cancel and reopen; audit_log only identifiers (hidden from the supervisor); the service history shows them",
      ev.rows.filter((r) => r.action === "FINANCE_RATE_CANCELLED").length >= 4 && ev.rows.filter((r) => r.action === "FINANCE_RATE_REOPENED").length >= 2 && ev.rows.every((r) => r.has)
        && audit.rows.length >= 6 && audit.rows.every((r) => ![r.previous_value, r.new_value].some((v) => v && MONEY_KEY.test(JSON.stringify(v))))
        && supAudit.rows[0]?.n === 0 && histList.some((h: Json) => h.action === "FINANCE_RATE_CANCELLED"),
      `events=${ev.rows.length} audit=${audit.rows.length} sup=${supAudit.rows[0]?.n}`);

    // C11 FINANZAS switched off: no cancel through the API nor the database.
    const bSvc = (await call("POST", `/organizations/${orgB}/finance/services`, admB.token, { name: "Servicio B", unit: "hour" })).body.service.id as string;
    const bFuture = (await call("POST", `/organizations/${orgB}/finance/services/${bSvc}/rates`, admB.token, { rateKind: "client", amountCents: 2000, effectiveFrom: day(8), reason: "Programado" })).body.rate?.id as string;
    await q("UPDATE organization_features SET enabled=false WHERE organization_id=$1 AND feature_code='FINANZAS'", [orgB]);
    const offApi = await cancel(bFuture, { reason: "Apagado" }, admB.token, `/organizations/${orgB}/finance`);
    const offDb = await asSession({ userId: admB.userId, orgId: orgB }, "UPDATE finance_rates SET cancelled_at=now(), cancelled_by_user_id=$2, cancel_reason='Apagado' WHERE id=$1", [bFuture, admB.userId]);
    await q("UPDATE organization_features SET enabled=true WHERE organization_id=$1 AND feature_code='FINANZAS'", [orgB]);
    check("C11 with FINANZAS off the cancel route is 404 FEATURE_NOT_ENABLED and the database refuses the change",
      offApi.status === 404 && offApi.body.error === "FEATURE_NOT_ENABLED" && Boolean(offDb.error) && (await row(bFuture)).cancelled_at === null,
      `${offApi.status} ${offApi.body.error} db=${offDb.error ?? offDb.rowCount}`);

    // C12 The 121 backfill links versions closed before 121 exactly (same transaction ⇒ same timestamp).
    const m121 = (await import("node:fs")).readFileSync(new URL("../migrations/121_finance_rate_cancel_holiday_deactivate.sql", import.meta.url), "utf8");
    const backfill = m121.slice(m121.indexOf("ALTER TABLE finance_rates DISABLE TRIGGER"), m121.indexOf("ALTER TABLE finance_rates ENABLE TRIGGER"));
    const svc3 = (await call("POST", `${F}/services`, adm.token, { name: "Respiro", unit: "hour" })).body.service.id as string;
    await q("BEGIN");
    let bf: Json = {};
    try {
      // Same order as the migration: the self-reference is checked at once so no deferred event blocks the trigger switch.
      await q("SET CONSTRAINTS finance_rates_superseded_by_fk IMMEDIATE");
      await q("ALTER TABLE finance_rates DISABLE TRIGGER finance_rates_guard");
      const t0 = "2026-01-05 10:00:00+00";
      const oldId = (await q<{ id: string }>(`INSERT INTO finance_rates (organization_id,service_id,rate_kind,scope,amount_cents,effective_from,effective_to,created_by_user_id,created_at,ended_at,ended_by_user_id,end_reason)
        VALUES ($1,$2,'client','general',2000,'2026-01-01','2026-02-28',$3,'2026-01-01 10:00+00',$4,$3,'Nueva tarifa') RETURNING id`, [orgA, svc3, adm.userId, t0])).rows[0].id;
      const newId = (await q<{ id: string }>(`INSERT INTO finance_rates (organization_id,service_id,rate_kind,scope,amount_cents,effective_from,created_by_user_id,created_at,reason)
        VALUES ($1,$2,'client','general',2100,'2026-03-01',$3,$4,'Programado') RETURNING id`, [orgA, svc3, adm.userId, t0])).rows[0].id;
      const unrelated = (await q<{ id: string }>(`INSERT INTO finance_rates (organization_id,service_id,rate_kind,scope,amount_cents,effective_from,effective_to,created_by_user_id,created_at,ended_at,ended_by_user_id,end_reason)
        VALUES ($1,$2,'caregiver','general',1200,'2026-01-01','2026-02-28',$3,'2026-01-01 10:00+00','2026-01-09 10:00+00',$3,'Fin') RETURNING id`, [orgA, svc3, adm.userId])).rows[0].id;
      await q(`INSERT INTO finance_rates (organization_id,service_id,rate_kind,scope,amount_cents,effective_from,created_by_user_id,created_at)
        VALUES ($1,$2,'caregiver','general',1300,'2026-03-01',$3,'2026-01-10 10:00+00')`, [orgA, svc3, adm.userId]);
      // Run the migration's backfill exactly as written (it disables the guard), then re-enable it.
      await q(backfill);
      await q("ALTER TABLE finance_rates ENABLE TRIGGER finance_rates_guard");
      const o = await row(oldId); const un = await row(unrelated);
      bf = { linked: o.sb === newId, sp: o.sp, unrelated: un.sb };
    } finally { await q("ROLLBACK"); }
    check("C12 121 backfill: a version closed by a newer one in the same transaction is linked to it; a version ended separately is not",
      bf.linked === true && bf.sp === null && bf.unrelated === null, JSON.stringify(bf));

    // H01–H06 Holidays.
    const hDate = day(30);
    await rate(svc, { rateKind: "client", dayType: "holiday", amountCents: 3750, effectiveFrom: today, reason: "Feriado general" });
    const added = await call("POST", `${F}/holidays`, adm.token, { date: hDate, name: "Feriado puesto por error" });
    const onHoliday = await resolve({ serviceId: svc, date: hDate });
    check("H01 a holiday makes that day use the holiday rate (3750)", added.status === 201 && onHoliday.body.holiday === "Feriado puesto por error" && onHoliday.body.billing?.amountCents === 3750,
      `${added.status} ${onHoliday.body.holiday} ${onHoliday.body.billing?.amountCents}`);

    const hNoReason = await call("POST", `${F}/holidays/${hDate}/deactivate`, adm.token, {});
    const hSup = await call("POST", `${F}/holidays/${hDate}/deactivate`, sup.token, { reason: "Error" });
    const hOther = await call("POST", `/organizations/${orgB}/finance/holidays/${hDate}/deactivate`, admB.token, { reason: "Error" });
    const hBadDate = await call("POST", `${F}/holidays/2026-13-45/deactivate`, adm.token, { reason: "Error" });
    const hBadFormat = await call("POST", `${F}/holidays/navidad/deactivate`, adm.token, { reason: "Error" });
    const hMissing = await call("POST", `${F}/holidays/${day(31)}/deactivate`, adm.token, { reason: "Error" });
    const hBadAdd = await call("POST", `${F}/holidays`, adm.token, { date: "2026-02-30", name: "Imposible" });
    check("H02 deactivate needs a reason (400) and the admin (supervisor 403); another agency 404; impossible or malformed dates 400 (never 500); unknown date 404",
      hNoReason.status === 400 && hSup.status === 403 && hOther.status === 404 && hBadDate.status === 400 && hBadFormat.status === 400
        && hMissing.status === 404 && hMissing.body.error === "FINANCE_HOLIDAY_NOT_FOUND" && hBadAdd.status === 400,
      `${hNoReason.status},${hSup.status},${hOther.status},${hBadDate.status},${hBadFormat.status},${hMissing.status},${hBadAdd.status}`);

    const hOk = await call("POST", `${F}/holidays/${hDate}/deactivate`, adm.token, { reason: "La agencia no cierra ese día" });
    const afterOff = await resolve({ serviceId: svc, date: hDate });
    const hList = (await call("GET", `${F}/holidays`, adm.token)).body.holidays ?? [];
    const hRow = hList.find((h: Json) => h.date === hDate);
    const stored = (await q<{ n: number }>("SELECT count(*)::int n FROM finance_holidays WHERE organization_id=$1 AND holiday_date=$2", [orgA, hDate])).rows[0].n;
    check("H03 deactivated (200): that day uses the normal rate in force then again (2900 from day+20, no holiday); the row stays, listed as inactive with its reason and who did it",
      hOk.status === 200 && afterOff.body.holiday === null && afterOff.body.billing?.amountCents === 2900 && stored === 1
        && hRow?.active === false && hRow?.deactivation_reason === "La agencia no cierra ese día" && hRow?.deactivated_by_email === adm.email,
      `${hOk.status} holiday=${afterOff.body.holiday} ${afterOff.body.billing?.amountCents} stored=${stored} ${JSON.stringify(hRow)}`);

    const hAgain = await call("POST", `${F}/holidays/${hDate}/deactivate`, adm.token, { reason: "Otra vez" });
    const hDelAdmin = await asSession({ userId: adm.userId, orgId: orgA }, "DELETE FROM finance_holidays WHERE organization_id=$1 AND holiday_date=$2", [orgA, hDate]);
    const hDelOwner = await q("DELETE FROM finance_holidays WHERE organization_id=$1 AND holiday_date=$2", [orgA, hDate]).then(() => "deleted").catch((e: Error) => e.message);
    const hMove = await q("UPDATE finance_holidays SET holiday_date=holiday_date+1 WHERE organization_id=$1 AND holiday_date=$2", [orgA, hDate]).then(() => "updated").catch((e: Error) => e.message);
    const hNoOp = await asSession({ userId: adm.userId, orgId: orgA }, "UPDATE finance_holidays SET name='Otro nombre' WHERE organization_id=$1 AND holiday_date=$2", [orgA, hDate]);
    check("H04 never deleted nor moved: deactivating twice 409; DELETE refused for the admin session and the owner; date change and silent renames refused",
      hAgain.status === 409 && (hDelAdmin.error !== undefined || hDelAdmin.rowCount === 0) && /FINANCE_HOLIDAY_NO_DELETE/.test(hDelOwner)
        && /FINANCE_HOLIDAY_IMMUTABLE/.test(hMove) && /FINANCE_HOLIDAY_IMMUTABLE/.test(hNoOp.error ?? ""),
      `${hAgain.status} admin=${hDelAdmin.error ?? hDelAdmin.rowCount} | ${hDelOwner} | ${hMove} | ${hNoOp.error}`);

    const hBack = await call("POST", `${F}/holidays`, adm.token, { date: hDate, name: "Día de la agencia" });
    const onAgain = await resolve({ serviceId: svc, date: hDate });
    const dupActive = await call("POST", `${F}/holidays`, adm.token, { date: hDate, name: "Duplicado" });
    const hEvents = await asSession<{ action: string }>({ userId: adm.userId, orgId: orgA },
      "SELECT action FROM finance_events WHERE action LIKE 'FINANCE_HOLIDAY_%' ORDER BY occurred_at");
    check("H05 adding the date again reactivates it with the new name (201); an active date cannot be added twice (409); history ADDED → DEACTIVATED → REACTIVATED",
      hBack.status === 201 && hBack.body.holiday?.active === true && onAgain.body.holiday === "Día de la agencia" && onAgain.body.billing?.amountCents === 3750
        && dupActive.status === 409 && hEvents.rows.map((r) => r.action).join(",") === "FINANCE_HOLIDAY_ADDED,FINANCE_HOLIDAY_DEACTIVATED,FINANCE_HOLIDAY_REACTIVATED",
      `${hBack.status} ${onAgain.body.holiday} dup=${dupActive.status} ${hEvents.rows.map((r) => r.action).join(",")}`);

    const centralRead = await asSession<{ n: number }>(central, "SELECT count(*)::int n FROM finance_holidays");
    const centralUpd = await asSession(central, "UPDATE finance_holidays SET active=false, deactivated_by_user_id=$1, deactivation_reason='Central' WHERE true", [centralUser]);
    const cgRead = await asSession<{ n: number }>({ userId: cg.userId, orgId: orgA }, "SELECT count(*)::int n FROM finance_holidays");
    const famRead = await asSession<{ n: number }>({ userId: fam.userId, orgId: orgA }, "SELECT count(*)::int n FROM finance_holidays");
    check("H06 ETNARA central, caregiver and family: 0 holiday rows and no changes",
      centralRead.rows[0]?.n === 0 && (centralUpd.error !== undefined || centralUpd.rowCount === 0) && cgRead.rows[0]?.n === 0 && famRead.rows[0]?.n === 0,
      `central=${centralRead.rows[0]?.n}/${centralUpd.error ?? centralUpd.rowCount} cg=${cgRead.rows[0]?.n} fam=${famRead.rows[0]?.n}`);

    // M01–M02 Negative gross margin is flagged, never blocked.
    const svc4 = (await call("POST", `${F}/services`, adm.token, { name: "Cuido especializado", unit: "hour" })).body.service.id as string;
    await rate(svc4, { rateKind: "client", amountCents: 3000 });
    const neg = await rate(svc4, { rateKind: "caregiver", amountCents: 3200 });
    await rate(svc, { rateKind: "caregiver", amountCents: 1500 });
    const mRes = await resolve({ serviceId: svc4, date: day(3), minutes: 120 });
    const pos = await resolve({ serviceId: svc, date: day(3), minutes: 120, membershipId: cg.owm });
    const list3 = (await call("GET", `${F}/services`, adm.token)).body.services ?? [];
    const s2 = list3.find((s: Json) => s.id === svc4);
    check("M01 billing 3000 < pay 3200 is saved (201, not blocked) and flagged: unit margin −200 (negative), 2 h estimate −400, service list flagged; positive margins are not flagged",
      neg.status === 201 && mRes.body.unitMargin?.differenceCents === -200 && mRes.body.unitMargin?.negative === true
        && mRes.body.estimate?.margin?.differenceCents === -400 && mRes.body.estimate?.margin?.negative === true
        && s2?.margin?.negative === true && pos.body.unitMargin?.negative === false,
      `${neg.status} unit=${JSON.stringify(mRes.body.unitMargin)} est=${mRes.body.estimate?.margin?.differenceCents} list=${s2?.margin?.negative} pos=${pos.body.unitMargin?.negative}`);

    const recipient = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Rosa',$2,'active') RETURNING id`, [orgA, `M-${tag}`])).rows[0].id;
    const shiftId = await shiftForTomorrow(recipient, cg, 2);
    const setTerms = await call("PUT", `/organizations/${orgA}/shifts/${shiftId}/finance`, adm.token, { serviceId: svc4 });
    check("M02 the shift finance panel carries the same flag (2 h: −400, negative)",
      setTerms.status === 200 && setTerms.body.resolution?.estimate?.margin?.negative === true && setTerms.body.resolution?.estimate?.margin?.differenceCents === -400,
      `${setTerms.status} ${JSON.stringify(setTerms.body.resolution?.estimate?.margin)}`);

    const fives = all.filter((r) => r.status === 500);
    check("C13 no 500 in the whole run", fives.length === 0, fives.map((r) => JSON.stringify(r.body)).join(" "));
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
    await runtime.end();
    await db.end();
  }

  console.log("\nETNARA Finanzas F1.1 — cancel scheduled rates, holidays, negative margin\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nFinance F1.1: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Finance F1.1 verification failed:", error);
  process.exit(1);
});
