/**
 * ETNARA Facturación Premium F2.2 (migration 124) — tax treatment, drafts from
 * approved shifts, overnight segments (D8), reservations (D3), manual lines and
 * anti-duplicates (D2), historical rates, discard and audited recovery,
 * permissions, RLS, isolation, read-only mode, audit. No invoice can be issued.
 * HTTP + app_runtime in PostgreSQL. Synthetic data only (.invalid e-mails).
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
    const email = `f22-${key}-${tag}@example.invalid`;
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

  const orgA = await agency("F22 A", true);
  const orgB = await agency("F22 B", true);
  const orgC = await agency("F22 C", false);
  const adm = await person(orgA, "admin", ["ORGANIZATION_ADMIN"]);
  const sup = await person(orgA, "supervisor", ["SUPERVISOR"]);
  const cg = await person(orgA, "cg", ["WORKER"], true);
  const admB = await person(orgB, "adminb", ["ORGANIZATION_ADMIN"]);
  const admC = await person(orgC, "adminc", ["ORGANIZATION_ADMIN"]);
  // ETNARA central: platform administrator with no agency membership.
  const platformEmail = `f22-central-${tag}@example.invalid`;
  const platformUserId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [platformEmail, hash])).rows[0].id;
  await q("INSERT INTO platform_admins (user_id) VALUES ($1)", [platformUserId]);
  const platformLogin = await call("POST", "/auth/login", "", { email: platformEmail, password });
  if (platformLogin.status !== 200) throw new Error(`central login ${platformLogin.status}`);
  const platform = { userId: platformUserId, token: platformLogin.body.token as string };
  const mem = async (p: P) => (await q<{ id: string }>("SELECT id FROM organization_memberships WHERE user_id=$1 AND organization_id=$2", [p.userId, p.orgId])).rows[0].id;
  const feat = (org: string, code: string, enabled: boolean, reason = "Piloto de facturación") => call("PUT", `/platform/organizations/${org}/features/${code}`, platform.token, { enabled, reason });
  const B = (org: string) => `/organizations/${org}/billing`;

  const MONEY = /cents|amount|total|price|subtotal/i;
  const I = `${B(orgA)}/invoices`;
  const S = (r: { status: number; body: Json }) => `${r.status}${r.body?.error ? "/" + r.body.error : ""}`;

  // --- Fixtures (fictitious): FACTURACION on for A and B (single admin → 5 permissions).
  await feat(orgA, "FACTURACION", true); await feat(orgB, "FACTURACION", true);
  const adm2 = await person(orgA, "admin2", ["ORGANIZATION_ADMIN"]);
  await call("POST", `${B(orgA)}/permissions`, adm.token, { membershipId: await mem(adm2), capability: "draft", reason: "Solo borradores" });
  const svcHour = (await q<{ id: string }>(`INSERT INTO finance_services (organization_id,name,unit,created_by_user_id,updated_by_user_id) VALUES ($1,'Cuido por hora','hour',$2,$2) RETURNING id`, [orgA, adm.userId])).rows[0].id;
  const svcDay = (await q<{ id: string }>(`INSERT INTO finance_services (organization_id,name,unit,created_by_user_id,updated_by_user_id) VALUES ($1,'Cuido 24 horas','day',$2,$2) RETURNING id`, [orgA, adm.userId])).rows[0].id;
  const rate = (svc: string, amount: number, from: string, to: string | null, extra: { day?: string; client?: string } = {}) => q(
    `INSERT INTO finance_rates (organization_id,service_id,rate_kind,scope,billing_client_id,day_type,amount_cents,effective_from,effective_to,created_by_user_id)
     VALUES ($1,$2,'client',$3,$4,$5,$6,$7,$8,$9)`, [orgA, svc, extra.client ? "client" : "general", extra.client ?? null, extra.day ?? "standard", amount, from, to, adm.userId]);
  await rate(svcHour, 2500, "2026-01-01", "2026-08-31");
  await rate(svcHour, 2700, "2026-09-01", null);
  await rate(svcHour, 3750, "2026-01-01", null, { day: "holiday" });
  await rate(svcDay, 18000, "2026-01-01", null);
  await q(`INSERT INTO finance_holidays (organization_id,holiday_date,name,created_by_user_id) VALUES ($1,'2026-07-04','Día de la Independencia',$2)`, [orgA, adm.userId]);
  const recipient = async (org: string, first: string) => (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,$2,$3,'active') RETURNING id`, [org, first, `F22-${tag}`])).rows[0].id;
  const maria = await recipient(orgA, "María");
  const jose = await recipient(orgA, "José");
  const client = async (org: string, name: string, rec: string) => {
    const id = (await q<{ id: string }>(`INSERT INTO billing_clients (organization_id,full_name,created_by_user_id,updated_by_user_id) VALUES ($1,$2,$3,$3) RETURNING id`, [org, name, adm.userId])).rows[0].id;
    await q(`INSERT INTO billing_client_recipients (billing_client_id,care_recipient_id,organization_id,is_primary,created_by_user_id) VALUES ($1,$2,$3,true,$4)`, [id, rec, org, adm.userId]);
    return id;
  };
  const perez = await client(orgA, "Familia Pérez (ficticia)", maria);
  const otro = await client(orgA, "Otro pagador (ficticio)", jose);
  await q(`INSERT INTO recipient_finance_defaults (care_recipient_id,organization_id,service_id,updated_by_user_id) VALUES ($1,$2,$3,$4),($5,$2,$3,$4)`, [maria, orgA, svcHour, adm.userId, jose]);
  const shift = async (rec: string, startIso: string, minutes: number, ts: "approved" | "pending" | null, service?: string) => {
    const start = new Date(startIso); const end = new Date(start.getTime() + minutes * 60000);
    const id = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,$3,$4,'confirmed') RETURNING id`, [orgA, rec, start, end])).rows[0].id;
    const a = (await q<{ id: string }>(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,response_status,responded_at) VALUES ($1,$2,$3,$4,'accepted',now()) RETURNING id`, [orgA, id, cg.owm, rec])).rows[0].id;
    if (service) await q(`INSERT INTO shift_finance_terms (shift_id,organization_id,service_id,updated_by_user_id) VALUES ($1,$2,$3,$4)`, [id, orgA, service, adm.userId]);
    if (ts) await q(`INSERT INTO timesheets (organization_id,shift_id,assignment_id,organization_worker_membership_id,care_recipient_id,check_in_at,check_out_at,recorded_minutes,
        approved_minutes,pay_rate_cents_snapshot,bill_rate_cents_snapshot,pay_amount_cents,bill_amount_cents,status,reviewed_by_user_id,reviewed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, ts === "approved"
      ? [orgA, id, a, cg.owm, rec, start, end, minutes, minutes, 1500, 2500, 1, 1, "approved", adm.userId, new Date()]
      : [orgA, id, a, cg.owm, rec, start, end, minutes, null, null, null, null, null, "pending", null, null]);
    return id;
  };
  const s1 = await shift(maria, "2026-07-03T22:00:00-04:00", 480, "approved");   // holiday on the 2nd segment
  const s2 = await shift(maria, "2026-08-31T22:00:00-04:00", 480, "approved");   // rate change at midnight
  const s3 = await shift(maria, "2026-08-10T09:00:00-04:00", 240, "approved");   // plain 4 h
  const s4 = await shift(maria, "2026-08-12T08:00:00-04:00", 1430, "approved", svcDay); // 23 h 50 min
  const s5 = await shift(maria, "2026-08-15T09:00:00-04:00", 240, "pending");    // hours not approved
  const s6 = await shift(jose, "2026-08-16T09:00:00-04:00", 240, "approved");    // other payer
  const s7 = await shift(maria, "2026-08-20T09:00:00-04:00", 480, "approved");   // concurrency
  const s8 = await shift(maria, "2026-09-05T09:00:00-04:00", 240, "approved");   // outside the period
  const s9 = await shift(maria, "2026-08-21T09:00:00-04:00", 240, "approved");   // inactive draft

  try {
    // D01 Tax treatment: nothing preloaded; manager only; immutable versions.
    const taxRows = (await q<{ n: number }>("SELECT count(*)::int n FROM finance_service_tax")).rows[0].n;
    const tax0 = await call("GET", `${B(orgA)}/tax`, adm.token);
    const taxDraftOnly = await call("POST", `${B(orgA)}/tax`, adm2.token, { serviceId: svcHour, treatment: "exempt", legalBasis: "Base de prueba", effectiveFrom: "2026-01-01" });
    const taxNoRate = await call("POST", `${B(orgA)}/tax`, adm.token, { serviceId: svcHour, treatment: "taxable", effectiveFrom: "2026-01-01" });
    const taxNoBasis = await call("POST", `${B(orgA)}/tax`, adm.token, { serviceId: svcHour, treatment: "exempt", effectiveFrom: "2026-01-01" });
    check("D01 tax: nothing preloaded (0 rows, every service «pending»); only the permissions manager sets it (draft-only 403); taxable needs a rate and exempt a legal basis (400)",
      taxRows === 0 && tax0.status === 200 && tax0.body.services?.every((s: Json) => s.current.treatment === "pending") && taxDraftOnly.status === 403 && taxNoRate.status === 400 && taxNoBasis.status === 400,
      `rows=${taxRows} ${S(tax0)} ${tax0.body.services?.map((s: Json) => s.current.treatment)} draftOnly=${S(taxDraftOnly)} ${S(taxNoRate)} ${S(taxNoBasis)}`);

    // D02 Create drafts.
    const badPeriod = await call("POST", I, adm.token, { billingClientId: perez, periodFrom: "2026-08-31", periodTo: "2026-07-01" });
    const longPeriod = await call("POST", I, adm.token, { billingClientId: perez, periodFrom: "2026-01-01", periodTo: "2026-08-31" });
    const otherAgencyClient = await call("POST", `${B(orgB)}/invoices`, admB.token, { billingClientId: perez, periodFrom: "2026-07-01", periodTo: "2026-08-31" });
    const supCreate = await call("POST", I, sup.token, { billingClientId: perez, periodFrom: "2026-07-01", periodTo: "2026-08-31" });
    const centralCreate = await call("POST", I, platform.token, { billingClientId: perez, periodFrom: "2026-07-01", periodTo: "2026-08-31" });
    const d1 = await call("POST", I, adm.token, { billingClientId: perez, periodFrom: "2026-07-01", periodTo: "2026-08-31", notes: "Julio y agosto" });
    const id1 = d1.body.invoice?.id;
    const g1 = await call("GET", `${I}/${id1}`, adm.token);
    check("D02 drafts: impossible or >92-day period refused; another agency's client 404; supervisor and ETNARA central refused; the manager creates a draft (version 1, client copied)",
      badPeriod.status === 400 && [400, 409].includes(longPeriod.status) && otherAgencyClient.status === 404 && supCreate.status === 403 && [403, 404].includes(centralCreate.status)
        && d1.status === 201 && g1.body.invoice?.version === 1 && g1.body.invoice?.clientName === "Familia Pérez (ficticia)" && g1.body.invoice?.status === "draft",
      `${S(badPeriod)} ${S(longPeriod)} ${S(otherAgencyClient)} ${S(supCreate)} ${S(centralCreate)} ${S(d1)} v=${g1.body.invoice?.version}`);

    // D03 Eligible shifts (approved hours only), priced per segment, hand-calculated.
    const el = await call("GET", `${B(orgA)}/eligible-shifts?billingClientId=${perez}&from=2026-07-01&to=2026-08-31`, adm.token);
    const E = (sid: string) => el.body.shifts?.find((x: Json) => x.shiftId === sid);
    const e1 = E(s1), e2 = E(s2), e3 = E(s3), e4 = E(s4), e5 = E(s5);
    check("D03 eligible shifts: overnight with holiday 2 h × $25 + 6 h × $37.50 = $275.00; rate change at midnight $50 + $162 = $212; 4 h = $100; 23 h 50 min day → selectable but flagged for review + 10-min warning; pending hours not selectable; other payer and other period absent",
      el.status === 200 && e1?.amountCents === 27500 && e1.segments?.map((x: Json) => x.amountCents).join() === "5000,22500" && e1.segments?.[1]?.rate?.holiday === "Día de la Independencia" && e1.selectable
        && e2?.amountCents === 21200 && e2.segments?.map((x: Json) => x.amountCents).join() === "5000,16200"
        && e3?.amountCents === 10000 && e4 && e4.selectable && e4.exceptions.includes("PARTIAL_DAY") && e4.warnings?.[0]?.code === "DAY_ALMOST_COMPLETE" && e4.warnings?.[0]?.minutes === 10
        && e5 && !e5.selectable && e5.exceptions.includes("HOURS_NOT_APPROVED") && !E(s6) && !E(s8),
      `${S(el)} s1=${e1?.amountCents}/${e1?.segments?.map((x: Json) => x.amountCents)} s2=${e2?.amountCents}/${e2?.segments?.map((x: Json) => x.amountCents)} s3=${e3?.amountCents} s4=${e4?.exceptions}/${JSON.stringify(e4?.warnings)} s5=${e5?.exceptions} s6=${Boolean(E(s6))} s8=${Boolean(E(s8))}`);

    // D04 Add lines: segments and real times kept, totals, blockers.
    const add = await call("POST", `${I}/${id1}/shift-lines`, adm.token, { expectedVersion: 1, shiftIds: [s1, s2, s3] });
    const g2 = await call("GET", `${I}/${id1}`, adm.token);
    const l1 = g2.body.lines?.find((l: Json) => l.shift_id === s1);
    const realOk = l1 && new Date(l1.real_start).toISOString() === new Date("2026-07-03T22:00:00-04:00").toISOString() && new Date(l1.real_end).toISOString() === new Date("2026-07-04T06:00:00-04:00").toISOString();
    const segMin = l1?.segments?.reduce((a: number, x: Json) => a + x.minutes, 0);
    check("D04 shift lines: 3 added (201), version 2; real start/end kept; segments add up to exactly 480 min; subtotal $587.00; issuing blocked (ISSUING_NOT_AVAILABLE + TAX_PENDING), nothing assumed",
      add.status === 201 && add.body.added?.length === 3 && g2.body.invoice?.version === 2 && realOk && segMin === 480 && l1.segments.length === 2
        && g2.body.totals?.subtotalCents === 58700 && g2.body.totals?.taxCents === 0
        && g2.body.issueBlockers?.includes("ISSUING_NOT_AVAILABLE") && g2.body.issueBlockers?.includes("TAX_PENDING") && l1.tax_treatment === "pending",
      `${S(add)} v=${g2.body.invoice?.version} real=${realOk} seg=${segMin} sub=${g2.body.totals?.subtotalCents} blockers=${g2.body.issueBlockers}`);

    // D05 Validation.
    const stale = await call("POST", `${I}/${id1}/shift-lines`, adm.token, { expectedVersion: 1, shiftIds: [s7] });
    const other = await call("POST", `${I}/${id1}/shift-lines`, adm.token, { expectedVersion: 2, shiftIds: [s6] });
    const pendingHours = await call("POST", `${I}/${id1}/shift-lines`, adm.token, { expectedVersion: 2, shiftIds: [s5] });
    const outside = await call("POST", `${I}/${id1}/shift-lines`, adm.token, { expectedVersion: 2, shiftIds: [s8] });
    const v2 = (await call("GET", `${I}/${id1}`, adm.token)).body.invoice?.version;
    // Diseño v2 §7/§14: a partial day is added FLAGGED (needs_review, amount only for what is decided) and blocks issuing.
    const d5 = (await call("POST", I, adm.token, { billingClientId: perez, periodFrom: "2026-08-01", periodTo: "2026-08-31" })).body.invoice?.id;
    const review = await call("POST", `${I}/${d5}/shift-lines`, adm.token, { expectedVersion: 1, shiftIds: [s4] });
    const g5r = await call("GET", `${I}/${d5}`, adm.token);
    const rl = g5r.body.lines?.[0];
    check("D05 stale version 409 DRAFT_CHANGED; other payer 409; unapproved hours 409 SHIFT_NOT_BILLABLE; outside the period 409; failed requests change nothing (still version 2); a partial day is added flagged (PARTIAL_DAY, $0 decided, 10-min warning) and blocks issuing (NEEDS_REVIEW)",
      stale.body.error === "DRAFT_CHANGED" && other.body.error === "SHIFT_OTHER_CLIENT" && pendingHours.body.error === "SHIFT_NOT_BILLABLE"
        && outside.body.error === "SHIFT_OUTSIDE_PERIOD" && v2 === 2
        && review.status === 201 && rl?.needs_review === true && rl.review_reasons?.includes("PARTIAL_DAY") && rl.amount_cents === 0
        && rl.warnings?.[0]?.code === "DAY_ALMOST_COMPLETE" && g5r.body.issueBlockers?.includes("NEEDS_REVIEW"),
      `${S(stale)} ${S(other)} ${S(pendingHours)} ${S(outside)} v=${v2} review=${S(review)} ${JSON.stringify({ nr: rl?.needs_review, rr: rl?.review_reasons, a: rl?.amount_cents, w: rl?.warnings })} ${g5r.body.issueBlockers}`);

    // D06 Reservations: one live draft per shift; simultaneous attempts → exactly one wins.
    const d2 = (await call("POST", I, adm2.token, { billingClientId: perez, periodFrom: "2026-07-01", periodTo: "2026-08-31" })).body.invoice?.id;
    const d3 = (await call("POST", I, adm.token, { billingClientId: perez, periodFrom: "2026-08-01", periodTo: "2026-08-31" })).body.invoice?.id;
    const dup = await call("POST", `${I}/${d2}/shift-lines`, adm2.token, { expectedVersion: 1, shiftIds: [s1] });
    const [ra, rb] = await Promise.all([
      call("POST", `${I}/${d2}/shift-lines`, adm2.token, { expectedVersion: 1, shiftIds: [s7] }),
      call("POST", `${I}/${d3}/shift-lines`, adm.token, { expectedVersion: 1, shiftIds: [s7] }),
    ]);
    const live7 = (await q<{ n: number }>("SELECT count(*)::int n FROM invoice_shift_claims WHERE shift_id=$1 AND released_at IS NULL", [s7])).rows[0].n;
    const elAfter = await call("GET", `${B(orgA)}/eligible-shifts?billingClientId=${perez}&from=2026-07-01&to=2026-08-31`, adm.token);
    const shown = elAfter.body.shifts?.find((x: Json) => x.shiftId === s1);
    check("D06 a shift already in a draft: 409 SHIFT_ALREADY_RESERVED naming that draft; two administrators at the same time → exactly one 201, one live reservation; the list shows «reserved by» and it is not selectable",
      dup.body.error === "SHIFT_ALREADY_RESERVED" && dup.body.detail?.invoiceId === id1 && [ra.status, rb.status].filter((s) => s === 201).length === 1
        && [ra, rb].some((r) => r.body.error === "SHIFT_ALREADY_RESERVED") && live7 === 1 && shown?.reservedBy?.invoiceId === id1 && shown.selectable === false,
      `${S(dup)} detail=${JSON.stringify(dup.body.detail)} race=${S(ra)},${S(rb)} live=${live7} shown=${JSON.stringify(shown?.reservedBy)}`);

    // D07 Manual and discount lines; anti-evasion.
    const manBase = { expectedVersion: 2, kind: "manual", description: "Transporte a cita", justification: "Acordado con la familia", serviceDate: "2026-08-10", quantityHundredths: 100, unitPriceCents: 3000, taxTreatment: "exempt", taxLegalBasis: "Base legal de prueba (ficticia)" };
    const noJust = await call("POST", `${I}/${id1}/manual-lines`, adm.token, { ...manBase, justification: "" });
    const noTax = await call("POST", `${I}/${id1}/manual-lines`, adm.token, { ...manBase, taxTreatment: undefined });
    const dupShift = await call("POST", `${I}/${id1}/manual-lines`, adm.token, { ...manBase, serviceId: svcHour, careRecipientId: maria, description: "Cuido 4 h" });
    const otherRec = await call("POST", `${I}/${id1}/manual-lines`, adm.token, { ...manBase, careRecipientId: jose });
    const man = await call("POST", `${I}/${id1}/manual-lines`, adm.token, { ...manBase });
    const warn = await call("POST", `${I}/${id1}/manual-lines`, adm.token, { ...manBase, expectedVersion: 3, serviceId: svcHour, careRecipientId: maria, serviceDate: "2026-08-15", description: "Visita breve" });
    const disc = await call("POST", `${I}/${id1}/manual-lines`, adm.token, { ...manBase, expectedVersion: 4, kind: "discount", description: "Descuento por cortesía", quantityHundredths: 100, unitPriceCents: 1000 });
    const g3 = await call("GET", `${I}/${id1}`, adm.token);
    const discLine = g3.body.lines?.find((l: Json) => l.kind === "discount");
    check("D07 manual lines need a justification and an explicit tax choice (400); a manual line can never stand in for a reserved shift (409 MANUAL_LINE_DUPLICATES_SHIFT); resident of another payer 409; valid manual 201; same-day unapproved shift warns; discount is negative; totals $587 + $30 + $30 − $10 = $637",
      noJust.status === 400 && noTax.status === 400 && dupShift.body.error === "MANUAL_LINE_DUPLICATES_SHIFT" && otherRec.body.error === "RECIPIENT_NOT_OF_CLIENT"
        && man.status === 201 && warn.status === 201 && warn.body.warnings?.[0]?.code === "UNAPPROVED_SHIFT_SAME_DAY" && disc.status === 201 && discLine?.amount_cents === -1000
        && g3.body.totals?.subtotalCents === 63700,
      `${S(noJust)} ${S(noTax)} ${S(dupShift)} ${S(otherRec)} ${S(man)} ${S(warn)}:${JSON.stringify(warn.body.warnings)} ${S(disc)} sub=${g3.body.totals?.subtotalCents}`);

    // D08 Remove a line: kept with its reason, reservation released, shift free again.
    let v = g3.body.invoice.version;
    const l3 = g3.body.lines.find((l: Json) => l.shift_id === s3);
    const rem = await call("POST", `${I}/${id1}/lines/${l3.id}/remove`, adm.token, { expectedVersion: v, reason: "Se factura aparte" });
    const claim3 = (await q<{ release_kind: string; release_reason: string }>("SELECT release_kind, release_reason FROM invoice_shift_claims WHERE shift_id=$1 ORDER BY claimed_at", [s3])).rows;
    const kept = (await q<{ removed_at: string | null; remove_reason: string }>("SELECT removed_at, remove_reason FROM invoice_lines WHERE id=$1", [l3.id])).rows[0];
    const reuse = await call("POST", `${I}/${d2}/shift-lines`, adm2.token, { expectedVersion: (await call("GET", `${I}/${d2}`, adm2.token)).body.invoice.version, shiftIds: [s3] });
    check("D08 removing a line keeps it (removed_at + reason), releases its reservation (line_removed, audited) and the shift can go to another draft",
      rem.status === 200 && rem.body.released === 1 && claim3[0]?.release_kind === "line_removed" && claim3[0]?.release_reason === "Se factura aparte" && Boolean(kept?.removed_at) && reuse.status === 201,
      `${S(rem)} ${JSON.stringify(claim3)} kept=${Boolean(kept?.removed_at)} reuse=${S(reuse)}`);

    // D09 Historical and special rates: a client price appears → «rate changed» → recalculated only on request.
    await rate(svcHour, 2600, "2026-01-01", null, { client: perez });
    const g4 = await call("GET", `${I}/${id1}`, adm.token);
    v = g4.body.invoice.version;
    const flagged = g4.body.lines.filter((l: Json) => l.kind === "shift" && l.rateChanged).length;
    const amountsBefore = g4.body.lines.filter((l: Json) => l.kind === "shift").map((l: Json) => l.amount_cents).join();
    const rec = await call("POST", `${I}/${id1}/recalculate`, adm.token, { expectedVersion: v });
    const g5 = await call("GET", `${I}/${id1}`, adm.token);
    const shiftAmounts = g5.body.lines.filter((l: Json) => l.kind === "shift").map((l: Json) => `${l.shift_id === s1 ? "s1" : "s2"}=${l.amount_cents}`).sort().join();
    // s1: 2 h × $26 (client) + 6 h holiday: client has no holiday rate → client normal $26 prevails over general holiday (F1 order) = 2×26 + 6×26 = $208
    // s2: client $26 both days = $208
    check("D09 historical/special rates: a new client price flags both shift lines (amounts unchanged until asked: 27500,21200); «recalculate» re-prices with the client rate (F1 priority: agreed rate over general holiday) → $208 + $208; old lines kept as «Recalculada»",
      flagged === 2 && amountsBefore === "27500,21200" && g4.body.issueBlockers?.includes("RATE_CHANGED") && rec.body.changed === 2 && shiftAmounts === "s1=20800,s2=20800"
        && !g5.body.issueBlockers?.includes("RATE_CHANGED") && g5.body.removedLines?.filter((r: Json) => r.reason === "Recalculada").length === 2,
      `flagged=${flagged} before=${amountsBefore} rec=${S(rec)}:${rec.body.changed} after=${shiftAmounts} blockers=${g5.body.issueBlockers}`);

    // D10 Tax configured by the manager is applied on recalculation; still no issuing.
    await call("POST", `${B(orgA)}/tax`, adm.token, { serviceId: svcHour, treatment: "taxable", rateBasisPoints: 700, validationNote: "Tasa ficticia de prueba", effectiveFrom: "2026-01-01" });
    const ownerEdit = await q("UPDATE finance_service_tax SET rate_basis_points=1 WHERE service_id=$1", [svcHour]).then(() => "updated").catch((e: Error) => e.message);
    const g6a = await call("GET", `${I}/${id1}`, adm.token);
    await call("POST", `${I}/${id1}/recalculate`, adm.token, { expectedVersion: g6a.body.invoice.version });
    const g6 = await call("GET", `${I}/${id1}`, adm.token);
    const pendLeft = g6.body.lines.filter((l: Json) => l.tax_treatment === "pending").length;
    // shift lines taxable 7 %: base 41600 → tax 2912; manual exempt 3000 + manual pending? none; discount exempt -1000
    check("D10 tax treatment versions are immutable (owner too); after the manager sets a (fictitious) rate and the draft is recalculated, shift lines carry it: base $416.00 × 7 % = $29.12; issuing still blocked (ISSUING_NOT_AVAILABLE)",
      /TAX_TREATMENT_IMMUTABLE/.test(ownerEdit) && pendLeft === 0 && g6.body.totals?.taxes?.[0]?.baseCents === 41600 && g6.body.totals?.taxes?.[0]?.taxCents === 2912
        && g6.body.issueBlockers?.includes("ISSUING_NOT_AVAILABLE") && !g6.body.issueBlockers?.includes("TAX_PENDING"),
      `${ownerEdit.slice(0, 40)} pending=${pendLeft} taxes=${JSON.stringify(g6.body.totals?.taxes)} blockers=${g6.body.issueBlockers}`);

    // D11 Discard: releases everything, draft frozen (API and database).
    const gd2 = await call("GET", `${I}/${d2}`, adm2.token);
    const noReason = await call("POST", `${I}/${d2}/discard`, adm2.token, { expectedVersion: gd2.body.invoice.version, reason: "" });
    const disc2 = await call("POST", `${I}/${d2}/discard`, adm2.token, { expectedVersion: gd2.body.invoice.version, reason: "Lo preparo de nuevo" });
    const after2 = await call("POST", `${I}/${d2}/manual-lines`, adm2.token, { ...manBase, expectedVersion: gd2.body.invoice.version + 1 });
    const ownerFrozen = await q("UPDATE invoices SET notes='x', row_version=row_version+1 WHERE id=$1", [d2]).then(() => "updated").catch((e: Error) => e.message);
    const live2 = (await q<{ n: number }>("SELECT count(*)::int n FROM invoice_shift_claims WHERE invoice_id=$1 AND released_at IS NULL", [d2])).rows[0].n;
    check("D11 discard needs a reason (400); discarding releases every reservation (draft_discarded); a discarded draft cannot be edited (API 409 and database, owner too)",
      noReason.status === 400 && disc2.status === 200 && disc2.body.released >= 1 && live2 === 0 && after2.body.error === "INVOICE_NOT_EDITABLE" && /INVOICE_NOT_EDITABLE/.test(ownerFrozen),
      `${S(noReason)} ${S(disc2)}:${disc2.body.released} live=${live2} ${S(after2)} ${ownerFrozen.slice(0, 40)}`);

    // D12 Inactive drafts (14 days): only marked; recovery is manual, audited, version-checked.
    const d4 = (await call("POST", I, adm.token, { billingClientId: perez, periodFrom: "2026-08-01", periodTo: "2026-08-31" })).body.invoice?.id;
    await call("POST", `${I}/${d4}/shift-lines`, adm.token, { expectedVersion: 1, shiftIds: [s9] });
    const early = await call("POST", `${I}/${d4}/recover`, adm.token, { expectedVersion: 2, reason: "Abandonado" });
    await q("ALTER TABLE invoices DISABLE TRIGGER invoices_f22_guard");
    await q("UPDATE invoices SET updated_at = now() - interval '15 days' WHERE id=$1", [d4]);
    await q("ALTER TABLE invoices ENABLE TRIGGER invoices_f22_guard");
    const list = await call("GET", I, adm.token);
    const row4 = list.body.invoices?.find((r: Json) => r.id === d4);
    const stillLive = (await q<{ n: number }>("SELECT count(*)::int n FROM invoice_shift_claims WHERE invoice_id=$1 AND released_at IS NULL", [d4])).rows[0].n;
    const staleRec = await call("POST", `${I}/${d4}/recover`, adm.token, { expectedVersion: 1, reason: "Abandonado" });
    const recov = await call("POST", `${I}/${d4}/recover`, adm.token, { expectedVersion: 2, reason: "Borrador abandonado: libero el turno" });
    const kind4 = (await q<{ release_kind: string }>("SELECT release_kind FROM invoice_shift_claims WHERE invoice_id=$1", [d4])).rows[0]?.release_kind;
    check("D12 a draft is «inactive» after 14 days without changes but keeps its reservation (no automatic release); recovery before 14 days 409; stale version 409; recovery releases (abandoned_recovery) with reason",
      early.body.error === "DRAFT_NOT_INACTIVE" && row4?.inactive === true && stillLive === 1 && staleRec.body.error === "DRAFT_CHANGED" && recov.status === 200 && kind4 === "abandoned_recovery",
      `${S(early)} inactive=${row4?.inactive} live=${stillLive} ${S(staleRec)} ${S(recov)} kind=${kind4}`);

    // D13 Permissions, RLS and isolation.
    const supList = await call("GET", I, sup.token);
    const cgList = await call("GET", I, cg.token);
    const crossGet = await call("GET", `${I}/${id1}`, admB.token);
    const crossB = await call("GET", `${B(orgB)}/invoices/${id1}`, admB.token);
    const centralRows = await asSession<{ n: number }>({ userId: platform.userId, orgId: orgA, superadmin: true }, "SELECT (SELECT count(*) FROM invoices)+(SELECT count(*) FROM invoice_lines)+(SELECT count(*) FROM invoice_shift_claims)+(SELECT count(*) FROM finance_service_tax) n");
    const bRows = await asSession<{ n: number }>({ userId: admB.userId, orgId: orgB }, "SELECT count(*)::int n FROM invoices WHERE organization_id=$1", [orgA]);
    const supRows = await asSession<{ n: number }>({ userId: sup.userId, orgId: orgA }, "SELECT count(*)::int n FROM invoices");
    const delOwner = await q("DELETE FROM invoice_lines WHERE invoice_id=$1", [id1]).then(() => "deleted").catch((e: Error) => e.message);
    const delRuntime = await asSession({ userId: adm.userId, orgId: orgA }, "DELETE FROM invoices WHERE id=$1", [id1]);
    const someLine = (await q<{ id: string }>("SELECT id FROM invoice_lines WHERE invoice_id=$1 AND kind='shift' AND removed_at IS NULL LIMIT 1", [id1])).rows[0].id;
    const forged = await asSession({ userId: adm.userId, orgId: orgA }, "INSERT INTO invoice_shift_claims (organization_id,shift_id,invoice_id,line_id,claimed_by_user_id) VALUES ($1,$2,$3,$4,$5)", [orgA, s8, id1, someLine, adm.userId]);
    const supForge = await asSession({ userId: sup.userId, orgId: orgA }, "INSERT INTO invoices (organization_id,billing_client_id,client_name,period_from,period_to,created_by_user_id,updated_by_user_id) VALUES ($1,$2,'x','2026-08-01','2026-08-02',$3,$3)", [orgA, perez, sup.userId]);
    const editLine = await asSession({ userId: adm.userId, orgId: orgA }, "UPDATE invoice_lines SET amount_cents=1 WHERE id=$1", [someLine]);
    check("D13 supervisor and caregiver 403; another agency cannot read (403/404, 0 rows); ETNARA central reads 0 rows; no DELETE (owner BILLING_NO_DELETE, runtime denied); forged reservation for another shift refused; supervisor cannot insert; amounts cannot be edited",
      supList.status === 403 && cgList.status === 403 && [403, 404].includes(crossGet.status) && crossB.status === 404 && Number(centralRows.rows[0]?.n) === 0 && bRows.rows[0]?.n === 0
        && supRows.rows[0]?.n === 0 && /BILLING_NO_DELETE/.test(delOwner) && Boolean(delRuntime.error) && Boolean(forged.error) && Boolean(supForge.error) && Boolean(editLine.error),
      [S(supList), S(cgList), S(crossGet), S(crossB), centralRows.rows[0]?.n, bRows.rows[0]?.n, supRows.rows[0]?.n, delOwner.slice(0, 25), (delRuntime.error ?? "OK").slice(0, 25), (forged.error ?? "OK").slice(0, 25), (supForge.error ?? "OK").slice(0, 25), (editLine.error ?? "OK").slice(0, 25)].join(" | "));

    // D14 Read-only mode.
    await feat(orgA, "FACTURACION", false, "Fin del piloto");
    const roList = await call("GET", I, adm.token);
    const roGet = await call("GET", `${I}/${id1}`, adm.token);
    const roCreate = await call("POST", I, adm.token, { billingClientId: perez, periodFrom: "2026-08-01", periodTo: "2026-08-31" });
    await feat(orgA, "FACTURACION", true, "Reactivado");
    await feat(orgA, "FINANZAS", false, "Prueba");
    const roFin = await call("POST", I, adm.token, { billingClientId: perez, periodFrom: "2026-08-01", periodTo: "2026-08-31" });
    await feat(orgA, "FINANZAS", true, "Fin de prueba");
    const liveId1 = (await q<{ n: number }>("SELECT count(*)::int n FROM invoice_shift_claims WHERE invoice_id=$1 AND released_at IS NULL", [id1])).rows[0].n;
    check("D14 read-only: with FACTURACION off drafts stay readable (200) and writes are refused (404 at the gate); with FINANZAS off 409 BILLING_READ_ONLY; reservations kept",
      roList.status === 200 && roGet.status === 200 && roCreate.status === 404 && roFin.body.error === "BILLING_READ_ONLY" && liveId1 === 2,
      `${S(roList)} ${S(roGet)} ${S(roCreate)} ${S(roFin)} live=${liveId1}`);

    // D15 Audit.
    const ev = (await q<{ action: string }>("SELECT DISTINCT action FROM finance_events WHERE action LIKE 'FINANCE_BILLING_%'")).rows.map((r) => r.action);
    const need = ["DRAFT_CREATED", "DRAFT_UPDATED", "LINE_ADDED", "LINE_REMOVED", "LINE_RECALCULATED", "SHIFT_RESERVED", "RESERVATION_RELEASED", "DRAFT_DISCARDED", "DRAFT_RECOVERED", "TAX_TREATMENT_SET"].map((a) => `FINANCE_BILLING_${a}`);
    const upd = await call("PATCH", `${I}/${id1}`, adm.token, { expectedVersion: (await call("GET", `${I}/${id1}`, adm.token)).body.invoice.version, notes: "Revisado" });
    const ev2 = (await q<{ action: string }>("SELECT DISTINCT action FROM finance_events WHERE action LIKE 'FINANCE_BILLING_%'")).rows.map((r) => r.action);
    const au = await q<{ new_value: Json | null }>("SELECT new_value FROM audit_log WHERE action LIKE 'FINANCE_BILLING_%'");
    const supAudit = await asSession<{ n: number }>({ userId: sup.userId, orgId: orgA }, "SELECT count(*)::int n FROM audit_log WHERE action LIKE 'FINANCE_BILLING_%'");
    check("D15 audit: finance_events records every draft, line, reservation, release, discard, recovery and tax action; audit_log identifiers only, hidden from the supervisor",
      upd.status === 200 && need.every((a) => ev2.includes(a)) && au.rows.every((r) => !MONEY.test(JSON.stringify(r.new_value ?? {}))) && supAudit.rows[0]?.n === 0,
      `missing=${need.filter((a) => !ev2.includes(a))} before=${ev.length} audit=${au.rows.length} sup=${supAudit.rows[0]?.n}`);

    // D16 No issuing in F2.2.
    const issueRoute = await call("POST", `${I}/${id1}/issue`, adm.token, { expectedVersion: 1 });
    const ownerIssue = await q("UPDATE invoices SET status='issued', row_version=row_version+1 WHERE id=$1", [id1]).then(() => "updated").catch((e: Error) => e.message);
    check("D16 no invoice can be issued in F2.2: no issue route (404) and the database only allows draft/discarded (owner refused)",
      issueRoute.status === 404 && /invoices_status_check|violates check/.test(ownerIssue), `${S(issueRoute)} ${ownerIssue.slice(0, 60)}`);

    // D17 Regressions: Finanzas F1 untouched.
    const finA = await call("GET", `/organizations/${orgA}/finance/services`, adm.token);
    const shiftFin = await call("GET", `/organizations/${orgA}/shifts/${s3}/finance`, adm.token);
    const lockedPut = await call("PUT", `/organizations/${orgA}/shifts/${s3}/finance`, adm.token, { serviceId: svcDay, note: null });
    check("D17 Finanzas F1 works as before: services 200, shift finance 200 with approved minutes, approved shift still locked (409)",
      finA.status === 200 && shiftFin.status === 200 && shiftFin.body.effective?.minutesSource === "approved_timesheet" && lockedPut.status === 409,
      `${S(finA)} ${S(shiftFin)} ${S(lockedPut)}`);

    const fives = all.filter((r) => r.status === 500);
    check("D18 no 500 in the whole run", fives.length === 0, fives.map((r) => JSON.stringify(r.body)).join(" "));
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
    await runtime.end();
    await db.end();
  }

  console.log("\nETNARA Facturación F2.2 — drafts, reservations, overnight segments, security\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nBilling F2.2: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Billing F2.2 verification failed:", error);
  process.exit(1);
});
