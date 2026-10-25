/**
 * ETNARA Facturación Premium F2.1 (migration 123) — FACTURACION switch,
 * dependency on FINANZAS, billing permissions, last-manager protection,
 * ETNARA central designation (names only), read-only mode, isolation, audit.
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
    const email = `f21-${key}-${tag}@example.invalid`;
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

  const orgA = await agency("F21 A", true);
  const orgB = await agency("F21 B", true);
  const orgC = await agency("F21 C", false);
  const adm = await person(orgA, "admin", ["ORGANIZATION_ADMIN"]);
  const sup = await person(orgA, "supervisor", ["SUPERVISOR"]);
  const cg = await person(orgA, "cg", ["WORKER"], true);
  const admB = await person(orgB, "adminb", ["ORGANIZATION_ADMIN"]);
  const admC = await person(orgC, "adminc", ["ORGANIZATION_ADMIN"]);
  // ETNARA central: platform administrator with no agency membership.
  const platformEmail = `f21-central-${tag}@example.invalid`;
  const platformUserId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [platformEmail, hash])).rows[0].id;
  await q("INSERT INTO platform_admins (user_id) VALUES ($1)", [platformUserId]);
  const platformLogin = await call("POST", "/auth/login", "", { email: platformEmail, password });
  if (platformLogin.status !== 200) throw new Error(`central login ${platformLogin.status}`);
  const platform = { userId: platformUserId, token: platformLogin.body.token as string };
  const admB2 = await person(orgB, "adminb2", ["ORGANIZATION_ADMIN"]);
  const supB = await person(orgB, "supb", ["SUPERVISOR"]);
  const mem = async (p: P) => (await q<{ id: string }>("SELECT id FROM organization_memberships WHERE user_id=$1 AND organization_id=$2", [p.userId, p.orgId])).rows[0].id;
  const feat = (org: string, code: string, enabled: boolean, reason = "Piloto de facturación") => call("PUT", `/platform/organizations/${org}/features/${code}`, platform.token, { enabled, reason });
  const B = (org: string) => `/organizations/${org}/billing`;
  const MONEY = /cents|amount|total|rate|price|invoice|iva|ivu/i;

  try {
    // B01 Off by default; the module is never revealed to non-administrators.
    const rows = (await q<{ n: number }>("SELECT count(*)::int n FROM organization_features WHERE feature_code='FACTURACION'")).rows[0].n;
    const accA = await call("GET", `${B(orgA)}/access`, adm.token);
    const accSup = await call("GET", `${B(orgA)}/access`, sup.token);
    const accCg = await call("GET", `${B(orgA)}/access`, cg.token);
    check("B01 FACTURACION off for every agency (0 rows); admin sees enabled=false and no capabilities; supervisor and caregiver 403",
      rows === 0 && accA.status === 200 && accA.body.module?.enabled === false && accA.body.module?.facturacion === false && accA.body.capabilities?.length === 0
        && accSup.status === 403 && accCg.status === 403,
      `rows=${rows} ${accA.status} ${JSON.stringify(accA.body.module)} sup=${accSup.status} cg=${accCg.status}`);

    // B02 Requires FINANZAS (API and database).
    const noFin = await feat(orgC, "FACTURACION", true);
    const ownerNoFin = await q("INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'FACTURACION',true)", [orgC]).then(() => "inserted").catch((e: Error) => e.message);
    const adminTries = await call("PUT", `/platform/organizations/${orgA}/features/FACTURACION`, adm.token, { enabled: true, reason: "Intento" });
    check("B02 FACTURACION cannot be turned on without FINANZAS (409, database refuses too); only ETNARA central can switch it (agency admin 403)",
      noFin.status === 409 && noFin.body.error === "FEATURE_REQUIRES_FINANZAS" && /FEATURE_REQUIRES_FINANZAS/.test(ownerNoFin) && adminTries.status === 403,
      `${noFin.status} ${noFin.body.error} | ${ownerNoFin} | admin=${adminTries.status}`);

    // B03 Single administrator receives the initial permissions.
    const onA = await feat(orgA, "FACTURACION", true);
    const accA2 = await call("GET", `${B(orgA)}/access`, adm.token);
    const me = await call("GET", "/me", adm.token);
    const meFeatures = JSON.stringify(me.body);
    check("B03 turning FACTURACION on for an agency with one administrator grants view/draft/issue/void/manage; /me lists FACTURACION",
      onA.status === 200 && onA.body.feature?.initialBillingPermissions === 5 && accA2.body.module?.enabled === true
        && ["view", "draft", "issue", "void", "manage"].every((c) => accA2.body.capabilities?.includes(c)) && meFeatures.includes("FACTURACION"),
      `${onA.status} ${JSON.stringify(onA.body.feature)} caps=${accA2.body.capabilities}`);

    // B04 Several administrators: nobody gets permissions; ETNARA designates the manager (names only).
    const onB = await feat(orgB, "FACTURACION", true);
    const capsB1 = (await call("GET", `${B(orgB)}/access`, admB.token)).body.capabilities;
    const cand = await call("GET", `/platform/organizations/${orgB}/billing-admins`, platform.token);
    const candAdmin = await call("GET", `/platform/organizations/${orgB}/billing-admins`, admB.token);
    const desNoReason = await call("POST", `/platform/organizations/${orgB}/billing-manager`, platform.token, { membershipId: await mem(admB) });
    const desSup = await call("POST", `/platform/organizations/${orgB}/billing-manager`, platform.token, { membershipId: await mem(supB), reason: "Designación" });
    const desOff = await call("POST", `/platform/organizations/${orgC}/billing-manager`, platform.token, { membershipId: await mem(admC), reason: "Designación" });
    const des = await call("POST", `/platform/organizations/${orgB}/billing-manager`, platform.token, { membershipId: await mem(admB), reason: "Responsable de facturación" });
    const capsB1b = (await call("GET", `${B(orgB)}/access`, admB.token)).body.capabilities ?? [];
    check("B04 several administrators: no automatic grant; central lists the 2 administrators (emails only, no money) and designates one (manage+view); reason required; supervisor and agencies without the module refused",
      onB.status === 200 && onB.body.feature?.initialBillingPermissions === 0 && capsB1?.length === 0 && cand.status === 200 && cand.body.admins?.length === 2
        && !MONEY.test(JSON.stringify(cand.body)) && candAdmin.status === 403 && desNoReason.status === 400
        && desSup.status === 409 && desSup.body.error === "BILLING_PERMISSION_ADMIN_ONLY" && desOff.status === 409
        && des.status === 200 && capsB1b.length === 2 && capsB1b.includes("manage") && capsB1b.includes("view"),
      `boot=${onB.body.feature?.initialBillingPermissions} cand=${cand.status}/${cand.body.admins?.length} admin=${candAdmin.status} noReason=${desNoReason.status} sup=${desSup.status}/${desSup.body.error} off=${desOff.status}/${desOff.body.error} des=${des.status} ${JSON.stringify(des.body)} caps=${capsB1b}`);

    // B05 Granting and who may grant.
    const b2 = await mem(admB2);
    const g1 = await call("POST", `${B(orgB)}/permissions`, admB.token, { membershipId: b2, capability: "draft", reason: "Prepara borradores" });
    const gDup = await call("POST", `${B(orgB)}/permissions`, admB.token, { membershipId: b2, capability: "draft", reason: "Otra vez" });
    const gSup = await call("POST", `${B(orgB)}/permissions`, admB.token, { membershipId: await mem(supB), capability: "view", reason: "Supervisor" });
    const gNoManage = await call("POST", `${B(orgB)}/permissions`, admB2.token, { membershipId: b2, capability: "issue", reason: "Me lo doy" });
    const gBySup = await call("POST", `${B(orgB)}/permissions`, supB.token, { membershipId: b2, capability: "issue", reason: "Supervisor" });
    const gCross = await call("POST", `${B(orgB)}/permissions`, adm.token, { membershipId: b2, capability: "issue", reason: "Otra agencia" });
    const gNoReason = await call("POST", `${B(orgB)}/permissions`, admB.token, { membershipId: b2, capability: "issue" });
    const gCrossMember = await call("POST", `${B(orgB)}/permissions`, admB.token, { membershipId: await mem(adm), capability: "view", reason: "De otra agencia" });
    check("B05 the manager grants (201); duplicate 409; supervisor cannot hold permissions; non-managers, supervisors and other agencies cannot grant; reason required; people of another agency refused",
      g1.status === 201 && gDup.status === 409 && gSup.status === 409 && gSup.body.error === "BILLING_PERMISSION_ADMIN_ONLY"
        && gNoManage.status === 403 && gBySup.status === 403 && [403, 404].includes(gCross.status) && gNoReason.status === 400 && [404, 409].includes(gCrossMember.status),
      `${g1.status},${gDup.status},${gSup.status}/${gSup.body.error},${gNoManage.status},${gBySup.status},${gCross.status},${gNoReason.status},${gCrossMember.status}`);

    // B06 Never without a manager (also when two managers revoke each other at once).
    const manageId = async (p: P) => (await q<{ id: string }>("SELECT id FROM billing_permissions WHERE membership_id=$1 AND capability='manage' AND revoked_at IS NULL", [await mem(p)])).rows[0]?.id;
    const last = await call("POST", `${B(orgB)}/permissions/${await manageId(admB)}/revoke`, admB.token, { reason: "Me retiro" });
    await call("POST", `${B(orgB)}/permissions`, admB.token, { membershipId: b2, capability: "manage", reason: "Segundo gestor" });
    const [x, y] = await Promise.all([
      call("POST", `${B(orgB)}/permissions/${await manageId(admB2)}/revoke`, admB.token, { reason: "Carrera" }),
      call("POST", `${B(orgB)}/permissions/${await manageId(admB)}/revoke`, admB2.token, { reason: "Carrera" }),
    ]);
    const managersLeft = (await q<{ n: number }>("SELECT app_billing_effective_holders($1,'manage') n", [orgB])).rows[0].n;
    check("B06 the last manager cannot be revoked (409 LAST_PERMISSION_MANAGER); two managers revoking each other at once: exactly one wins, the other is refused (already without manage), one manager remains",
      last.status === 409 && last.body.error === "LAST_PERMISSION_MANAGER" && [x.status, y.status].filter((s) => s === 200).length === 1
        && [x, y].some((r) => r.body.error === "LAST_PERMISSION_MANAGER" || r.body.error === "BILLING_FORBIDDEN") && managersLeft === 1,
      `last=${last.status}/${last.body.error} race=${x.status}/${x.body.error},${y.status}/${y.body.error} left=${managersLeft}`);

    const stillManager = (await q<{ uid: string }>(`SELECT om.user_id uid FROM billing_permissions p JOIN organization_memberships om ON om.id=p.membership_id WHERE p.organization_id=$1 AND p.capability='manage' AND p.revoked_at IS NULL`, [orgB])).rows[0]?.uid;
    const mgr = stillManager === admB2.userId ? admB2 : admB;
    const nonMgr = mgr === admB ? admB2 : admB;

    // B07 A permission only works while the person is an administrator.
    const remaining = (await q<{ uid: string }>(`SELECT om.user_id uid FROM billing_permissions p JOIN organization_memberships om ON om.id=p.membership_id WHERE p.organization_id=$1 AND p.capability='draft' AND p.revoked_at IS NULL`, [orgB])).rows[0]?.uid;
    const holder = remaining === admB2.userId ? admB2 : admB;
    const before = (await asSession<{ c: boolean }>({ userId: holder.userId, orgId: orgB }, "SELECT app_billing_can($1,'draft') c", [orgB])).rows[0]?.c;
    await q(`DELETE FROM user_roles WHERE organization_membership_id=$1 AND role_id=(SELECT id FROM roles WHERE code='ORGANIZATION_ADMIN')`, [await mem(holder)]);
    const after = (await asSession<{ c: boolean }>({ userId: holder.userId, orgId: orgB }, "SELECT app_billing_can($1,'draft') c", [orgB])).rows[0]?.c;
    const accAfter = await call("GET", `${B(orgB)}/access`, holder.token);
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='ORGANIZATION_ADMIN'`, [await mem(holder), orgB]);
    check("B07 a granted permission stops working as soon as the person stops being an administrator (no row deleted)", before === true && after === false && accAfter.status === 403,
      `${before} → ${after} access=${accAfter.status}`);

    // B08 Database layer: forged writes, other roles, other agencies, ETNARA central.
    const forgeIns = await asSession({ userId: nonMgr.userId, orgId: orgB },
      "INSERT INTO billing_permissions (organization_id,membership_id,capability,grant_source,grant_reason,granted_by_user_id) VALUES ($1,$2,'issue','manual','Forjado',$3)", [orgB, await mem(nonMgr), nonMgr.userId]);
    const forgeSrc = await asSession({ userId: mgr.userId, orgId: orgB },
      "INSERT INTO billing_permissions (organization_id,membership_id,capability,grant_source,grant_reason,granted_by_user_id) VALUES ($1,$2,'issue','central_designation','Forjado',$3)", [orgB, await mem(nonMgr), mgr.userId]);
    const anyId = (await q<{ id: string }>("SELECT id FROM billing_permissions WHERE organization_id=$1 LIMIT 1", [orgB])).rows[0].id;
    const del = await q("DELETE FROM billing_permissions WHERE id=$1", [anyId]).then(() => "deleted").catch((e: Error) => e.message);
    const change = await q("UPDATE billing_permissions SET capability='issue' WHERE id=$1", [anyId]).then(() => "updated").catch((e: Error) => e.message);
    const supRead = await asSession<{ n: number }>({ userId: supB.userId, orgId: orgB }, "SELECT count(*)::int n FROM billing_permissions");
    const otherRead = await asSession<{ n: number }>({ userId: adm.userId, orgId: orgA }, "SELECT count(*)::int n FROM billing_permissions WHERE organization_id=$1", [orgB]);
    const centralRead = await asSession<{ n: number }>({ userId: platform.userId, orgId: orgB, superadmin: true }, "SELECT count(*)::int n FROM billing_permissions");
    const centralIns = await asSession({ userId: platform.userId, orgId: orgB, superadmin: true },
      "INSERT INTO billing_permissions (organization_id,membership_id,capability,grant_source,grant_reason,granted_by_user_id) VALUES ($1,$2,'issue','manual','Central',$3)", [orgB, b2, platform.userId]);
    const centralCan = (await asSession<{ c: boolean }>({ userId: platform.userId, orgId: orgB, superadmin: true }, "SELECT app_billing_can($1,'view') c", [orgB])).rows[0]?.c;
    const supAdmins = await asSession({ userId: supB.userId, orgId: orgB }, "SELECT * FROM app_billing_admins($1)", [orgB]);
    check("B08 database: non-manager insert and forged source refused; no delete or edit (owner too); supervisor, other agency and ETNARA central read 0 rows and cannot insert or use billing; supervisor cannot list administrators",
      Boolean(forgeIns.error) && Boolean(forgeSrc.error) && /NO_DELETE/.test(del) && /IMMUTABLE/.test(change)
        && supRead.rows[0]?.n === 0 && otherRead.rows[0]?.n === 0 && centralRead.rows[0]?.n === 0 && Boolean(centralIns.error) && centralCan === false && Boolean(supAdmins.error),
      [forgeIns.error, forgeSrc.error, del, change, supRead.rows[0]?.n, otherRead.rows[0]?.n, centralRead.rows[0]?.n, centralIns.error, centralCan, supAdmins.error].map((v) => String(v ?? "OK").slice(0, 30)).join(" | "));

    // B09 Read-only mode.
    await feat(orgA, "FACTURACION", false, "Fin del periodo de prueba");
    const roAccess = await call("GET", `${B(orgA)}/access`, adm.token);
    const roRead = await call("GET", `${B(orgA)}/permissions`, adm.token);
    const roWrite = await call("POST", `${B(orgA)}/permissions`, adm.token, { membershipId: await mem(adm), capability: "view", reason: "x".repeat(5) });
    const roDb = (await asSession<{ v: boolean; d: boolean }>({ userId: adm.userId, orgId: orgA }, "SELECT app_billing_can($1,'view') v, app_billing_can($1,'draft') d", [orgA])).rows[0];
    await feat(orgA, "FACTURACION", true, "Reactivado");
    const finOff = await feat(orgA, "FINANZAS", false, "Prueba");
    const finOffWrite = await call("POST", `${B(orgA)}/permissions`, adm.token, { membershipId: await mem(adm), capability: "view", reason: "Prueba" });
    const finOffRead = await call("GET", `${B(orgA)}/permissions`, adm.token);
    await feat(orgA, "FINANZAS", true, "Fin de prueba");
    const keptCaps = (await call("GET", `${B(orgA)}/access`, adm.token)).body.capabilities;
    check("B09 read-only mode: with FACTURACION off the history is readable (view) and writes are refused (404 at the gate, database too); with FINANZAS off, 409 BILLING_READ_ONLY; turning it back on keeps every permission",
      roAccess.body.module?.readOnly === true && roAccess.body.capabilities?.join(",") === "view" && roRead.status === 200 && roWrite.status === 404
        && roDb?.v === true && roDb?.d === false && finOff.status === 200 && finOffWrite.status === 409 && finOffWrite.body.error === "BILLING_READ_ONLY"
        && finOffRead.status === 200 && keptCaps?.length === 5,
      `ro=${JSON.stringify(roAccess.body.module)} caps=${roAccess.body.capabilities} read=${roRead.status} write=${roWrite.status} db=${JSON.stringify(roDb)} finOff=${finOffWrite.status}/${finOffWrite.body.error} kept=${keptCaps}`);

    // B10 Audit.
    const ev = (await q<{ action: string }>("SELECT DISTINCT action FROM finance_events WHERE action LIKE 'FINANCE_BILLING_%'")).rows.map((r) => r.action).sort();
    const au = await q<{ new_value: Json | null }>("SELECT new_value FROM audit_log WHERE action LIKE 'FINANCE_BILLING_%'");
    const supAudit = await asSession<{ n: number }>({ userId: supB.userId, orgId: orgB }, "SELECT count(*)::int n FROM audit_log WHERE action LIKE 'FINANCE_BILLING_%'");
    const centralAudit = await asSession<{ n: number }>({ userId: platform.userId, orgId: orgB, superadmin: true }, "SELECT count(*)::int n FROM audit_log WHERE action LIKE 'FINANCE_BILLING_%'");
    const toggles = (await q<{ n: number }>("SELECT count(*)::int n FROM organization_feature_events WHERE feature_code='FACTURACION' AND length(reason) >= 3")).rows[0].n;
    check("B10 audit: finance_events records grants, revocations, designation and initial permissions; audit_log identifiers only, hidden from supervisor and ETNARA central; every switch change has its reason",
      ["FINANCE_BILLING_INITIAL_PERMISSIONS", "FINANCE_BILLING_MANAGER_DESIGNATED", "FINANCE_BILLING_PERMISSION_GRANTED", "FINANCE_BILLING_PERMISSION_REVOKED"].every((a) => ev.includes(a))
        && au.rows.length >= 5 && au.rows.every((r) => !MONEY.test(JSON.stringify(r.new_value ?? {}))) && supAudit.rows[0]?.n === 0 && centralAudit.rows[0]?.n === 0 && toggles >= 4,
      `${ev.join(",")} audit=${au.rows.length} sup=${supAudit.rows[0]?.n} central=${centralAudit.rows[0]?.n} toggles=${toggles}`);

    // B11 Regressions: Finanzas untouched; other agencies untouched.
    const finA = await call("GET", `/organizations/${orgA}/finance/services`, adm.token);
    const finC = await call("GET", `/organizations/${orgC}/finance/services`, admC.token);
    const accC = await call("GET", `${B(orgC)}/access`, admC.token);
    check("B11 Finanzas works as before (200; agency without FINANZAS still 404); an agency without FACTURACION sees it off",
      finA.status === 200 && finC.status === 404 && accC.status === 200 && accC.body.module?.enabled === false, `${finA.status} ${finC.status} ${accC.status}`);

    const fives = all.filter((r) => r.status === 500);
    check("B12 no 500 in the whole run", fives.length === 0, fives.map((r) => JSON.stringify(r.body)).join(" "));
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
    await runtime.end();
    await db.end();
  }

  console.log("\nETNARA Facturación F2.1 — premium switch, permissions, security\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nBilling F2.1: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Billing F2.1 verification failed:", error);
  process.exit(1);
});
