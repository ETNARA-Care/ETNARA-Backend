/**
 * F0.1 · Hogares «Horas del personal» (decisión de Rafa, opción A, 25-nov-2026). Datos FICTICIOS, base PROPIA desechable,
 * aplicación real por HTTP como app_runtime. Ningún correo real (Resend interceptado), ninguna salida de red.
 *
 *   En un hogar: aprobación de horas, tarifa de PAGO del personal y pago ESTIMADO por periodo; sin tarifa ni importes
 *   de facturación (no se aceptan, se guardan en 0 y se devuelven como null), sin deducciones, contribuciones ni nómina.
 *   Agencias: exactamente igual que antes (tarifa de facturación obligatoria e importes visibles). Independientes: el
 *   módulo sigue cerrado por la modalidad (160).
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const serverUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!serverUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(serverUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 1200) });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  if (!/^https?:\/\/127\.0\.0\.1:/.test(url)) throw new Error(`Salida de red bloqueada en la prueba: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";
process.env.EMAIL_SENDER_ADDRESS ??= "pruebas@example.invalid";
process.env.ACTIVATION_BASE_URL ??= "https://portal.example.invalid";

const FORBIDDEN_KEYS = /(deduction|deducci|tax|impuesto|contribution|contribuci|payroll|nomina|nómina|withholding|retenci)/i;
const keysOf = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) { for (const x of v) keysOf(x, out); return out; }
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); }
  return out;
};

async function main() {
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  const name = `etnara_staffhours_${randomBytes(4).toString("hex")}`;
  await srv.query(`CREATE DATABASE ${name}`);
  const su = new URL(serverUrl!); su.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: su.toString() }); await db.connect();
  { const log = console.log; console.log = () => undefined; try { await applyPendingMigrations(db, join(process.cwd(), "migrations")); } finally { console.log = log; } }
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const rt = new URL(su.toString()); rt.username = "app_runtime"; rt.password = runtimePassword;
  process.env.DATABASE_URL = rt.toString();

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const errors500: string[] = [];
  const call = async (method: string, path: string, token: string, body?: Json) => {
    const res = await realFetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json: Json = {}; try { json = JSON.parse(await res.text()); } catch { /* vacío */ }
    if (res.status >= 500) errors500.push(`${method} ${path} ${res.status} ${json.error ?? ""}`);
    return { status: res.status, body: json };
  };
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toLowerCase();
  const org = async (n: string, t: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2,'active') RETURNING id`, [n, t])).rows[0].id;
  type P = { userId: string; token: string; owm?: string };
  const person = async (orgId: string, key: string, roles: string[], worker = false): Promise<P> => {
    const email = `sh-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let owm: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Ficticia ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
    }
    const t = (await call("POST", "/auth/login", "", { email, password })).body.token as string;
    await call("POST", "/me/active-organization", t, { organizationId: orgId });
    return { userId, token: t, owm };
  };
  // Hoja de tiempo ficticia (pendiente, o aprobada «antigua» con facturación de antes de F0.1).
  const timesheet = async (orgId: string, who: P, admin: P, start: string, minutes: number, legacyApproved = false, billSnapshot: number | null = null) => {
    const rec = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Residente','Ficticio') RETURNING id`, [orgId])).rows[0].id;
    const end = new Date(new Date(start).getTime() + minutes * 60_000).toISOString();
    const shift = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,$3,$4,'confirmed') RETURNING id`, [orgId, rec, start, end])).rows[0].id;
    const a = (await q<{ id: string }>(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,response_status,responded_at) VALUES ($1,$2,$3,$4,'accepted',now()) RETURNING id`, [orgId, shift, who.owm, rec])).rows[0].id;
    return (await q<{ id: string }>(`INSERT INTO timesheets (organization_id,shift_id,assignment_id,organization_worker_membership_id,care_recipient_id,check_in_at,check_out_at,recorded_minutes,
        approved_minutes,pay_rate_cents_snapshot,bill_rate_cents_snapshot,pay_amount_cents,bill_amount_cents,status,reviewed_by_user_id,reviewed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`, legacyApproved
      ? [orgId, shift, a, who.owm, rec, start, end, minutes, minutes, 1500, 2500, Math.round(minutes * 1500 / 60), Math.round(minutes * 2500 / 60), "approved", admin.userId, new Date()]
      : [orgId, shift, a, who.owm, rec, start, end, minutes, null, null, billSnapshot, null, null, "pending", null, null])).rows[0].id;
  };

  const H = await org(`Hogar Ficticio ${tag}`, "RESIDENTIAL_CARE_HOME"), A = await org(`Agencia Ficticia ${tag}`, "HOME_CARE_AGENCY");
  await q(`SELECT app_ops_authorize_modality_activation('INDEPENDENT_PROVIDER','verificador local','Prueba local con datos ficticios (163: candado)',5)`);
  await q(`UPDATE platform_modalities SET enabled=true WHERE code='INDEPENDENT_PROVIDER'`);
  const I = await org(`Independiente Ficticia ${tag}`, "INDEPENDENT_PROVIDER");
  await q(`UPDATE platform_modalities SET enabled=false WHERE code='INDEPENDENT_PROVIDER'`);
  const adminH = await person(H, "admin-h", ["ORGANIZATION_ADMIN"]), supH = await person(H, "sup-h", ["SUPERVISOR"]), wH = await person(H, "worker-h", ["WORKER"], true);
  const adminA = await person(A, "admin-a", ["ORGANIZATION_ADMIN"]), wA = await person(A, "worker-a", ["WORKER"], true);
  const adminI = await person(I, "admin-i", ["ORGANIZATION_ADMIN"]);
  const P = (o: string) => `/organizations/${o}`;

  // ---- Hogar ------------------------------------------------------------------------------------------------
  const withBill = await call("PUT", `${P(H)}/financial-rates/${wH.owm}`, adminH.token, { payRateCents: 1500, billRateCents: 2500 });
  const noRowYet = (await q(`SELECT 1 FROM worker_financial_rates WHERE organization_worker_membership_id=$1`, [wH.owm])).rowCount === 0;
  check("H1. Hogar: una tarifa de facturación se rechaza (409 RESIDENTIAL_BILLING_NOT_AVAILABLE) y no se guarda nada", withBill.status === 409 && withBill.body.error === "RESIDENTIAL_BILLING_NOT_AVAILABLE" && noRowYet, withBill);
  const payOnly = await call("PUT", `${P(H)}/financial-rates/${wH.owm}`, adminH.token, { payRateCents: 1500 });
  const zeroBill = await call("PUT", `${P(H)}/financial-rates/${wH.owm}`, adminH.token, { payRateCents: 1600, billRateCents: 0 });
  const stored = (await q<{ pay: number; bill: number }>(`SELECT pay_rate_cents pay, bill_rate_cents bill FROM worker_financial_rates WHERE organization_worker_membership_id=$1`, [wH.owm])).rows[0];
  check("H2. Hogar: solo la tarifa de pago se guarda (200); la de facturación queda en 0 en la base y null en la respuesta", payOnly.status === 200 && payOnly.body.rate?.bill_rate_cents === null && zeroBill.status === 200 && stored.pay === 1600 && stored.bill === 0, [payOnly.status, payOnly.body.rate, zeroBill.status, stored]);
  // Datos «antiguos» de antes de F0.1: una tarifa de facturación guardada y una hoja aprobada con facturación.
  await q(`UPDATE worker_financial_rates SET bill_rate_cents=2500 WHERE organization_worker_membership_id=$1`, [wH.owm]);
  const ratesH = await call("GET", `${P(H)}/financial-rates`, adminH.token);
  check("H3. Hogar: la lista de tarifas nunca devuelve la de facturación (null), aunque haya un valor antiguo", ratesH.status === 200 && ratesH.body.rates.length >= 1 && ratesH.body.rates.every((r: Json) => r.bill_rate_cents === null) && ratesH.body.rates.some((r: Json) => r.pay_rate_cents === 1600), ratesH.body.rates);
  const legacy = await timesheet(H, wH, adminH, "2026-11-02T13:00:00Z", 120, true);
  const pending = await timesheet(H, wH, adminH, "2026-11-03T13:00:00Z", 240, false, 2500);
  const review = await call("POST", `${P(H)}/timesheets/${pending}/review`, adminH.token, { decision: "approved" });
  const reviewed = (await q<{ bill: number; billsnap: number; pay: number }>(`SELECT bill_amount_cents bill, bill_rate_cents_snapshot billsnap, pay_amount_cents pay FROM timesheets WHERE id=$1`, [pending])).rows[0];
  check("H4. Hogar: aprobar horas solo exige la tarifa de pago; el pago estimado se calcula y la facturación queda en 0 (null en la respuesta)",
    review.status === 200 && review.body.timesheet?.bill_amount_cents === null && review.body.timesheet?.pay_amount_cents === 6400 && reviewed.bill === 0 && reviewed.billsnap === 0 && reviewed.pay === 6400, [review.status, review.body.timesheet?.pay_amount_cents, reviewed]);
  const listH = await call("GET", `${P(H)}/timesheets?dateFrom=2026-11-01&dateTo=2026-11-30`, adminH.token);
  check("H5. Hogar: la lista de horas muestra horas y pago, nunca facturación (también la hoja antigua)", listH.status === 200 && listH.body.timesheets.length === 2
    && listH.body.timesheets.every((t: Json) => t.bill_amount_cents === null && t.bill_rate_cents_snapshot === null) && listH.body.summary.approvedBillCents === null && listH.body.summary.approvedPayCents === 6400 + 3000, listH.body.summary);
  const prevH = await call("GET", `${P(H)}/pay-periods/preview?dateFrom=2026-11-01&dateTo=2026-11-30&cadence=custom`, adminH.token);
  check("H6. Hogar: el resumen del periodo trae horas y pago estimado; la facturación es null", prevH.status === 200 && prevH.body.summary.billAmountCents === null && prevH.body.summary.payAmountCents === 9400
    && prevH.body.workers.every((w: Json) => w.billAmountCents === null), prevH.body.summary);
  const closeH = await call("POST", `${P(H)}/pay-periods/close`, adminH.token, { dateFrom: "2026-11-01", dateTo: "2026-11-30", cadence: "custom" });
  const periodDb = (await q<{ bill: number; pay: number; lines_bill: number }>(`SELECT p.bill_amount_cents bill, p.pay_amount_cents pay, (SELECT coalesce(sum(bill_amount_cents),0)::int FROM pay_period_timesheets WHERE pay_period_id=p.id) lines_bill FROM pay_periods p WHERE p.organization_id=$1`, [H])).rows[0];
  const periodsH = await call("GET", `${P(H)}/pay-periods`, adminH.token);
  check("H7. Hogar: cerrar el periodo guarda horas y pago; la facturación se guarda en 0 (también de la hoja antigua) y se devuelve como null",
    closeH.status === 201 && closeH.body.period?.bill_amount_cents === null && periodDb?.bill === 0 && periodDb.lines_bill === 0 && periodDb.pay === 9400
    && periodsH.status === 200 && periodsH.body.periods.every((p: Json) => p.bill_amount_cents === null), [closeH.status, closeH.body.period, periodDb]);
  const allKeys = [ratesH, listH, prevH, closeH, periodsH, review, payOnly].flatMap((r) => keysOf(r.body));
  const bad = [...new Set(allKeys.filter((k) => FORBIDDEN_KEYS.test(k)))];
  check("H8. Hogar: ninguna respuesta tiene deducciones, impuestos, contribuciones, retenciones ni nómina", bad.length === 0, bad);
  const sup = await call("GET", `${P(H)}/financial-rates`, supH.token), supT = await call("GET", `${P(H)}/timesheets?dateFrom=2026-11-01&dateTo=2026-11-30`, supH.token);
  check("H9. Hogar: la supervisora sigue sin acceso (solo administración), como antes", sup.status === 403 && supT.status === 403, [sup.status, supT.status]);
  const billing = await call("GET", `${P(H)}/billing/invoices`, adminH.token), finance = await call("GET", `${P(H)}/finance/services`, adminH.token);
  check("H10. Hogar: la facturación a familias y Finanzas siguen cerradas (403 MODALITY_NOT_AVAILABLE)", billing.status === 403 && billing.body.error === "MODALITY_NOT_AVAILABLE" && finance.status === 403 && finance.body.error === "MODALITY_NOT_AVAILABLE", [billing.status, finance.status]);

  // ---- Revisión GPT (25-nov): check-out con una tarifa antigua y personas con el mismo nombre -------------------
  // H12: el check-out real (app_record_timesheet_from_checkout, 114) copia la tarifa vigente en la hoja pendiente.
  // Con una tarifa de facturación antigua (2500, de antes de F0.1) esa copia queda guardada en la hoja pendiente,
  // pero nunca se devuelve ni se usa: al aprobar se sustituye por 0 y el cierre guarda 0.
  const { withTenantContext } = await import("../src/context/tenantContext.js");
  const { recordTimesheetFromCheckout } = await import("../src/modules/timesheets/timesheets.service.js");
  const recCo = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Residente','Ficticio') RETURNING id`, [H])).rows[0].id;
  const shiftCo = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,'2026-12-02T13:00:00Z','2026-12-02T16:00:00Z','confirmed') RETURNING id`, [H, recCo])).rows[0].id;
  await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,response_status,responded_at) VALUES ($1,$2,$3,$4,'accepted',now())`, [H, shiftCo, wH.owm, recCo]);
  const legacyRate = (await q<{ bill: number }>(`SELECT bill_rate_cents bill FROM worker_financial_rates WHERE organization_worker_membership_id=$1`, [wH.owm])).rows[0];
  await withTenantContext({ userId: wH.userId, organizationId: H }, (trx) => recordTimesheetFromCheckout(trx, { actorUserId: wH.userId, organizationId: H, shiftId: shiftCo, membershipId: wH.owm!, checkInAt: "2026-12-02T13:00:00Z", checkOutAt: "2026-12-02T16:00:00Z" }));
  const coRow = (await q<{ id: string; billsnap: number | null; paysnap: number | null }>(`SELECT id, bill_rate_cents_snapshot billsnap, pay_rate_cents_snapshot paysnap FROM timesheets WHERE shift_id=$1`, [shiftCo])).rows[0];
  const coList = await call("GET", `${P(H)}/timesheets?dateFrom=2026-12-01&dateTo=2026-12-05`, adminH.token);
  const coReview = await call("POST", `${P(H)}/timesheets/${coRow?.id}/review`, adminH.token, { decision: "approved" });
  const coAfter = (await q<{ billsnap: number; bill: number; pay: number }>(`SELECT bill_rate_cents_snapshot billsnap, bill_amount_cents bill, pay_amount_cents pay FROM timesheets WHERE id=$1`, [coRow?.id])).rows[0];
  const coClose = await call("POST", `${P(H)}/pay-periods/close`, adminH.token, { dateFrom: "2026-12-01", dateTo: "2026-12-05", cadence: "custom" });
  const coLines = (await q<{ bill: number }>(`SELECT coalesce(sum(ppt.bill_amount_cents),0)::int bill FROM pay_period_timesheets ppt WHERE ppt.timesheet_id=$1`, [coRow?.id])).rows[0];
  check("H12. Hogar: el check-out real con una tarifa de facturación antigua (2500) la copia en la hoja pendiente, pero no se devuelve; al aprobar queda en 0 y el cierre guarda 0",
    legacyRate?.bill === 2500 && coRow?.paysnap === 1600 && coList.status === 200 && coList.body.timesheets.length === 1 && coList.body.timesheets[0].bill_rate_cents_snapshot === null
    && coReview.status === 200 && coAfter?.billsnap === 0 && coAfter.bill === 0 && coAfter.pay === 4800 && coClose.status === 201 && coLines?.bill === 0,
    [legacyRate, coRow, coList.body.timesheets?.[0]?.bill_rate_cents_snapshot, coReview.status, coAfter, coClose.status, coLines]);
  // H11: dos personas del hogar con el mismo nombre no se suman en el resumen del periodo.
  const twin1 = await person(H, "twin1-h", ["WORKER"], true), twin2 = await person(H, "twin2-h", ["WORKER"], true);
  await q(`UPDATE workers SET display_name='Ana Homónima' WHERE user_id = ANY($1)`, [[twin1.userId, twin2.userId]]);
  await call("PUT", `${P(H)}/financial-rates/${twin1.owm}`, adminH.token, { payRateCents: 1000 });
  await call("PUT", `${P(H)}/financial-rates/${twin2.owm}`, adminH.token, { payRateCents: 2000 });
  for (const [who, start] of [[twin1, "2026-12-10T13:00:00Z"], [twin2, "2026-12-11T13:00:00Z"]] as const) {
    const id = await timesheet(H, who, adminH, start, 60);
    await call("POST", `${P(H)}/timesheets/${id}/review`, adminH.token, { decision: "approved" });
  }
  const twinPrev = await call("GET", `${P(H)}/pay-periods/preview?dateFrom=2026-12-09&dateTo=2026-12-31&cadence=custom`, adminH.token);
  const twins = (twinPrev.body.workers ?? []).filter((w: Json) => w.workerName === "Ana Homónima");
  check("H11. Hogar: dos personas con el mismo nombre salen por separado en el resumen (por membresía), cada una con su pago estimado",
    twinPrev.status === 200 && twins.length === 2 && new Set(twins.map((w: Json) => w.membershipId)).size === 2
    && twins.some((w: Json) => w.membershipId === twin1.owm && w.payAmountCents === 1000) && twins.some((w: Json) => w.membershipId === twin2.owm && w.payAmountCents === 2000)
    && twins.every((w: Json) => w.billAmountCents === null), twinPrev.body.workers);

  // ---- Agencia (sin cambios) --------------------------------------------------------------------------------
  const aNoBill = await call("PUT", `${P(A)}/financial-rates/${wA.owm}`, adminA.token, { payRateCents: 1500 });
  const aBoth = await call("PUT", `${P(A)}/financial-rates/${wA.owm}`, adminA.token, { payRateCents: 1500, billRateCents: 2500 });
  check("A1. Agencia: la tarifa de facturación sigue siendo obligatoria (400) y se guarda y se ve como antes", aNoBill.status === 400 && aNoBill.body.error === "INVALID_FINANCIAL_RATE_REQUEST" && aBoth.status === 200 && aBoth.body.rate?.bill_rate_cents === 2500, [aNoBill, aBoth.body.rate]);
  const aTs = await timesheet(A, wA, adminA, "2026-11-04T13:00:00Z", 120);
  const aRev = await call("POST", `${P(A)}/timesheets/${aTs}/review`, adminA.token, { decision: "approved" });
  const aPrev = await call("GET", `${P(A)}/pay-periods/preview?dateFrom=2026-11-01&dateTo=2026-11-30&cadence=custom`, adminA.token);
  const aClose = await call("POST", `${P(A)}/pay-periods/close`, adminA.token, { dateFrom: "2026-11-01", dateTo: "2026-11-30", cadence: "custom" });
  const aList = await call("GET", `${P(A)}/timesheets?dateFrom=2026-11-01&dateTo=2026-11-30`, adminA.token);
  check("A2. Agencia: aprobar, resumir y cerrar el periodo calculan pago y facturación como siempre",
    aRev.status === 200 && aRev.body.timesheet?.bill_amount_cents === 5000 && aPrev.body.summary.billAmountCents === 5000 && aClose.status === 201 && aClose.body.period?.bill_amount_cents === 5000
    && aList.body.summary.approvedBillCents === 5000 && aList.body.timesheets[0].bill_rate_cents_snapshot === 2500, [aRev.body.timesheet?.bill_amount_cents, aPrev.body.summary, aClose.body.period]);

  // A3: también en la agencia, dos personas con el mismo nombre ya no se suman (antes se agrupaba por el nombre).
  const aTwin1 = await person(A, "twin1-a", ["WORKER"], true), aTwin2 = await person(A, "twin2-a", ["WORKER"], true);
  await q(`UPDATE workers SET display_name='Beto Homónimo' WHERE user_id = ANY($1)`, [[aTwin1.userId, aTwin2.userId]]);
  await call("PUT", `${P(A)}/financial-rates/${aTwin1.owm}`, adminA.token, { payRateCents: 1000, billRateCents: 1500 });
  await call("PUT", `${P(A)}/financial-rates/${aTwin2.owm}`, adminA.token, { payRateCents: 2000, billRateCents: 3000 });
  for (const [who, start] of [[aTwin1, "2026-12-10T13:00:00Z"], [aTwin2, "2026-12-11T13:00:00Z"]] as const) {
    const id = await timesheet(A, who, adminA, start, 60);
    await call("POST", `${P(A)}/timesheets/${id}/review`, adminA.token, { decision: "approved" });
  }
  const aTwinPrev = await call("GET", `${P(A)}/pay-periods/preview?dateFrom=2026-12-09&dateTo=2026-12-31&cadence=custom`, adminA.token);
  const aTwins = (aTwinPrev.body.workers ?? []).filter((w: Json) => w.workerName === "Beto Homónimo");
  check("A3. Agencia: dos personas con el mismo nombre salen por separado, con su pago y su facturación; el total no cambia",
    aTwinPrev.status === 200 && aTwins.length === 2 && aTwins.some((w: Json) => w.payAmountCents === 1000 && w.billAmountCents === 1500) && aTwins.some((w: Json) => w.payAmountCents === 2000 && w.billAmountCents === 3000)
    && aTwinPrev.body.summary.payAmountCents === 3000 && aTwinPrev.body.summary.billAmountCents === 4500, aTwinPrev.body);

  // ---- Independiente (sin cambios: el módulo sigue cerrado por la modalidad) --------------------------------
  const iRates = await call("GET", `${P(I)}/financial-rates`, adminI.token), iPeriods = await call("GET", `${P(I)}/pay-periods`, adminI.token);
  check("I1. Independiente: tarifas y periodos siguen cerrados (403 MODALITY_NOT_AVAILABLE)", iRates.status === 403 && iRates.body.error === "MODALITY_NOT_AVAILABLE" && iPeriods.status === 403, [iRates.status, iPeriods.status]);
  const cross = await call("GET", `${P(H)}/financial-rates`, adminA.token);
  check("I2. Aislamiento: una agencia no ve las tarifas del hogar (403)", cross.status === 403, cross.status);

  check("Z. Ninguna respuesta 500", errors500.length === 0, errors500);
  server.close(); await pool.end(); await db.end();
  await srv.query(`DROP DATABASE ${name} WITH (FORCE)`); await srv.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.check}${r.pass ? "" : `\n      ${r.detail}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
