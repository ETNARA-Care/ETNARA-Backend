/**
 * SmartMatch Gate 5: in-app notifications, over real HTTP with the server
 * connected as app_runtime. Synthetic data only, unique per run.
 *
 * Disposable databases only:
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") {
  throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
}
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>;
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);

  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
  }

  const org = async (name: string) =>
    (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgA = await org(`SM Gate5 A ${tag}`);
  const orgB = await org(`SM Gate5 B ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  for (const o of [orgA, orgB]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'G5') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  }
  type P = { email: string; userId: string; token: string; workerId?: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `sm5-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let workerId: string | undefined;
    if (worker) {
      workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Synthetic ${key}`])).rows[0].id;
      const owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
      await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [owm, orgId]);
      for (let d = 0; d < 7; d++) await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,'06:00','22:00')`, [owm, orgId, d]);
    }
    return { email, userId, token: "", workerId };
  }
  const A = {
    admin1: await person("a-admin1", orgA, ["ORGANIZATION_ADMIN"]),
    admin2: await person("a-admin2", orgA, ["ORGANIZATION_ADMIN"]),
    adminWorker: await person("a-adminworker", orgA, ["ORGANIZATION_ADMIN", "WORKER"], true),
    supervisor: await person("a-supervisor", orgA, ["SUPERVISOR"]),
    cg1: await person("a-cg1", orgA, ["WORKER"], true),
    cg2: await person("a-cg2", orgA, ["WORKER"], true),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]), cg: await person("b-cg", orgB, ["WORKER"], true) };
  for (const [p, o] of [...Object.values(A).map((p) => [p, orgA] as const), ...Object.values(B).map((p) => [p, orgB] as const)]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${p.email} ${r.status}`);
    p.token = r.body.token;
    await call("POST", "/me/active-organization", p.token, { organizationId: o });
  }
  const S = `/organizations/${orgA}/smartmatch`;
  const consent = { consent: true, consentVersion: "smartmatch-consent-v1" };
  async function opportunity(days: number) {
    const now = new Date(); const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, 14));
    const d = await call("POST", `${S}/opportunities`, A.admin1.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 4 * 3600e3).toISOString() });
    await call("POST", `${S}/opportunities/${d.body.opportunity.id}/publish`, A.admin1.token);
    return d.body.opportunity.id as string;
  }
  const smartmatch = async (p: P, appId?: string) => {
    const r = await call("GET", "/me/notifications?limit=100", p.token);
    return ((r.body.items ?? []) as Json[]).filter((n) => n.relatedEntityType === "smartmatch_application" && (!appId || n.relatedEntityId === appId));
  };
  const unread = (list: Json[]) => list.filter((n) => !n.readAt).length;

  try {
    // ---------------------------------------------------------- submission
    const opp1 = await opportunity(3);
    const a1 = await call("POST", `${S}/opportunities/${opp1}/applications`, A.cg1.token, consent);
    const app1 = a1.body.application.id as string;
    const n1 = await smartmatch(A.admin1, app1);
    const n2 = await smartmatch(A.admin2, app1);
    check("N1 every agency admin gets one 'new application' notification", n1.length === 1 && n2.length === 1 && n1[0]?.type === "SMARTMATCH_APPLICATION_SUBMITTED", `${n1.length},${n2.length}`);
    check("N2 notification is unread and has a Spanish summary", unread(n1) === 1 && n1[0]?.summary === "Nueva solicitud en SmartMatch", n1[0]?.summary);
    check("N3 deep link: points to the application id, no patient fields",
      n1[0]?.relatedEntityId === app1 && n1[0]?.careRecipientId === null && n1[0]?.shiftId === null && n1[0]?.workerMembershipId === null, JSON.stringify(n1[0] ?? null).slice(0, 120));
    const leak = n1[0] ? JSON.stringify(n1[0]).match(/first_name|last_name|diagnos|address|patient|display_name|email/i) : null;
    check("N4 notification carries no names, contact or clinical data", !!n1[0] && !leak, leak?.[0] ?? "");
    check("N5 supervisor gets no SmartMatch notification", (await smartmatch(A.supervisor)).length === 0);
    check("N6 agency B admin gets nothing from agency A", (await smartmatch(B.admin)).length === 0);
    check("N7 applicant caregiver gets no 'new application' notification", (await smartmatch(A.cg1)).length === 0);

    // Admin who is also a worker applies: colleagues are notified, not themself.
    const opp0 = await opportunity(2);
    const aw = await call("POST", `${S}/opportunities/${opp0}/applications`, A.adminWorker.token, consent);
    const awApp = aw.body.application?.id as string;
    check("N8 admin who applies is not notified about own application; other admins are",
      aw.status === 201 && (await smartmatch(A.adminWorker, awApp)).length === 0 && (await smartmatch(A.admin1, awApp)).length === 1, `status=${aw.status}`);

    // ---------------------------------------------------------- read state
    const mark = await call("PATCH", `/me/notifications/${n1[0]?.id}/read`, A.admin1.token);
    check("N9 admin marks the notification as read", mark.status === 200 && unread(await smartmatch(A.admin1, app1)) === 0, `status=${mark.status}`);
    check("N10 reading it does not mark the other admin's copy", unread(await smartmatch(A.admin2, app1)) === 1);
    const steal = await call("PATCH", `/me/notifications/${n2[0]?.id ?? randomUUID()}/read`, A.admin1.token);
    check("N11 an admin cannot touch another user's notification", steal.status === 404, `status=${steal.status}`);
    const stealB = await call("PATCH", `/me/notifications/${n2[0]?.id ?? randomUUID()}/read`, B.admin.token);
    check("N12 agency B cannot touch agency A notifications", stealB.status === 404, `status=${stealB.status}`);

    // ---------------------------------------------------------- withdrawal resolves the request
    const wd = await call("POST", `${S}/applications/${app1}/withdraw`, A.cg1.token);
    check("N13 withdrawal marks the admins' pending notification as resolved (read)",
      wd.status === 200 && unread(await smartmatch(A.admin2, app1)) === 0, `status=${wd.status}`);
    check("N14 withdrawal sends no new notification to admins", (await smartmatch(A.admin2, app1)).length === 1);

    // Re-apply -> new application, new notification.
    const re = await call("POST", `${S}/opportunities/${opp1}/applications`, A.cg1.token, consent);
    const app1b = re.body.application.id as string;
    check("N15 re-application notifies admins again (new application)", (await smartmatch(A.admin2, app1b)).length === 1);
    const a2 = await call("POST", `${S}/opportunities/${opp1}/applications`, A.cg2.token, consent);
    const app2 = a2.body.application.id as string;

    // ---------------------------------------------------------- decisions
    const ok = await call("POST", `${S}/applications/${app1b}/decision`, A.admin2.token, { decision: "APPROVE", confirm: true });
    const cg1n = await smartmatch(A.cg1, app1b);
    check("N16 approval notifies the caregiver once", ok.status === 200 && cg1n.length === 1 && cg1n[0]?.type === "SMARTMATCH_APPLICATION_APPROVED" && cg1n[0]?.summary === "Tu solicitud fue aprobada", cg1n.map((n) => n.type).join(","));
    const cg2n = await smartmatch(A.cg2, app2);
    check("N17 the other pending caregiver is told the opportunity was covered", cg2n.length === 1 && cg2n[0]?.type === "SMARTMATCH_APPLICATION_CLOSED", cg2n.map((n) => n.type).join(","));
    check("N18 decided applications no longer show as pending to admins",
      unread(await smartmatch(A.admin1, app1b)) === 0 && unread(await smartmatch(A.admin1, app2)) === 0);

    const opp2 = await opportunity(4);
    const r1 = await call("POST", `${S}/opportunities/${opp2}/applications`, A.cg2.token, consent);
    await call("POST", `${S}/applications/${r1.body.application.id}/decision`, A.admin1.token, { decision: "REJECT" });
    const rej = await smartmatch(A.cg2, r1.body.application.id);
    check("N19 rejection notifies the caregiver", rej.length === 1 && rej[0]?.type === "SMARTMATCH_APPLICATION_REJECTED");

    // ---------------------------------------------------------- isolation and idempotency
    check("N20 agency B caregiver received nothing", (await smartmatch(B.cg)).length === 0);
    const dupes = await q(`SELECT user_id, notification_type, related_entity_id, count(*) FROM notifications
                           WHERE related_entity_type='smartmatch_application' GROUP BY 1,2,3 HAVING count(*) > 1`);
    check("N21 no duplicate notification exists", dupes.rowCount === 0, `dupes=${dupes.rowCount}`);
    let blocked = false;
    try {
      await q(`INSERT INTO notifications (user_id,organization_id,notification_type,related_entity_type,related_entity_id,channel,status)
               VALUES ($1,$2,'SMARTMATCH_APPLICATION_APPROVED','smartmatch_application',$3,'in_app','sent')`, [A.cg1.userId, orgA, app1b]);
    } catch (e) { blocked = (e as { code?: string }).code === "23505"; }
    check("N22 the database rejects a duplicate notification (unique index)", blocked);
    const crossOrg = await q(`SELECT 1 FROM notifications n JOIN smartmatch_applications a ON a.id = n.related_entity_id
                              WHERE n.related_entity_type='smartmatch_application' AND n.organization_id <> a.organization_id`);
    check("N23 every SmartMatch notification belongs to the application's own agency", crossOrg.rowCount === 0);
    const phi = await q(`SELECT 1 FROM notifications WHERE related_entity_type='smartmatch_application' AND care_recipient_id IS NOT NULL`);
    check("N24 no SmartMatch notification references a patient", phi.rowCount === 0);

    const all = await call("POST", "/me/notifications/read-all", A.cg2.token);
    check("N25 caregiver can mark all notifications as read", all.status === 200 && unread(await smartmatch(A.cg2)) === 0, `status=${all.status}`);
  } finally {
    server.close();
    await pool.end();
    await db.end();
  }

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nSmartMatch notifications: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
