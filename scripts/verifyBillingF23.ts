/**
 * ETNARA Facturación Premium F2.3 (migration 127) — invoice profile, issuing with
 * consecutive numbers (concurrency, injected storage failure, no gaps), frozen
 * copy and immutability, private PDF in a LOCAL S3 (moto, never a hosted
 * service), downloads with integrity check, void with reason, holiday guard,
 * D9 caregiver name off by default, permissions, isolation, read-only, audit.
 * Synthetic data only (.invalid e-mails).
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 *   optional: BILLING_TEST_S3_PORT (default 4569), PHOTO_TEST_PYTHON (python with moto[server])
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { spawn, type ChildProcess } from "node:child_process";
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });

async function main() {
  // Local private S3 (moto). Nothing leaves this machine.
  const s3Port = Number(process.env.BILLING_TEST_S3_PORT ?? 4569);
  const moto: ChildProcess = spawn(process.env.PHOTO_TEST_PYTHON ?? "python3", ["-m", "moto.server", "-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
  const endpoint = `http://127.0.0.1:${s3Port}`;
  let up = false;
  for (let i = 0; i < 360; i++) { try { await fetch(endpoint); up = true; break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  if (!up) { console.log("Local S3 (moto) did not start"); moto.kill(); process.exit(1); }
  const bucket = `etnara-billing-test-${randomBytes(4).toString("hex")}`;
  const objStore = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  await objStore.send(new CreateBucketCommand({ Bucket: bucket }));
  Object.assign(process.env, {
    BILLING_STORAGE_ENDPOINT: endpoint, BILLING_STORAGE_REGION: "us-east-1", BILLING_STORAGE_BUCKET: bucket,
    BILLING_STORAGE_ACCESS_KEY_ID: "test", BILLING_STORAGE_SECRET_ACCESS_KEY: "test", BILLING_STORAGE_FORCE_PATH_STYLE: "true",
  });
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
    const email = `f23-${key}-${tag}@example.invalid`;
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

  const orgA = await agency("F23 A", true);
  const orgB = await agency("F23 B", true);
  const orgC = await agency("F23 C", false);
  const adm = await person(orgA, "admin", ["ORGANIZATION_ADMIN"]);
  const sup = await person(orgA, "supervisor", ["SUPERVISOR"]);
  const cg = await person(orgA, "cg", ["WORKER"], true);
  const admB = await person(orgB, "adminb", ["ORGANIZATION_ADMIN"]);
  const admC = await person(orgC, "adminc", ["ORGANIZATION_ADMIN"]);
  // ETNARA central: platform administrator with no agency membership.
  const platformEmail = `f23-central-${tag}@example.invalid`;
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
  const recipient = async (org: string, first: string) => (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,$2,$3,'active') RETURNING id`, [org, first, `F23-${tag}`])).rows[0].id;
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

  void s4; void s5; void s6; void s7; void s9; void svcDay; void otro; void admC;
  const extra: string[] = [];
  for (let d = 1; d <= 12; d++) extra.push(await shift(maria, `2026-08-${String(d).padStart(2, "0")}T09:00:00-04:00`, 240, "approved"));
  const sNew = await shift(maria, "2026-08-25T09:00:00-04:00", 240, "approved");
  const SET = `${B(orgA)}/settings`;
  const pdfText = (buf: Buffer) => {
    // pdfkit writes text as hex strings in TJ arrays; decode every <hex> run (WinAnsi ≈ Latin-1).
    const raw = buf.toString("latin1");
    return raw + [...raw.matchAll(/<([0-9a-fA-F]{2,})>/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1")).join("");
  };
  const draftWith = async (who: P, shiftIds: string[]) => {
    const id = (await call("POST", I, who.token, { billingClientId: perez, periodFrom: "2026-07-01", periodTo: "2026-08-31" })).body.invoice?.id;
    if (shiftIds.length) await call("POST", `${I}/${id}/shift-lines`, who.token, { expectedVersion: 1, shiftIds });
    return id as string;
  };
  const version = async (id: string) => (await call("GET", `${I}/${id}`, adm.token)).body.invoice?.version as number;
  const issue = async (who: P, id: string) => call("POST", `${I}/${id}/issue`, who.token, { expectedVersion: await version(id) });
  const objects = async () => (await objStore.send(new ListObjectsV2Command({ Bucket: bucket }))).Contents ?? [];

  try {
    // E01 Settings: nothing preloaded; issuing blocked until configured and tax configuration validated.
    const st0 = await call("GET", SET, adm.token);
    const supSt = await call("GET", SET, sup.token);
    const draftOnlyPut = await call("PUT", SET, adm2.token, { legalName: "Intento" });
    check("E01 settings start empty (no name, tax configuration NOT validated, prefix FAC, counter 1); blockers SETTINGS_INCOMPLETE + TAX_CONFIG_NOT_VALIDATED; supervisor 403; only the permissions manager edits (draft-only 403)",
      st0.status === 200 && st0.body.settings?.legalName === null && st0.body.settings?.taxValidatedAt === null && st0.body.series?.prefix === "FAC" && st0.body.series?.nextNumber === 1
        && st0.body.blockers?.includes("SETTINGS_INCOMPLETE") && st0.body.blockers?.includes("TAX_CONFIG_NOT_VALIDATED") && st0.body.storageConfigured === true
        && supSt.status === 403 && draftOnlyPut.status === 403,
      `${S(st0)} ${JSON.stringify(st0.body.blockers)} sup=${S(supSt)} draftOnly=${S(draftOnlyPut)}`);

    // E02 Issue refused while blocked; no number consumed; only billing.issue may try.
    const d1 = await draftWith(adm, [s1, s2, s3]);
    const blocked = await issue(adm, d1);
    const draftOnlyIssue = await issue(adm2, d1);
    const series0 = (await q<{ n: number }>("SELECT count(*)::int n FROM invoice_series WHERE organization_id=$1", [orgA])).rows[0].n;
    check("E02 issuing is refused while blocked (409 ISSUE_BLOCKED listing settings, tax validation and pending tax); a draft-only administrator 403; no number consumed (no counter row)",
      blocked.status === 409 && blocked.body.error === "ISSUE_BLOCKED" && ["SETTINGS_INCOMPLETE", "TAX_CONFIG_NOT_VALIDATED", "TAX_PENDING"].every((b) => blocked.body.detail?.blockers?.includes(b))
        && draftOnlyIssue.status === 403 && series0 === 0,
      `${S(blocked)} ${JSON.stringify(blocked.body.detail)} draftOnly=${S(draftOnlyIssue)} series=${series0}`);

    // E03 Logo: PNG/JPEG only, ≤ 300 KB, re-encoded without metadata.
    const rawCall = async (path: string, token: string, body: Buffer, type: string) => {
      resetFeatureWriteLimitForTests();
      const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": type, Authorization: `Bearer ${token}` }, body: new Uint8Array(body) });
      const out = { status: res.status, body: await res.json().catch(() => ({})) as Json }; all.push(out); return out;
    };
    const png = await sharp({ create: { width: 400, height: 160, channels: 3, background: "#16213D" } }).png().toBuffer();
    const notImage = await rawCall(`${SET}/logo`, adm.token, Buffer.from("%PDF-1.4 not an image"), "image/png");
    const big = await rawCall(`${SET}/logo`, adm.token, Buffer.concat([png, Buffer.alloc(320 * 1024)]), "image/png");
    const supLogo = await rawCall(`${SET}/logo`, sup.token, png, "image/png");
    const logo = await rawCall(`${SET}/logo`, adm.token, png, "image/png");
    const logoGet = await fetch(`${base}${SET}/logo`, { headers: { Authorization: `Bearer ${adm.token}` } });
    const logoBytes = Buffer.from(await logoGet.arrayBuffer());
    check("E03 logo: not an image 415; over 300 KB 413; supervisor 403; valid PNG 201 stored re-encoded in the private bucket and served back (PNG, no-store)",
      notImage.status === 415 && [413].includes(big.status) && supLogo.status === 403 && logo.status === 201 && logoGet.status === 200
        && logoBytes.subarray(1, 4).toString() === "PNG" && logoGet.headers.get("cache-control") === "private, no-store",
      `${S(notImage)} ${S(big)} ${S(supLogo)} ${S(logo)} get=${logoGet.status} ${logoGet.headers.get("cache-control")}`);

    // E04 Configure: profile, prefix, tax treatment and the validation (with a note).
    const put = await call("PUT", SET, adm.token, { legalName: "Cuidado en Casa Demo, LLC (ficticia)", address: "Calle Falsa 123, San Juan, PR", phone: "787-000-0000", merchantRegistration: "000-ficticio", paymentTerms: "15 días", footerNote: "Gracias por confiar en nosotros.", prefix: "CS" });
    const noNote = await call("POST", `${SET}/tax-validation`, adm.token, { validated: true });
    const valid = await call("POST", `${SET}/tax-validation`, adm.token, { validated: true, note: "Validado con CPA (prueba ficticia)" });
    await call("POST", `${B(orgA)}/tax`, adm.token, { serviceId: svcHour, treatment: "exempt", legalBasis: "Base legal de prueba (ficticia)", effectiveFrom: "2026-01-01" });
    await call("POST", `${I}/${d1}/recalculate`, adm.token, { expectedVersion: await version(d1) });
    const st1 = await call("GET", SET, adm.token);
    check("E04 the manager saves the profile and prefix «CS»; tax validation needs a note (400) and then records who and when; no agency blockers left",
      put.status === 200 && noNote.status === 400 && valid.status === 200 && st1.body.settings?.legalName?.startsWith("Cuidado en Casa Demo") && st1.body.series?.prefix === "CS"
        && st1.body.settings?.taxValidatedBy?.includes("@example.invalid") && st1.body.blockers?.length === 0,
      `${S(put)} ${S(noNote)} ${S(valid)} ${JSON.stringify(st1.body.blockers)} prefix=${st1.body.series?.prefix}`);

    // E05 Issue: consecutive number, frozen copy, private PDF with matching SHA-256.
    const ok1 = await issue(adm, d1);
    const g1 = await call("GET", `${I}/${d1}`, adm.token);
    const doc1 = (await q<{ object_key: string; sha256: string; size_bytes: number }>("SELECT object_key, sha256, size_bytes FROM invoice_documents WHERE invoice_id=$1 AND kind='original'", [d1])).rows[0];
    const obj1 = doc1 ? Buffer.from(await (await objStore.send(new GetObjectCommand({ Bucket: bucket, Key: doc1.object_key }))).Body!.transformToByteArray()) : Buffer.alloc(0);
    const sha = (await import("node:crypto")).createHash("sha256").update(obj1).digest("hex");
    const txt1 = pdfText(obj1);
    const inv1 = (await q<{ retention_until: string; issue_date: string; issuer_snapshot: Json }>("SELECT to_char(retention_until,'YYYY-MM-DD') retention_until, to_char(issue_date,'YYYY-MM-DD') issue_date, issuer_snapshot FROM invoices WHERE id=$1", [d1])).rows[0];
    const sixYears = `${Number(inv1.issue_date.slice(0, 4)) + 6}${inv1.issue_date.slice(4)}`;
    check("E05 issued as CS-000001 (status issued, version +1); totals frozen ($587.00); PDF in the private bucket with the recorded SHA-256; PDF shows number, agency, client, holiday segment and «Exento» with its legal basis; kept 6 years",
      ok1.status === 200 && ok1.body.issued?.number === "CS-000001" && g1.body.invoice?.status === "issued" && g1.body.invoice?.numberText === "CS-000001"
        && g1.body.totals?.totalCents === 58700 && doc1 && sha === doc1.sha256 && obj1.subarray(0, 5).toString() === "%PDF-"
        && txt1.includes("CS-000001") && txt1.includes("Cuidado en Casa Demo") && txt1.includes("Familia P") && txt1.includes("Feriado") && txt1.includes("Base legal de prueba")
        && inv1.retention_until === sixYears && g1.body.canVoid === true && g1.body.canEdit === false,
      `${S(ok1)} ${JSON.stringify(ok1.body.issued)} total=${g1.body.totals?.totalCents} sha=${sha === doc1?.sha256} txt=${["CS-000001", "Cuidado en Casa Demo", "Feriado", "Base legal"].map((x) => txt1.includes(x))} ret=${inv1.retention_until}/${sixYears}`);

    // E06 Double click on the same draft: one number only.
    const d2 = await draftWith(adm, [extra[0]]);
    const v2 = await version(d2);
    const [x, y] = await Promise.all([call("POST", `${I}/${d2}/issue`, adm.token, { expectedVersion: v2 }), call("POST", `${I}/${d2}/issue`, adm.token, { expectedVersion: v2 })]);
    check("E06 the same draft issued twice at once: exactly one 200 (CS-000002), the other 409 ALREADY_ISSUED",
      [x.status, y.status].sort().join() === "200,409" && [x, y].some((r) => r.body.error === "ALREADY_ISSUED") && [x, y].find((r) => r.status === 200)?.body.issued?.number === "CS-000002",
      `${S(x)} ${S(y)}`);

    // E07 Two administrators issuing 8 drafts at the same time: consecutive numbers, no gaps, no duplicates.
    await call("POST", `${B(orgA)}/permissions`, adm.token, { membershipId: await mem(adm2), capability: "issue", reason: "Emite también" });
    const many: string[] = [];
    for (let i = 1; i <= 8; i++) many.push(await draftWith(i % 2 ? adm : adm2, [extra[i]]));
    const vs = await Promise.all(many.map(version));
    const res7 = await Promise.all(many.map((id, i) => call("POST", `${I}/${id}/issue`, (i % 2 ? adm2 : adm).token, { expectedVersion: vs[i] })));
    const nums = (await q<{ invoice_number: number }>("SELECT invoice_number FROM invoices WHERE organization_id=$1 AND invoice_number IS NOT NULL ORDER BY 1", [orgA])).rows.map((r) => r.invoice_number);
    check("E07 eight drafts issued at the same time by two administrators: all 200; numbers 1..10 consecutive, no gaps, no duplicates",
      res7.every((r) => r.status === 200) && nums.join() === "1,2,3,4,5,6,7,8,9,10",
      `${res7.map((r) => r.status)} nums=${nums}`);

    // E08 A storage failure during issuing rolls the number back (no gap).
    const d3 = await draftWith(adm, [extra[9]]);
    const keep = await objects();
    await objStore.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keep.map((o) => ({ Key: o.Key! })) } }));
    await objStore.send(new DeleteBucketCommand({ Bucket: bucket }));
    const failed = await issue(adm, d3);
    await objStore.send(new CreateBucketCommand({ Bucket: bucket }));
    // Restore what was there (synthetic objects saved above are re-created from the database copies is not possible: re-issue path does not need them).
    const statusAfterFail = (await q<{ status: string; n: number }>("SELECT status, (SELECT next_number FROM invoice_series WHERE organization_id=$2) n FROM invoices WHERE id=$1", [d3, orgA])).rows[0];
    // The logo object was deleted with the bucket: upload it again so issuing can embed it.
    await rawCall(`${SET}/logo`, adm.token, png, "image/png");
    const retry = await issue(adm, d3);
    check("E08 storage down during issuing: 503, the draft stays a draft and the counter does not move (still 11); after storage is back the same draft gets CS-000011 (no gap)",
      failed.status === 503 && statusAfterFail.status === "draft" && statusAfterFail.n === 11 && retry.status === 200 && retry.body.issued?.number === "CS-000011",
      `${S(failed)} ${JSON.stringify(statusAfterFail)} retry=${S(retry)} ${retry.body.issued?.number}`);

    // E09 Issued invoices are immutable (API and database, owner too); prefix frozen; counter never decreases.
    const lineId = (await q<{ id: string }>("SELECT id FROM invoice_lines WHERE invoice_id=$1 LIMIT 1", [d1])).rows[0].id;
    const apiEdit = await call("POST", `${I}/${d1}/manual-lines`, adm.token, { expectedVersion: await version(d1), kind: "manual", description: "Extra", justification: "Prueba", serviceDate: "2026-08-10", quantityHundredths: 100, unitPriceCents: 100, taxTreatment: "exempt", taxLegalBasis: "Base de prueba" });
    const ownerLine = await q("UPDATE invoice_lines SET removed_at=now(), removed_by_user_id=$2 WHERE id=$1", [lineId, adm.userId]).then(() => "updated").catch((e: Error) => e.message);
    const ownerTotals = await q("UPDATE invoices SET notes='x', row_version=row_version+1 WHERE id=$1", [d1]).then(() => "updated").catch((e: Error) => e.message);
    const ownerNumber = await q("UPDATE invoices SET invoice_number=99, row_version=row_version+1 WHERE id=$1", [d1]).then(() => "updated").catch((e: Error) => e.message);
    const ownerDelete = await q("DELETE FROM invoices WHERE id=$1", [d1]).then(() => "deleted").catch((e: Error) => e.message);
    const ownerDoc = await q("UPDATE invoice_documents SET sha256=repeat('0',64) WHERE invoice_id=$1", [d1]).then(() => "updated").catch((e: Error) => e.message);
    const prefixLate = await call("PUT", SET, adm.token, { prefix: "XX" });
    const decrease = await q("UPDATE invoice_series SET next_number=1 WHERE organization_id=$1", [orgA]).then(() => "updated").catch((e: Error) => e.message);
    check("E09 issued invoice cannot be edited (API 409); database refuses line, amount, number, document changes and deletes (owner too); prefix frozen after the first issue (409 PREFIX_LOCKED); counter never decreases",
      apiEdit.body.error === "INVOICE_NOT_EDITABLE" && /INVOICE_NOT_EDITABLE/.test(ownerLine) && /INVOICE_IMMUTABLE/.test(ownerTotals) && /INVOICE_IMMUTABLE/.test(ownerNumber)
        && /BILLING_NO_DELETE/.test(ownerDelete) && /DOCUMENT_IMMUTABLE/.test(ownerDoc) && prefixLate.body.error === "PREFIX_LOCKED" && /NUMBER_NEVER_DECREASES/.test(decrease),
      [S(apiEdit), ownerLine, ownerTotals, ownerNumber, ownerDelete, ownerDoc, S(prefixLate), decrease].map((v) => String(v).slice(0, 28)).join(" | "));

    // E10 Shifts of an issued invoice stay reserved.
    const elig = await call("GET", `${B(orgA)}/eligible-shifts?billingClientId=${perez}&from=2026-07-01&to=2026-08-31`, adm.token);
    const shown = elig.body.shifts?.find((s: Json) => s.shiftId === s1);
    const dAgain = await draftWith(adm, []);
    const again = await call("POST", `${I}/${dAgain}/shift-lines`, adm.token, { expectedVersion: 1, shiftIds: [s1] });
    check("E10 shifts of an issued invoice stay reserved: listed as reserved and cannot go to another draft (409 SHIFT_ALREADY_RESERVED)",
      shown?.reservedBy?.invoiceId === d1 && !shown.selectable && again.body.error === "SHIFT_ALREADY_RESERVED", `${JSON.stringify(shown?.reservedBy)} ${S(again)}`);

    // E11 Private download: authorised, verified, audited.
    const dl = await fetch(`${base}${I}/${d1}/pdf`, { headers: { Authorization: `Bearer ${adm.token}` } });
    const dlBody = Buffer.from(await dl.arrayBuffer());
    const supDl = await call("GET", `${I}/${d1}/pdf`, sup.token);
    const crossDl = await call("GET", `${I}/${d1}/pdf`, admB.token);
    const centralDl = await call("GET", `${I}/${d1}/pdf`, platform.token);
    const anonDl = await call("GET", `${I}/${d1}/pdf`, "");
    const doc1now = (await q<{ object_key: string }>("SELECT object_key FROM invoice_documents WHERE invoice_id=$1 AND kind='original'", [d1])).rows[0];
    // The bucket was recreated in E08: put back the original bytes, then tamper with them.
    await objStore.send(new PutObjectCommand({ Bucket: bucket, Key: doc1now.object_key, Body: obj1 }));
    const restored = await fetch(`${base}${I}/${d1}/pdf`, { headers: { Authorization: `Bearer ${adm.token}` } });
    await objStore.send(new PutObjectCommand({ Bucket: bucket, Key: doc1now.object_key, Body: Buffer.from("%PDF-1.4 tampered") }));
    const tampered = await call("GET", `${I}/${d1}/pdf`, adm.token);
    await objStore.send(new PutObjectCommand({ Bucket: bucket, Key: doc1now.object_key, Body: obj1 }));
    const lastDl = await fetch(`${base}${I}/${d1}/pdf`, { headers: { Authorization: `Bearer ${adm.token}` } });
    const downloads = (await q<{ n: number }>("SELECT count(*)::int n FROM finance_events WHERE action='FINANCE_BILLING_PDF_DOWNLOADED' AND entity_id=$1", [d1])).rows[0].n;
    check("E11 download: billing.view gets the PDF (attachment, private no-store) only if its SHA-256 matches; altered object 409 BILLING_DOCUMENT_INTEGRITY; supervisor 403, other agency 403/404, ETNARA central and anonymous refused; downloads audited",
      [200, 409, 503].includes(dl.status) && restored.status === 200 && restored.headers.get("cache-control") === "private, no-store" && (restored.headers.get("content-disposition") ?? "").includes("CS-000001.pdf")
        && tampered.status === 409 && tampered.body.error === "BILLING_DOCUMENT_INTEGRITY" && lastDl.status === 200
        && supDl.status === 403 && [403, 404].includes(crossDl.status) && [403, 404].includes(centralDl.status) && anonDl.status === 401 && downloads >= 2,
      `first=${dl.status}(${dlBody.length}B) restored=${restored.status} ${restored.headers.get("content-disposition")} tampered=${S(tampered)} sup=${S(supDl)} cross=${S(crossDl)} central=${S(centralDl)} anon=${S(anonDl)} audited=${downloads}`);

    // E12 Void: reason, permission, frozen number, void copy, shifts released for re-billing; never twice.
    const noReason = await call("POST", `${I}/${d1}/void`, adm.token, { expectedVersion: await version(d1), reason: "" });
    const noPerm = await call("POST", `${I}/${d1}/void`, adm2.token, { expectedVersion: await version(d1), reason: "Sin permiso" });
    const voided = await call("POST", `${I}/${d1}/void`, adm.token, { expectedVersion: await version(d1), reason: "Error en el período (prueba)" });
    const gv = await call("GET", `${I}/${d1}`, adm.token);
    const voidCopy = await fetch(`${base}${I}/${d1}/pdf?kind=void_copy`, { headers: { Authorization: `Bearer ${adm.token}` } });
    const voidTxt = pdfText(Buffer.from(await voidCopy.arrayBuffer()));
    const twice = await call("POST", `${I}/${d1}/void`, adm.token, { expectedVersion: await version(d1), reason: "Otra vez" });
    const rebill = await draftWith(adm, [s1]);
    const rebillLines = (await call("GET", `${I}/${rebill}`, adm.token)).body.lines?.length;
    const original = await fetch(`${base}${I}/${d1}/pdf`, { headers: { Authorization: `Bearer ${adm.token}` } });
    check("E12 void: reason required (400); without billing.void 403; voided keeps CS-000001, the original PDF and adds the «ANULADA» copy; its shifts can be billed again; voiding twice 409",
      noReason.status === 400 && noPerm.status === 403 && voided.status === 200 && voided.body.voided?.released === 3 && gv.body.invoice?.status === "voided" && gv.body.invoice?.numberText === "CS-000001"
        && voidCopy.status === 200 && voidTxt.includes("ANULADA") && original.status === 200 && twice.body.error === "ALREADY_VOIDED" && rebillLines === 1,
      `${S(noReason)} ${S(noPerm)} ${S(voided)} ${JSON.stringify(voided.body.voided)} status=${gv.body.invoice?.status} copy=${voidCopy.status}/${voidTxt.includes("ANULADA")} orig=${original.status} twice=${S(twice)} rebill=${rebillLines}`);

    // E13 Holiday used by a live issued invoice cannot be deactivated (re-bill s1 and issue it).
    await issue(adm, rebill);
    const deact = await call("POST", `/organizations/${orgA}/finance/holidays/2026-07-04/deactivate`, adm.token, { reason: "Prueba" });
    check("E13 an agency holiday used by an issued invoice cannot be deactivated (409 HOLIDAY_INVOICED)", deact.status === 409 && deact.body.error === "HOLIDAY_INVOICED", S(deact));

    // E14 D9: the caregiver's name is not in the PDF unless the agency turns it on.
    const cgName = (await q<{ display_name: string }>("SELECT w.display_name FROM workers w JOIN users u ON u.id=w.user_id WHERE u.id=$1", [cg.userId])).rows[0].display_name;
    const offPdf = pdfText(Buffer.from(await (await fetch(`${base}${I}/${rebill}/pdf`, { headers: { Authorization: `Bearer ${adm.token}` } })).arrayBuffer()));
    await call("PUT", SET, adm.token, { showCaregiverName: true });
    const dOn = await draftWith(adm, [sNew]);
    await issue(adm, dOn);
    const onPdf = pdfText(Buffer.from(await (await fetch(`${base}${I}/${dOn}/pdf`, { headers: { Authorization: `Bearer ${adm.token}` } })).arrayBuffer()));
    check("E14 D9: caregiver's name absent by default; present only after the agency turns it on (and only on invoices issued after)",
      !offPdf.includes(cgName) && onPdf.includes(cgName), `name=${cgName} off=${offPdf.includes(cgName)} on=${onPdf.includes(cgName)}`);

    // E15 Read-only mode: downloads keep working; issuing refused.
    const dRo = await draftWith(adm, [extra[10]]);
    await feat(orgA, "FACTURACION", false, "Pausa");
    const roDl = await call("GET", `${I}/${rebill}/pdf`, adm.token);
    const roIssue = await call("POST", `${I}/${dRo}/issue`, adm.token, { expectedVersion: 2 });
    await feat(orgA, "FACTURACION", true, "Reanudar");
    check("E15 read-only: with FACTURACION off issued PDFs still download (200) and issuing is refused (404 at the gate)",
      roDl.status === 200 && roIssue.status === 404, `${S(roDl)} ${S(roIssue)}`);

    // E16 Isolation and ETNARA central at the database layer.
    const centralRows = await asSession<{ n: number }>({ userId: platform.userId, orgId: orgA, superadmin: true }, "SELECT (SELECT count(*) FROM invoices)+(SELECT count(*) FROM invoice_documents)+(SELECT count(*) FROM billing_settings)+(SELECT count(*) FROM invoice_series) n");
    const bRows = await asSession<{ n: number }>({ userId: admB.userId, orgId: orgB }, "SELECT (SELECT count(*) FROM invoices WHERE organization_id=$1)+(SELECT count(*) FROM invoice_documents WHERE organization_id=$1)+(SELECT count(*) FROM billing_settings WHERE organization_id=$1) n", [orgA]);
    const supRows = await asSession<{ n: number }>({ userId: sup.userId, orgId: orgA }, "SELECT (SELECT count(*) FROM invoices)+(SELECT count(*) FROM invoice_documents) n");
    const forgeDoc = await asSession({ userId: adm2.userId, orgId: orgA }, "INSERT INTO invoice_documents (organization_id,invoice_id,kind,object_key,sha256,size_bytes,generator_version,created_by_user_id) VALUES ($1,$2,'void_copy','org/x/forged.pdf',repeat('a',64),10,'x',$3)", [orgA, dOn, adm2.userId]);
    check("E16 database: ETNARA central, another agency and a supervisor read 0 invoices, documents or settings; a document cannot be forged without billing.void / wrong state",
      Number(centralRows.rows[0]?.n) === 0 && Number(bRows.rows[0]?.n) === 0 && Number(supRows.rows[0]?.n) === 0 && Boolean(forgeDoc.error),
      `${centralRows.rows[0]?.n} ${bRows.rows[0]?.n} ${supRows.rows[0]?.n} ${String(forgeDoc.error).slice(0, 40)}`);

    // E17 Audit.
    const ev = (await q<{ action: string }>("SELECT DISTINCT action FROM finance_events WHERE action LIKE 'FINANCE_BILLING_%'")).rows.map((r) => r.action);
    const need = ["INVOICE_ISSUED", "INVOICE_VOIDED", "PDF_GENERATED", "PDF_DOWNLOADED", "SETTINGS_CHANGED", "TAX_CONFIG_VALIDATED", "LOGO_CHANGED", "RESERVATION_RELEASED"].map((a) => `FINANCE_BILLING_${a}`);
    const au = await q<{ new_value: Json | null }>("SELECT new_value FROM audit_log WHERE action LIKE 'FINANCE_BILLING_%'");
    check("E17 audit: issue, void, PDF generated/downloaded, settings, tax validation and logo recorded in finance_events; audit_log identifiers only",
      need.every((a) => ev.includes(a)) && au.rows.every((r) => !/cents|amount|total/i.test(JSON.stringify(r.new_value ?? {}))),
      `missing=${need.filter((a) => !ev.includes(a))}`);

    // E19 Recovery of a lost PDF without touching the issued invoice (verified deterministic rebuild).
    const { recoverInvoiceDocument } = await import("../src/modules/billing/billingRecovery.js");
    const { Kysely, PostgresDialect } = await import("kysely");
    const ops = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: adminUrl, max: 1 }) }) });
    const recover = (kind: "original" | "void_copy", apply: boolean) => ops.transaction().execute((trx) => recoverInvoiceDocument(trx as never, { organizationId: orgA, invoiceId: d1, kind, actorUserId: adm.userId, apply }));
    const rowBefore = (await q("SELECT status, number_text, row_version, issuer_snapshot, totals_snapshot, voided_at FROM invoices WHERE id=$1", [d1])).rows[0];
    const docsBefore = (await q("SELECT kind, object_key, sha256 FROM invoice_documents WHERE invoice_id=$1 ORDER BY kind", [d1])).rows;
    const intact = await recover("original", false);
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    for (const d of docsBefore) await objStore.send(new DeleteObjectCommand({ Bucket: bucket, Key: d.object_key }));
    const lost = await call("GET", `${I}/${d1}/pdf`, adm.token);
    const dry = await recover("original", false);
    const stillLost = await call("GET", `${I}/${d1}/pdf`, adm.token);
    const recOrig = await recover("original", true);
    const recVoid = await recover("void_copy", true);
    const back = await fetch(`${base}${I}/${d1}/pdf`, { headers: { Authorization: `Bearer ${adm.token}` } });
    const backBody = Buffer.from(await back.arrayBuffer());
    const backVoid = await fetch(`${base}${I}/${d1}/pdf?kind=void_copy`, { headers: { Authorization: `Bearer ${adm.token}` } });
    const backVoidBody = Buffer.from(await backVoid.arrayBuffer());
    const rowAfter = (await q("SELECT status, number_text, row_version, issuer_snapshot, totals_snapshot, voided_at FROM invoices WHERE id=$1", [d1])).rows[0];
    const docsAfter = (await q("SELECT kind, object_key, sha256 FROM invoice_documents WHERE invoice_id=$1 ORDER BY kind", [d1])).rows;
    const recEvents = (await q<{ n: number }>("SELECT count(*)::int n FROM finance_events WHERE action='FINANCE_BILLING_PDF_RECOVERED' AND entity_id=$1", [d1])).rows[0].n;
    const { createHash } = await import("node:crypto");
    const h = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    await ops.destroy();
    check("E19 recovery: intact → INTACT; lost object → download fails safely, dry run RECOVERABLE writes nothing, apply RECOVERED for the original (no void mark) and the void copy; same SHA-256 and same key; invoice and document rows unchanged; recovery audited",
      intact.status === "INTACT" && lost.status !== 200 && lost.status !== 500 && dry.status === "RECOVERABLE" && stillLost.status !== 200
        && recOrig.status === "RECOVERED" && recVoid.status === "RECOVERED" && back.status === 200 && backVoid.status === 200
        && h(backBody) === docsBefore.find((d) => d.kind === "original")!.sha256 && h(backVoidBody) === docsBefore.find((d) => d.kind === "void_copy")!.sha256
        && !pdfText(backBody).includes("ANULADA") && pdfText(backVoidBody).includes("ANULADA")
        && JSON.stringify(rowBefore) === JSON.stringify(rowAfter) && JSON.stringify(docsBefore) === JSON.stringify(docsAfter) && recEvents === 2,
      `intact=${intact.status} lost=${S(lost)} dry=${dry.status} still=${stillLost.status} orig=${JSON.stringify(recOrig)} void=${JSON.stringify(recVoid)} back=${back.status}/${backVoid.status} rows=${JSON.stringify(rowBefore) === JSON.stringify(rowAfter)} docs=${JSON.stringify(docsBefore) === JSON.stringify(docsAfter)} events=${recEvents}`);

    // E20 The ANULADA mark is drawn around the page centre (letter 612×792 → origin moved to 306,396).
    check("E20 void copy: the ANULADA watermark is centred on the page (translate to 306,396 then rotate)",
      backVoidBody.toString("latin1").includes("1 0 0 1 306 396 cm") && !backBody.toString("latin1").includes("1 0 0 1 306 396 cm"), "");

    // E21 Independent daily copy (append-only, verified) and recovery from it.
    const bk = await import("../src/modules/billing/billingBackup.js");
    const backupBucket = `${bucket}-copy`;
    await objStore.send(new CreateBucketCommand({ Bucket: backupBucket }));
    const srcRef = { s3: objStore, bucket }; const dstRef = { s3: objStore, bucket: backupBucket };
    const expected = (await q<{ key: string; sha256: string; retainUntil: Date | null }>(bk.EXPECTED_OBJECTS_SQL)).rows;
    // E08 recreated the bucket on purpose, so some earlier PDFs are really gone: the copy must report exactly those.
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const absent: string[] = [];
    for (const o of expected) await objStore.send(new HeadObjectCommand({ Bucket: bucket, Key: o.key })).catch(() => absent.push(o.key));
    const present = expected.length - absent.length;
    const copy1 = await bk.dailyCopy(srcRef, dstRef, expected, "2026-10-25");
    const copy2 = await bk.dailyCopy(srcRef, dstRef, expected, "2026-10-26");
    const sameBucket = await bk.dailyCopy(srcRef, srcRef, expected, "x").then(() => "ran", (e: Error) => e.message);
    const victim = docsBefore.find((d) => d.kind === "original")!;
    await objStore.send(new DeleteObjectCommand({ Bucket: bucket, Key: victim.object_key }));
    const ops2 = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: adminUrl, max: 1 }) }) });
    const fromCopy = await ops2.transaction().execute((trx) => recoverInvoiceDocument(trx as never, { organizationId: orgA, invoiceId: d1, kind: "original", actorUserId: adm.userId, apply: true, copies: { backup: dstRef, source: srcRef } }));
    await ops2.destroy();
    const afterCopy = await fetch(`${base}${I}/${d1}/pdf`, { headers: { Authorization: `Bearer ${adm.token}` } });
    const afterCopyBody = Buffer.from(await afterCopy.arrayBuffer());
    // A copy is never overwritten: tamper with one copy, then run again → reported as a conflict, bytes untouched.
    const other = expected.find((o) => o.key !== victim.object_key && !absent.includes(o.key))!;
    await objStore.send(new PutObjectCommand({ Bucket: backupBucket, Key: `billing/${other.key}`, Body: Buffer.from("x"), Metadata: { sha256: "0".repeat(64) } }));
    const copy3 = await bk.dailyCopy(srcRef, dstRef, expected, "2026-10-27");
    const tamperedCopy = Buffer.from(await (await objStore.send(new GetObjectCommand({ Bucket: backupBucket, Key: `billing/${other.key}` }))).Body!.transformToByteArray()).toString();
    const manifest = JSON.parse(Buffer.from(await (await objStore.send(new GetObjectCommand({ Bucket: backupBucket, Key: "billing/manifests/2026-10-25.json" }))).Body!.transformToByteArray()).toString());
    check("E21 daily copy: every invoice PDF and logo copied once with its hash, objects missing at the source reported (second run: all present); same bucket refused; a lost PDF is restored from the copy (same SHA-256); a tampered copy is reported, never overwritten; manifest lists keys and hashes only",
      present >= 3 && copy1.copied === present && JSON.stringify([...copy1.missingOrAlteredInSource].sort()) === JSON.stringify([...absent].sort())
        && copy2.alreadyPresent === present && copy2.copied === 0
        && sameBucket === "BACKUP_SAME_BUCKET" && fromCopy.status === "RECOVERED" && (fromCopy as { method?: string }).method === "daily_copy"
        && afterCopy.status === 200 && h(afterCopyBody) === victim.sha256 && copy3.conflictingCopy.includes(other.key) && tamperedCopy === "x"
        && Array.isArray(manifest.objects) && manifest.objects.every((o: Json) => Object.keys(o).sort().join() === "key,sha256") && !/Cliente|Agencia|cents/i.test(JSON.stringify(manifest)),
      `expected=${expected.length} c1=${JSON.stringify(copy1)} c2=${copy2.alreadyPresent}/${copy2.copied} same=${sameBucket} rec=${JSON.stringify(fromCopy)} after=${afterCopy.status} c3=${JSON.stringify(copy3.conflictingCopy)}`);

    // E22 AWS-style backup bucket (local): versioning + Object Lock, per-object retention = invoice retention_until,
    // deletion of a locked version refused, and a restore that finds the good version under a bad latest one.
    const lockBucket = `${bucket}-lock`;
    await objStore.send(new CreateBucketCommand({ Bucket: lockBucket, ObjectLockEnabledForBucket: true }));
    const lockRef = { s3: objStore, bucket: lockBucket, objectLock: "COMPLIANCE" as const };
    const presentNow = expected.filter((o) => !absent.includes(o.key));
    const lockCopy = await bk.dailyCopy(srcRef, lockRef, presentNow, "2026-10-28");
    const invDoc = presentNow.find((o) => o.key.includes("/invoices/") && o.retainUntil)!;
    const { HeadObjectCommand: Head2, DeleteObjectCommand: Del2 } = await import("@aws-sdk/client-s3");
    const head = await objStore.send(new Head2({ Bucket: lockBucket, Key: `billing/${invDoc.key}` }));
    const delLocked = await objStore.send(new Del2({ Bucket: lockBucket, Key: `billing/${invDoc.key}`, VersionId: head.VersionId })).then(() => "deleted", (e: Error) => e.name);
    await objStore.send(new PutObjectCommand({ Bucket: lockBucket, Key: `billing/${invDoc.key}`, Body: Buffer.from("bad latest"), Metadata: { sha256: invDoc.sha256 } }));
    await objStore.send(new DeleteObjectCommand({ Bucket: bucket, Key: invDoc.key }));
    const fromVersion = await bk.restoreFromCopy(lockRef, srcRef, invDoc.key, invDoc.sha256);
    const restoredBody = Buffer.from(await (await objStore.send(new GetObjectCommand({ Bucket: bucket, Key: invDoc.key }))).Body!.transformToByteArray());
    const retainOk = head.ObjectLockMode === "COMPLIANCE" && head.ObjectLockRetainUntilDate
      && head.ObjectLockRetainUntilDate.toISOString().slice(0, 10) === new Date(invDoc.retainUntil!).toISOString().slice(0, 10);
    check("E22 Object Lock copy: written in COMPLIANCE mode with retain-until = the invoice retention date; deleting a locked version is refused; a bad newer version cannot hide the good one (restore by version, same SHA-256)",
      lockCopy.copied === presentNow.length && Boolean(retainOk) && delLocked !== "deleted" && fromVersion && h(restoredBody) === invDoc.sha256,
      `copied=${lockCopy.copied}/${presentNow.length} mode=${head.ObjectLockMode} until=${head.ObjectLockRetainUntilDate?.toISOString()} want=${invDoc.retainUntil} del=${delLocked} restore=${fromVersion}`);

    const fives = all.filter((r) => r.status === 500);
    check("E18 no 500 in the whole run", fives.length === 0, fives.map((r) => JSON.stringify(r.body)).join(" "));
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
    await runtime.end();
    await db.end();
    moto.kill();
  }

  console.log("\nETNARA Facturación F2.3 — issue, numbering, PDF, void, security\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nBilling F2.3: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Billing F2.3 verification failed:", error);
  process.exit(1);
});
