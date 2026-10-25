/**
 * ETNARA Finanzas F1 — services and differentiated rates, end to end over HTTP
 * and as app_runtime in PostgreSQL. Synthetic data only (.invalid e-mails).
 *
 * Covers: the FINANZAS switch, catalogue, billing vs pay rates, client and
 * caregiver exceptions and their priority, effective dates and history,
 * overlap prevention (also under concurrency), immutability, holidays,
 * calculations per unit, shift finance terms (locked after approval), shifts
 * and legacy rates untouched, per-role and per-agency isolation, ETNARA central
 * denied and no amounts in audit_log.
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
    const email = `f1-${key}-${tag}@example.invalid`;
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

  const orgA = await agency("F1 A", true);
  const orgB = await agency("F1 B", true);
  const orgC = await agency("F1 C apagado", false);
  const adm = await person(orgA, "admin", ["ORGANIZATION_ADMIN"]);
  const sup = await person(orgA, "supervisor", ["SUPERVISOR"]);
  const cg = await person(orgA, "cg", ["WORKER"], true);
  const cg2 = await person(orgA, "cg2", ["WORKER"], true);
  const fam = await person(orgA, "family", ["FAMILY"]);
  const admB = await person(orgB, "adminb", ["ORGANIZATION_ADMIN"]);
  const admC = await person(orgC, "adminc", ["ORGANIZATION_ADMIN"]);
  const centralUser = (await q<{ id: string }>(`INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id`, [`f1-central-${tag}@example.invalid`])).rows[0].id;
  await q("INSERT INTO platform_admins (user_id) VALUES ($1)", [centralUser]);
  const central = { userId: centralUser, orgId: orgA, superadmin: true };
  const recipientA = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Maria',$2,'active') RETURNING id`, [orgA, `Rivera-${tag}`])).rows[0].id;
  const recipientC = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Ana',$2,'active') RETURNING id`, [orgC, `C-${tag}`])).rows[0].id;
  const today = (await q<{ d: string }>(`SELECT to_char((now() AT TIME ZONE 'America/Puerto_Rico')::date,'YYYY-MM-DD') d`)).rows[0].d;
  const day = (n: number) => { const [y, m, d] = today.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const F = `/organizations/${orgA}/finance`;
  const legacyBefore = JSON.stringify((await q("SELECT * FROM worker_financial_rates ORDER BY organization_worker_membership_id")).rows);
  const shiftColumnsBefore = (await q<{ c: string }>("SELECT string_agg(column_name, ',' ORDER BY column_name) c FROM information_schema.columns WHERE table_name='shifts'")).rows[0].c;

  let dayOffset = 3;
  async function shiftFor(org: string, admin: P, recipient: string, worker?: P, hours = 3) {
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset++, 14);
    const s = await call("POST", `/organizations/${org}/shifts`, admin.token, { careRecipientId: recipient, scheduledStart: new Date(start).toISOString(), scheduledEnd: new Date(start + hours * HOUR).toISOString() });
    if (s.status !== 201) throw new Error(`shift ${s.status} ${JSON.stringify(s.body)}`);
    const id = s.body.shift.id as string;
    if (worker) {
      const a = await call("POST", `/organizations/${org}/shifts/${id}/assignments`, admin.token, { organizationWorkerMembershipId: worker.owm });
      if (a.status !== 201) throw new Error(`assign ${a.status} ${JSON.stringify(a.body)}`);
      const r = await call("POST", `/organizations/${org}/me/shifts/${id}/respond`, worker.token, { decision: "accepted" });
      if (r.status !== 200) throw new Error(`respond ${r.status} ${JSON.stringify(r.body)}`);
    }
    return { id, response: s.body.shift as Json };
  }
  const resolve = (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return call("GET", `${F}/rates/resolve?${qs}`, adm.token);
  };
  const rate = (serviceId: string, body: Json) => call("POST", `${F}/services/${serviceId}/rates`, adm.token, body);

  try {
    // S01 Switch off: routes 404 and the database refuses rows.
    const off = await call("GET", `/organizations/${orgC}/finance/services`, admC.token);
    const offDb = await asSession({ userId: admC.userId, orgId: orgC }, "INSERT INTO finance_services (organization_id,name,unit,created_by_user_id,updated_by_user_id) VALUES ($1,'X','hour',$2,$2)", [orgC, admC.userId]);
    check("S01 FINANZAS off: 404 FEATURE_NOT_ENABLED and the database refuses new rows", off.status === 404 && off.body.error === "FEATURE_NOT_ENABLED" && Boolean(offDb.error), `${off.status} ${off.body.error} | ${offDb.error ?? "INSERTED"}`);

    // S02 Catalogue: the agency creates its own services; no default rates.
    const mk = async (name: string, unit: string) => (await call("POST", `${F}/services`, adm.token, { name, unit, description: `${name} (prueba)` }));
    const home = await mk("Cuido en el hogar", "hour");
    const hospital = await mk("Cuido hospitalario", "hour");
    const escort = await mk("Acompañamiento a citas médicas", "hour");
    const full = await mk("Cuido 24 horas", "day");
    const transport = await mk("Transporte a citas", "fixed");
    const dup = await mk("cuido en el HOGAR", "hour");
    const ids = { home: home.body.service?.id, hospital: hospital.body.service?.id, escort: escort.body.service?.id, full: full.body.service?.id, transport: transport.body.service?.id };
    const listed = await call("GET", `${F}/services`, adm.token);
    check("S02 admin creates services (201); duplicate name 409; no rate is created by default",
      [home, hospital, escort, full, transport].every((r) => r.status === 201) && dup.status === 409
        && (listed.body.services ?? []).every((s: Json) => s.client_cents === null && s.caregiver_cents === null),
      `${[home, hospital, escort, full, transport].map((r) => r.status).join(",")} dup=${dup.status}`);

    // S03 Unit immutable, no delete.
    const unitDb = await asSession({ userId: adm.userId, orgId: orgA }, "UPDATE finance_services SET unit='day' WHERE id=$1", [ids.home]);
    const delDb = await asSession({ userId: adm.userId, orgId: orgA }, "DELETE FROM finance_services WHERE id=$1", [ids.home]);
    const delOwner = await q("DELETE FROM finance_services WHERE id=$1", [ids.home]).then(() => "deleted").catch((e: Error) => e.message);
    check("S03 a service keeps its unit and is never deleted (admin and owner refused)", Boolean(unitDb.error) && Boolean(delDb.error) && delOwner !== "deleted", `${unitDb.error} | ${delDb.error} | ${delOwner}`);

    // S04 Two independent rates per service.
    const general: Array<[string, number, number]> = [[ids.home, 2500, 1500], [ids.hospital, 3000, 1800], [ids.escort, 2800, 1700]];
    const created: number[] = [];
    for (const [sid, bill, pay] of general) {
      created.push((await rate(sid, { rateKind: "client", amountCents: bill })).status, (await rate(sid, { rateKind: "caregiver", amountCents: pay })).status);
    }
    created.push((await rate(ids.full, { rateKind: "client", amountCents: 30000, halfDayPolicy: "proportional" })).status);
    created.push((await rate(ids.full, { rateKind: "caregiver", amountCents: 19000, halfDayPolicy: "review" })).status);
    created.push((await rate(ids.transport, { rateKind: "client", amountCents: 6000 })).status);
    check("S04 billing and pay rates saved for every service (201)", created.every((s) => s === 201), created.join(","));

    // S05 Each service resolves its own pair.
    const r5 = await Promise.all([ids.home, ids.hospital, ids.escort].map((serviceId) => resolve({ serviceId, membershipId: cg.owm })));
    const pairs = r5.map((r) => `${r.body.billing?.amountCents}/${r.body.pay?.amountCents}`);
    check("S05 home 2500/1500, hospital 3000/1800, escort 2800/1700 (billing/pay, general)",
      pairs.join(" ") === "2500/1500 3000/1800 2800/1700" && r5.every((r) => r.body.billing?.source === "general" && r.body.pay?.source === "general"), pairs.join(" "));

    // S06 Client special price; the general one is untouched.
    const clientX = (await call("POST", `${F}/clients`, adm.token, { fullName: "Familia Rivera", email: "rivera@example.invalid" })).body.client;
    const clientY = (await call("POST", `${F}/clients`, adm.token, { fullName: "Familia Torres" })).body.client;
    const special = await rate(ids.home, { rateKind: "client", scope: "client", billingClientId: clientX.id, amountCents: 2200 });
    const rx = await resolve({ serviceId: ids.home, billingClientId: clientX.id, membershipId: cg.owm });
    const ry = await resolve({ serviceId: ids.home, billingClientId: clientY.id, membershipId: cg.owm });
    check("S06 client X pays 2200 (source client); client Y the general 2500; pay unchanged 1500",
      special.status === 201 && rx.body.billing?.amountCents === 2200 && rx.body.billing?.source === "client" && ry.body.billing?.amountCents === 2500 && rx.body.pay?.amountCents === 1500,
      `${special.status} X=${rx.body.billing?.amountCents}/${rx.body.billing?.source} Y=${ry.body.billing?.amountCents} pay=${rx.body.pay?.amountCents}`);

    // S07 Caregiver exception; billing unaffected.
    const exc = await rate(ids.home, { rateKind: "caregiver", scope: "caregiver", membershipId: cg2.owm, amountCents: 1700 });
    const rcg2 = await resolve({ serviceId: ids.home, billingClientId: clientX.id, membershipId: cg2.owm });
    const rcg = await resolve({ serviceId: ids.home, billingClientId: clientX.id, membershipId: cg.owm });
    check("S07 caregiver 2 is paid 1700 (exception), caregiver 1 the general 1500; billing stays 2200 for both",
      exc.status === 201 && rcg2.body.pay?.amountCents === 1700 && rcg2.body.pay?.source === "caregiver" && rcg.body.pay?.amountCents === 1500
        && rcg2.body.billing?.amountCents === 2200 && rcg.body.billing?.amountCents === 2200,
      `cg2=${rcg2.body.pay?.amountCents}/${rcg2.body.pay?.source} cg=${rcg.body.pay?.amountCents} bill=${rcg2.body.billing?.amountCents}`);

    // S08 Billing never reads pay rates and vice versa.
    const tr = await resolve({ serviceId: ids.transport, minutes: 90 });
    check("S08 a service with only a billing rate has no pay rate (NO_PAY_RATE), and never borrows one",
      tr.body.billing?.amountCents === 6000 && tr.body.pay === null && (tr.body.exceptions ?? []).includes("NO_PAY_RATE"), JSON.stringify(tr.body.exceptions));

    // S09 Future price: the old one applies until the day before.
    const noReason = await rate(ids.home, { rateKind: "client", amountCents: 2700, effectiveFrom: day(10) });
    const fut = await rate(ids.home, { rateKind: "client", amountCents: 2700, effectiveFrom: day(10), reason: "Ajuste anual" });
    const at9 = await resolve({ serviceId: ids.home, date: day(9) });
    const at10 = await resolve({ serviceId: ids.home, date: day(10) });
    const now0 = await resolve({ serviceId: ids.home });
    check("S09 price change on a future date: reason required (400); today and day+9 keep 2500, day+10 uses 2700",
      noReason.status === 400 && fut.status === 201 && fut.body.closedPrevious?.effective_to === day(9)
        && now0.body.billing?.amountCents === 2500 && at9.body.billing?.amountCents === 2500 && at10.body.billing?.amountCents === 2700,
      `${noReason.status}/${fut.status} closed=${fut.body.closedPrevious?.effective_to} today=${now0.body.billing?.amountCents} d9=${at9.body.billing?.amountCents} d10=${at10.body.billing?.amountCents}`);

    // S10 The past is never rewritten.
    // A negotiated price for client Y on hospital care in force since 20 days ago...
    const since20 = await rate(ids.hospital, { rateKind: "client", scope: "client", billingClientId: clientY.id, amountCents: 2900, effectiveFrom: day(-20), reason: "Acuerdo firmado hace 20 días" });
    // ...cannot be replaced 5 days ago: that would rewrite what was already provided.
    const past = await rate(ids.hospital, { rateKind: "client", scope: "client", billingClientId: clientY.id, amountCents: 9999, effectiveFrom: day(-5), reason: "Intento retroactivo" });
    const stillPast = await resolve({ serviceId: ids.hospital, billingClientId: clientY.id, date: day(-5) });
    check("S10 replacing a price already in force in the past is refused (409 FINANCE_RATE_PAST_REPLACEMENT); the past price stays",
      since20.status === 201 && past.status === 409 && past.body.error === "FINANCE_RATE_PAST_REPLACEMENT" && stillPast.body.billing?.amountCents === 2900,
      `${since20.status} ${past.status} ${past.body.error} d-5=${stillPast.body.billing?.amountCents}`);

    // S11 Overlaps refused at the database, also under concurrency.
    const directOverlap = await asSession({ userId: adm.userId, orgId: orgA },
      "INSERT INTO finance_rates (organization_id,service_id,rate_kind,scope,amount_cents,effective_from,created_by_user_id) VALUES ($1,$2,'caregiver','general',1,$3::date,$4)",
      [orgA, ids.hospital, day(-1), adm.userId]);
    const twin = await Promise.all([
      rate(ids.escort, { rateKind: "client", amountCents: 2900, effectiveFrom: day(20), reason: "Concurrente A" }),
      rate(ids.escort, { rateKind: "client", amountCents: 3100, effectiveFrom: day(20), reason: "Concurrente B" }),
    ]);
    const overlapCount = (await q<{ n: number }>(`SELECT count(*)::int n FROM finance_rates a JOIN finance_rates b ON a.id < b.id
      AND a.organization_id = b.organization_id AND a.service_id = b.service_id AND a.rate_kind = b.rate_kind AND a.scope = b.scope
      AND a.day_type = b.day_type AND a.billing_client_id IS NOT DISTINCT FROM b.billing_client_id
      AND a.organization_worker_membership_id IS NOT DISTINCT FROM b.organization_worker_membership_id
      AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]')
      WHERE a.organization_id = $1`, [orgA])).rows[0].n;
    check("S11 overlapping versions refused (direct insert and two admins saving at once: one 201, one 409); 0 overlaps stored",
      /FINANCE_RATE_OVERLAP/.test(directOverlap.error ?? "") && twin.map((r) => r.status).sort().join(",") === "201,409" && overlapCount === 0,
      `${directOverlap.error ?? "ALLOWED"} | ${twin.map((r) => `${r.status}:${r.body.error ?? ""}`).join(" ")} | overlaps=${overlapCount}`);

    // S12 A rate version is never edited.
    const anyRate = (await q<{ id: string }>("SELECT id FROM finance_rates WHERE service_id=$1 AND rate_kind='caregiver' AND scope='general'", [ids.hospital])).rows[0].id;
    const updAmount = await asSession({ userId: adm.userId, orgId: orgA }, "UPDATE finance_rates SET amount_cents=1 WHERE id=$1", [anyRate]);
    const ownerAmount = await q("UPDATE finance_rates SET amount_cents=1 WHERE id=$1", [anyRate]).then(() => "updated").catch((e: Error) => e.message);
    const extend = await q("UPDATE finance_rates SET effective_to=NULL WHERE effective_to IS NOT NULL AND organization_id=$1", [orgA]).then(() => "updated").catch((e: Error) => e.message);
    const delRate = await q("DELETE FROM finance_rates WHERE id=$1", [anyRate]).then(() => "deleted").catch((e: Error) => e.message);
    check("S12 amount, window start and history immutable; window only shortened; no delete (admin and owner)",
      Boolean(updAmount.error) && ![ownerAmount, extend, delRate].includes("updated") && delRate !== "deleted",
      `${updAmount.error} | ${ownerAmount} | ${extend} | ${delRate}`);

    // S13 Filling a past gap is allowed (with reason) and ends before the next version.
    const gap = await rate(ids.hospital, { rateKind: "caregiver", scope: "caregiver", membershipId: cg.owm, amountCents: 1900, effectiveFrom: day(-30), reason: "Acuerdo desde el mes pasado" });
    const gapLater = await rate(ids.hospital, { rateKind: "caregiver", scope: "caregiver", membershipId: cg.owm, amountCents: 2000, effectiveFrom: day(1) });
    const gapFill = await rate(ids.hospital, { rateKind: "caregiver", scope: "caregiver", membershipId: cg2.owm, amountCents: 2100, effectiveFrom: day(5) });
    const gapBefore = await rate(ids.hospital, { rateKind: "caregiver", scope: "caregiver", membershipId: cg2.owm, amountCents: 2050, effectiveFrom: day(-10), reason: "Hueco anterior" });
    check("S13 past gap filled with reason; a version before a later one ends the day before it",
      gap.status === 201 && gapLater.status === 400 && gapFill.status === 201 && gapBefore.status === 201 && gapBefore.body.rate?.effective_to === day(4),
      `${gap.status} ${gapLater.status}:${gapLater.body.error} ${gapFill.status} ${gapBefore.status} to=${gapBefore.body.rate?.effective_to}`);

    // S14 Agency holidays use holiday versions first.
    const hol = await call("POST", `${F}/holidays`, adm.token, { date: day(25), name: "Feriado de prueba" });
    const holRate = await rate(ids.home, { rateKind: "client", dayType: "holiday", amountCents: 3750, effectiveFrom: today });
    const onHoliday = await resolve({ serviceId: ids.home, date: day(25), billingClientId: clientX.id });
    const notHoliday = await resolve({ serviceId: ids.home, date: day(24), billingClientId: clientX.id });
    check("S14 on an agency holiday the holiday rate (3750) applies; the day before the normal client price (2200)",
      hol.status === 201 && holRate.status === 201 && onHoliday.body.billing?.amountCents === 3750 && onHoliday.body.billing?.dayType === "holiday"
        && onHoliday.body.holiday === "Feriado de prueba" && notHoliday.body.billing?.amountCents === 2200,
      `${onHoliday.body.billing?.amountCents}/${onHoliday.body.billing?.dayType} prev=${notHoliday.body.billing?.amountCents}`);

    // S15 Calculations per unit through the API.
    const h8 = await resolve({ serviceId: ids.hospital, minutes: 480 });
    const d24 = await resolve({ serviceId: ids.full, minutes: 1440 });
    const d18 = await resolve({ serviceId: ids.full, minutes: 1080 });
    check("S15 8 h hospital: 24000 billed / 14400 paid, gross margin 9600 (40 %); 24 h = 1 day 30000/19000; 18 h: proportional billing 22500, pay to review",
      h8.body.estimate?.billing?.amountCents === 24000 && h8.body.estimate?.pay?.amountCents === 14400 && h8.body.estimate?.margin?.differenceCents === 9600 && h8.body.estimate?.margin?.marginBasisPoints === 4000
        && d24.body.estimate?.billing?.amountCents === 30000 && d24.body.estimate?.pay?.amountCents === 19000
        && d18.body.estimate?.billing?.amountCents === 22500 && d18.body.estimate?.pay?.needsReview === true && (d18.body.exceptions ?? []).includes("PARTIAL_DAY"),
      `h8=${h8.body.estimate?.billing?.amountCents}/${h8.body.estimate?.pay?.amountCents}/${h8.body.estimate?.margin?.differenceCents} d24=${d24.body.estimate?.billing?.amountCents}/${d24.body.estimate?.pay?.amountCents} d18=${d18.body.estimate?.billing?.amountCents}/${d18.body.estimate?.pay?.needsReview}`);

    // S16 Shift finance terms: shift created with the unchanged API, service chosen after.
    const sh = await shiftFor(orgA, adm, recipientA, cg, 3);
    const keysOk = !Object.keys(sh.response).some((k) => /service_id|finance/.test(k) && k !== "service_location_id");
    const t0 = await call("GET", `/organizations/${orgA}/shifts/${sh.id}/finance`, adm.token);
    await call("POST", `${F}/clients/${clientX.id}/recipients`, adm.token, { careRecipientId: recipientA, isPrimary: true });
    const def = await call("PUT", `${F}/recipients/${recipientA}/defaults`, adm.token, { serviceId: ids.hospital });
    const t1 = await call("GET", `/organizations/${orgA}/shifts/${sh.id}/finance`, adm.token);
    const put = await call("PUT", `/organizations/${orgA}/shifts/${sh.id}/finance`, adm.token, { serviceId: ids.home, authorizedUnitsHundredths: 300 });
    check("S16 shift created as today (no finance fields); without terms NO_SERVICE; resident default → hospital; shift set to home → 2200 billed (client X), 1500 paid, 3 h estimate 6600/4500",
      keysOk && (t0.body.exceptions ?? []).includes("NO_SERVICE") && def.status === 200 && t1.body.effective?.serviceSource === "recipient_default"
        && t1.body.resolution?.billing?.amountCents === 3000 && put.status === 200 && put.body.effective?.serviceSource === "shift"
        && put.body.resolution?.billing?.amountCents === 2200 && put.body.resolution?.pay?.amountCents === 1500
        && put.body.resolution?.estimate?.billing?.amountCents === 6600 && put.body.resolution?.estimate?.pay?.amountCents === 4500,
      `keys=${keysOk} t0=${(t0.body.exceptions ?? []).join("/")} t1=${t1.body.effective?.serviceSource}:${t1.body.resolution?.billing?.amountCents} put=${put.status}:${put.body.resolution?.billing?.amountCents}/${put.body.resolution?.pay?.amountCents} est=${put.body.resolution?.estimate?.billing?.amountCents}/${put.body.resolution?.estimate?.pay?.amountCents}`);

    // S17 Check-in/out unchanged; once hours are approved the shift's service and payer are locked.
    const ci = await call("POST", `/organizations/${orgA}/shifts/${sh.id}/check-in`, cg.token, { verificationMethodCode: "CAREGIVER_SESSION" });
    await q(`UPDATE verification_events SET occurred_at = now() - interval '2 hours' WHERE shift_id = $1 AND event_type = 'check_in'`, [sh.id]);
    const co = await call("POST", `/organizations/${orgA}/shifts/${sh.id}/check-out`, cg.token, {});
    const tsId = (await q<{ id: string }>("SELECT id FROM timesheets WHERE shift_id=$1", [sh.id])).rows[0]?.id;
    await call("PUT", `/organizations/${orgA}/financial-rates/${cg.owm}`, adm.token, { payRateCents: 1500, billRateCents: 2500, currency: "USD" });
    const appr = await call("POST", `/organizations/${orgA}/timesheets/${tsId}/review`, adm.token, { decision: "approved" });
    const lockedPut = await call("PUT", `/organizations/${orgA}/shifts/${sh.id}/finance`, adm.token, { serviceId: ids.hospital });
    const afterLock = await call("GET", `/organizations/${orgA}/shifts/${sh.id}/finance`, adm.token);
    check("S17 check-in 201 / check-out 201 / approval 200 unchanged; then changing the shift's service is 409 SHIFT_FINANCE_LOCKED; approved minutes used",
      ci.status === 201 && co.status === 201 && appr.status === 200 && lockedPut.status === 409 && lockedPut.body.error === "SHIFT_FINANCE_LOCKED"
        && afterLock.body.locked === true && afterLock.body.effective?.minutesSource === "approved_timesheet",
      `${ci.status}/${co.status}/${appr.status} lock=${lockedPut.status}:${lockedPut.body.error} src=${afterLock.body.effective?.minutesSource}`);

    // S18 Shifts and legacy rates untouched.
    const shiftColumnsAfter = (await q<{ c: string }>("SELECT string_agg(column_name, ',' ORDER BY column_name) c FROM information_schema.columns WHERE table_name='shifts'")).rows[0].c;
    const getShift = await call("GET", `/organizations/${orgA}/shifts/${sh.id}`, adm.token);
    const legacyRates = await call("GET", `/organizations/${orgA}/financial-rates`, adm.token);
    const oldNoTerms = await shiftFor(orgA, adm, recipientA);
    const oldGet = await call("GET", `/organizations/${orgA}/shifts/${oldNoTerms.id}`, adm.token);
    const legacyOther = JSON.stringify((await q("SELECT * FROM worker_financial_rates WHERE organization_id <> $1 ORDER BY organization_worker_membership_id", [orgA])).rows);
    const legacyBeforeOther = JSON.stringify(JSON.parse(legacyBefore).filter((r: Json) => r.organization_id !== orgA));
    check("S18 shifts table has no new column; shift GET 200; a shift without terms still works; «Tarifas del equipo» (legacy) 200 and other agencies' legacy rates unchanged",
      shiftColumnsBefore === shiftColumnsAfter && getShift.status === 200 && oldGet.status === 200 && legacyRates.status === 200 && legacyOther === legacyBeforeOther,
      `cols=${shiftColumnsBefore === shiftColumnsAfter} ${getShift.status}/${oldGet.status}/${legacyRates.status} legacy=${legacyOther === legacyBeforeOther}`);

    const cgList = await call("GET", `${F}/caregivers`, adm.token);
    const cg2Row = (cgList.body.caregivers ?? []).find((c: Json) => c.membership_id === cg2.owm);
    const cgRow = (cgList.body.caregivers ?? []).find((c: Json) => c.membership_id === cg.owm);
    check("S19 «Por cuidador» shows legacy hourly rates next to per-service exceptions",
      cgList.status === 200 && cgRow?.legacy_pay_rate_cents === 1500 && (cg2Row?.exceptions ?? []).some((e: Json) => e.amountCents === 1700 && e.serviceId === ids.home),
      `${cgList.status} legacy=${cgRow?.legacy_pay_rate_cents} cg2=${(cg2Row?.exceptions ?? []).length}`);

    // S20 Agency with FINANZAS off: shifts unchanged, finance 404.
    const offShift = await shiftFor(orgC, admC, recipientC);
    const offTerms = await call("PUT", `/organizations/${orgC}/shifts/${offShift.id}/finance`, admC.token, { serviceId: null });
    check("S20 FINANZAS off: shift creation works as before (201); shift finance 404", offTerms.status === 404, `${offTerms.status} ${offTerms.body.error}`);

    // S21 Roles over HTTP.
    const paths = [`${F}/services`, `${F}/clients`, `${F}/caregivers`, `${F}/holidays`, `${F}/services/${ids.home}/rates`,
      `${F}/rates/resolve?serviceId=${ids.home}`, `/organizations/${orgA}/shifts/${sh.id}/finance`];
    const leaks: string[] = [];
    for (const [name, p] of [["supervisor", sup], ["caregiver", cg], ["family", fam], ["adminB", admB]] as const) {
      for (const path of paths) {
        const r = await call("GET", path, p.token);
        if (r.status !== 403 || MONEY_KEY.test(JSON.stringify(r.body))) leaks.push(`${name} GET ${path.split("/finance")[1] ?? path}=${r.status}`);
      }
      const w1 = await call("POST", `${F}/services`, p.token, { name: `Hack ${name}`, unit: "hour" });
      const w2 = await call("POST", `${F}/services/${ids.home}/rates`, p.token, { rateKind: "client", amountCents: 1 });
      const w3 = await call("PUT", `/organizations/${orgA}/shifts/${sh.id}/finance`, p.token, { serviceId: null });
      for (const [label, w] of [["service", w1], ["rate", w2], ["terms", w3]] as const) if (w.status !== 403) leaks.push(`${name} ${label}=${w.status}`);
    }
    check("S21 supervisor, caregiver, family and another agency's admin: 403 on every finance route (read and write), no amounts", leaks.length === 0, leaks.join(" ") || "all 403");

    // S22 Roles at the database (incl. ETNARA central).
    const dbLeaks: string[] = [];
    const ctxs: Array<[string, { userId: string; orgId: string; superadmin?: boolean }]> = [
      ["supervisor", { userId: sup.userId, orgId: orgA }], ["caregiver", { userId: cg.userId, orgId: orgA }],
      ["family", { userId: fam.userId, orgId: orgA }], ["central", central], ["adminB(ctx A)", { userId: admB.userId, orgId: orgA }],
    ];
    for (const [name, ctx] of ctxs) {
      for (const t of TABLES) {
        const r = await asSession<{ n: number }>(ctx, `SELECT count(*)::int n FROM ${t}`);
        if (r.error || r.rows[0]?.n !== 0) dbLeaks.push(`${name}:${t}=${r.rows[0]?.n ?? r.error}`);
      }
      const ins = await asSession(ctx, "INSERT INTO finance_services (organization_id,name,unit,created_by_user_id,updated_by_user_id) VALUES ($1,$2,'hour',$3,$3)", [orgA, `DB ${name}`, ctx.userId]);
      if (!ins.error) dbLeaks.push(`${name}:insert`);
      const upd = await asSession(ctx, "UPDATE finance_services SET name = name || 'x' WHERE organization_id=$1", [orgA]);
      if (!upd.error && upd.rowCount > 0) dbLeaks.push(`${name}:update=${upd.rowCount}`);
    }
    check("S22 supervisor, caregiver, family, ETNARA central and another agency's admin: 0 rows in the 7 tables and no writes (database)", dbLeaks.length === 0, dbLeaks.join(" ") || "0 leaks");

    // S23 Agency isolation.
    const bService = (await call("POST", `/organizations/${orgB}/finance/services`, admB.token, { name: "Cuido en el hogar", unit: "hour" })).body.service;
    const recipientB = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Luis',$2,'active') RETURNING id`, [orgB, `B-${tag}`])).rows[0].id;
    const bShift = await shiftFor(orgB, admB, recipientB);
    const crossService = await call("PUT", `/organizations/${orgB}/shifts/${bShift.id}/finance`, admB.token, { serviceId: ids.home });
    const crossRate = await call("POST", `/organizations/${orgB}/finance/services/${bService?.id}/rates`, admB.token, { rateKind: "client", scope: "client", billingClientId: clientX.id, amountCents: 1 });
    const crossRead = await call("GET", `/organizations/${orgB}/finance/services/${ids.home}/rates`, admB.token);
    const aSees = (await call("GET", `${F}/services`, adm.token)).body.services?.some((s: Json) => s.id === bService?.id);
    const dbCross = await asSession<{ n: number }>({ userId: admB.userId, orgId: orgB }, "SELECT count(*)::int n FROM finance_rates WHERE organization_id <> $1", [orgB]);
    check("S23 same service name allowed in another agency; B cannot use A's service, client or rates (404); A does not see B; 0 cross rows",
      Boolean(bService?.id) && crossService.status === 404 && crossRate.status === 404 && crossRead.status === 404 && aSees === false && dbCross.rows[0]?.n === 0,
      `${crossService.status}/${crossRate.status}/${crossRead.status} aSees=${aSees} db=${dbCross.rows[0]?.n}`);

    // S24 Amounts never in audit_log; full history in finance_events.
    const audit = await q<{ action: string; previous_value: Json | null; new_value: Json | null }>("SELECT action, previous_value, new_value FROM audit_log WHERE organization_id=$1 AND action LIKE 'FINANCE%'", [orgA]);
    const auditMoney = audit.rows.filter((r) => [r.previous_value, r.new_value].some((v) => v && MONEY_KEY.test(JSON.stringify(v))));
    const nonAdminAudit = await asSession<{ n: number }>({ userId: sup.userId, orgId: orgA }, "SELECT count(*)::int n FROM audit_log WHERE action LIKE 'FINANCE%'");
    const events = await asSession<{ n: number }>({ userId: adm.userId, orgId: orgA }, "SELECT count(*)::int n FROM finance_events WHERE action='FINANCE_RATE_CREATED' AND new_value ? 'amount_cents'");
    const history = await call("GET", `${F}/services/${ids.home}/rates`, adm.token);
    check("S24 audit_log has FINANCE_* rows without amounts (hidden from the supervisor); finance_events and the service history carry the values",
      audit.rows.length > 10 && auditMoney.length === 0 && nonAdminAudit.rows[0]?.n === 0 && (events.rows[0]?.n ?? 0) >= 10
        && (history.body.history ?? []).length >= 5 && (history.body.rates ?? []).some((r: Json) => r.status === "future"),
      `audit=${audit.rows.length} money=${auditMoney.length} supervisor=${nonAdminAudit.rows[0]?.n} events=${events.rows[0]?.n} history=${(history.body.history ?? []).length}`);

    // S25 Deactivation and validation.
    const deact = await call("PATCH", `${F}/services/${ids.escort}`, adm.token, { active: false });
    const rateOnInactive = await rate(ids.escort, { rateKind: "caregiver", amountCents: 1, effectiveFrom: day(40), reason: "x x x" });
    const shiftOnInactive = await call("PUT", `/organizations/${orgA}/shifts/${oldNoTerms.id}/finance`, adm.token, { serviceId: ids.escort });
    const badScope = await rate(ids.home, { rateKind: "caregiver", scope: "client", billingClientId: clientX.id, amountCents: 1 });
    const badRule = await rate(ids.full, { rateKind: "client", scope: "client", billingClientId: clientX.id, amountCents: 1, minMinutes: 60 });
    const badHalf = await rate(ids.full, { rateKind: "client", scope: "client", billingClientId: clientY.id, amountCents: 1, halfDayPolicy: "fixed" });
    const reactivated = await call("PATCH", `${F}/services/${ids.escort}`, adm.token, { active: true });
    check("S25 inactive service refuses new rates and shifts (409); invalid scope, hourly rule on a daily service, fixed half day without amount: 400; reactivation works",
      deact.status === 200 && rateOnInactive.status === 409 && shiftOnInactive.status === 409 && badScope.status === 400 && badRule.status === 400 && badHalf.status === 400 && reactivated.status === 200,
      `${deact.status} ${rateOnInactive.status} ${shiftOnInactive.status} ${badScope.status} ${badRule.status} ${badHalf.status} ${reactivated.status}`);

    // S26 Ending a rate: never in the past, only earlier.
    const toEnd = (await q<{ id: string }>("SELECT id FROM finance_rates WHERE service_id=$1 AND rate_kind='client' AND scope='client' AND billing_client_id=$2", [ids.home, clientX.id])).rows[0].id;
    const endPast = await call("POST", `${F}/rates/${toEnd}/end`, adm.token, { effectiveTo: day(-3), reason: "Fin del acuerdo" });
    const endOk = await call("POST", `${F}/rates/${toEnd}/end`, adm.token, { effectiveTo: day(30), reason: "Fin del acuerdo" });
    const after31 = await resolve({ serviceId: ids.home, billingClientId: clientX.id, date: day(31) });
    check("S26 a negotiated price can end in the future (then the general price applies) but never in the past (400)",
      endPast.status === 400 && endOk.status === 200 && after31.body.billing?.source === "general" && after31.body.billing?.amountCents === 2700,
      `${endPast.status} ${endOk.status} d31=${after31.body.billing?.amountCents}/${after31.body.billing?.source}`);

    // S27 Margin is in the admin's service list only.
    const list2 = await call("GET", `${F}/services`, adm.token);
    const hosp = (list2.body.services ?? []).find((s: Json) => s.id === ids.hospital);
    check("S27 admin service list shows billing, pay and estimated gross margin (3000 / 1800 / 1200, 40 %)",
      hosp?.client_cents === 3000 && hosp?.caregiver_cents === 1800 && hosp?.margin?.differenceCents === 1200 && hosp?.margin?.marginBasisPoints === 4000,
      JSON.stringify(hosp?.margin));

    const fives = all.filter((r) => r.status === 500);
    check("S28 no 500 in the whole run", fives.length === 0, fives.map((r) => JSON.stringify(r.body)).join(" "));
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
    await runtime.end();
    await db.end();
  }

  console.log("\nETNARA Finanzas F1 — services and differentiated rates\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nFinance services and rates: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Finance services verification failed:", error);
  process.exit(1);
});
