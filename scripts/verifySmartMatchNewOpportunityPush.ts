/**
 * Migration 155 — «Hay una nueva oportunidad en SmartMatch» (bell + Web Push), end to end on a
 * disposable database. Real app over HTTP as app_runtime and the real sender (runPushTick)
 * with a capturing transport that encrypts for real and decrypts with the phone's key.
 * Synthetic agencies, people and endpoints only.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { readFileSync } from "node:fs";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import webpush from "web-push";
// @ts-expect-error no types for http_ece (dependency of web-push)
import ece from "http_ece";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });
const TEXT = "Hay una nueva oportunidad en SmartMatch";
const TYPE = "SMARTMATCH_OPPORTUNITY_PUBLISHED";

async function main() {
  const vapidKeys = webpush.generateVAPIDKeys();
  Object.assign(process.env, {
    PUSH_ENABLED: "on", VAPID_PUBLIC_KEY: vapidKeys.publicKey, VAPID_PRIVATE_KEY: vapidKeys.privateKey,
    VAPID_SUBJECT: "mailto:soporte@example.invalid", PUSH_APP_BASE_URL: "https://app.example.invalid",
  });
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const origLog = console.log, origError = console.error;
  console.log = () => undefined; console.error = () => undefined;

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const { runPushTick } = await import("../src/modules/push/push.worker.js");
  const { pushVapidDetails } = await import("../src/modules/push/push.config.js");
  const { expireSmartMatchOpportunities } = await import("../src/modules/verification/verification.arrival.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  const statuses: number[] = [];
  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    statuses.push(res.status);
    const text = await res.text(); let json: Json = {}; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: json };
  }

  // ---------------------------------------------------------------- agencies
  // A: SmartMatch + push on (pilot). B: same, another agency. C: SmartMatch on, push off.
  const ORG_A = `Agencia Oportunidad A ${tag}`;
  const org = async (name: string, features: Record<string, boolean>) => {
    const id = (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
    for (const [code, on] of Object.entries(features)) await q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,$2,$3)`, [id, code, on]);
    return id;
  };
  const orgA = await org(ORG_A, { SMARTMATCH: true, PUSH_NOTIFICATIONS: true });
  const orgB = await org(`Agencia Oportunidad B ${tag}`, { SMARTMATCH: true, PUSH_NOTIFICATIONS: true });
  const orgC = await org(`Agencia Oportunidad C ${tag}`, { SMARTMATCH: true, PUSH_NOTIFICATIONS: false });

  type Phone = { endpoint: string; ecdh: ReturnType<typeof createECDH>; p256dh: string; auth: string };
  const newPhone = (): Phone => {
    const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
    return { endpoint: `https://fcm.googleapis.com/fcm/send/synthetic-${randomBytes(12).toString("hex")}`, ecdh,
      p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
  };
  type P = { key: string; email: string; userId: string; token: string; phone: Phone; org: string };
  const people: P[] = [];
  async function person(key: string, orgId: string, roles: string[], worker: "active" | "inactive" | false = false): Promise<P> {
    const email = `opp-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    if (worker) {
      const w = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Sintetica ${key}`])).rows[0].id;
      await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,$3,'caregiver')`, [w, orgId, worker]);
    }
    const p: P = { key, email, userId, token: "", phone: newPhone(), org: orgId };
    people.push(p); return p;
  }
  const A = {
    admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]), admin2: await person("a-admin2", orgA, ["ORGANIZATION_ADMIN"]),
    sup: await person("a-sup", orgA, ["SUPERVISOR"]), fam: await person("a-fam", orgA, ["FAMILY"]),
    cg1: await person("a-cg1", orgA, ["WORKER"], "active"), cg2: await person("a-cg2", orgA, ["WORKER"], "active"),
    cgQuiet: await person("a-cg-quiet", orgA, ["WORKER"], "active"), cgOut: await person("a-cg-out", orgA, ["WORKER"], "inactive"),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]), admin2: await person("b-admin2", orgB, ["ORGANIZATION_ADMIN"]), cg: await person("b-cg", orgB, ["WORKER"], "active") };
  const C = { admin: await person("c-admin", orgC, ["ORGANIZATION_ADMIN"]), admin2: await person("c-admin2", orgC, ["ORGANIZATION_ADMIN"]), cg: await person("c-cg", orgC, ["WORKER"], "active") };

  for (const p of people) {
    p.token = (await call("POST", "/auth/login", "", { email: p.email, password })).body.token;
    await call("POST", "/me/active-organization", p.token, { organizationId: p.org });
    const r = await call("POST", "/me/push/subscriptions", p.token, { endpoint: p.phone.endpoint, keys: { p256dh: p.phone.p256dh, auth: p.phone.auth }, deviceLabel: "Teléfono de prueba" });
    if (r.status !== 201) throw new Error(`register ${p.key} ${r.status} ${JSON.stringify(r.body)}`);
  }
  const now = (await q<{ h: string; e: string }>(`SELECT to_char((now() AT TIME ZONE 'America/Puerto_Rico') - interval '1 hour','HH24:MI') h, to_char((now() AT TIME ZONE 'America/Puerto_Rico') + interval '1 hour','HH24:MI') e`)).rows[0];
  await call("PUT", "/me/push/preferences", A.cgQuiet.token, { quietEnabled: true, quietStart: now.h, quietEnd: now.e, agencyAlerts: null });

  // ---------------------------------------------------------------- sender: real encryption, then decryption
  type Got = { endpoint: string; payload: Json };
  const received: Got[] = [];
  const sender = async (job: { endpoint: string; p256dh: string; auth: string; ttl_seconds: number; urgency: "normal" | "high" }, payload: string, vapid: { subject: string; publicKey: string; privateKey: string }) => {
    const details = webpush.generateRequestDetails({ endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth } }, payload,
      { TTL: job.ttl_seconds, urgency: job.urgency, vapidDetails: vapid, contentEncoding: "aes128gcm" });
    const phone = people.map((p) => p.phone).find((ph) => ph.endpoint === job.endpoint)!;
    const clear = ece.decrypt(details.body as Buffer, { version: "aes128gcm", privateKey: phone.ecdh, authSecret: phone.auth });
    received.push({ endpoint: job.endpoint, payload: JSON.parse(clear.toString("utf8")) });
    return 201;
  };
  const vapid = pushVapidDetails()!;
  const tick = async () => { const before = received.length; await runPushTick(sender as never, vapid); return received.slice(before); };
  const to = (got: Got[], p: P) => got.filter((g) => g.endpoint === p.phone.endpoint);
  const noticesOf = async (opp: string) => (await q<{ id: string; user_id: string; read_at: Date | null; care_recipient_id: string | null; related_entity_type: string; state: string | null; reason: string | null }>(
    `SELECT n.id, n.user_id, n.read_at, n.care_recipient_id, n.related_entity_type, ob.state, ob.reason
       FROM notifications n LEFT JOIN push_outbox ob ON ob.notification_id = n.id
      WHERE n.notification_type = $1 AND n.related_entity_id = $2`, [TYPE, opp])).rows;
  const of = (rows: Awaited<ReturnType<typeof noticesOf>>, p: P) => rows.filter((r) => r.user_id === p.userId);

  let day = 3;
  async function draft(orgId: string, creator: P) {
    const d0 = new Date(Date.now() + day++ * 86400e3); d0.setUTCHours(14, 0, 0, 0);
    const d = await call("POST", `/organizations/${orgId}/smartmatch/opportunities`, creator.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Acompañante",
      startsAt: d0.toISOString(), endsAt: new Date(d0.getTime() + 4 * 3600e3).toISOString() });
    const id = d.body.opportunity?.id as string;
    if (!id) throw new Error(`draft ${d.status} ${JSON.stringify(d.body)}`);
    return id;
  }
  const publish = (orgId: string, id: string, by: P) => call("POST", `/organizations/${orgId}/smartmatch/opportunities/${id}/publish`, by.token, {});

  // ---------------------------------------------------------------- N1 a draft notifies nobody
  const o1 = await draft(orgA, A.admin);
  check("N1 a draft notifies nobody", (await noticesOf(o1)).length === 0);

  // ---------------------------------------------------------------- N2–N5 publishing
  const pub1 = await publish(orgA, o1, A.admin2);
  const rows1 = await noticesOf(o1);
  check("N2 publishing: one bell notice for each ACTIVE caregiver of the agency", pub1.status === 200
    && [A.cg1, A.cg2, A.cgQuiet].every((p) => of(rows1, p).length === 1) && rows1.length === 3, `publish=${pub1.status} rows=${rows1.length}`);
  check("N2 nobody else: administrators, supervisor, family, inactive caregiver, other agencies, ETNARA Central",
    [A.admin, A.admin2, A.sup, A.fam, A.cgOut, B.admin, B.cg, C.cg].every((p) => of(rows1, p).length === 0));
  const bell = await call("GET", "/me/notifications", A.cg1.token);
  const item = (bell.body.items ?? []).find((i: Json) => i.type === TYPE);
  check("N3 the bell shows the general text, without municipality, role or time", !!item && item.summary === TEXT
    && !/Caguas|Acompañante|\d{1,2}:\d{2}/.test(item.summary) && !/Caguas|Acompañante/.test(JSON.stringify(item)), JSON.stringify(item ?? bell.body).slice(0, 200));
  check("N3 the notice carries no person receiving care", rows1.every((r) => r.care_recipient_id === null && r.related_entity_type === "smartmatch_opportunity"));
  const g1 = await tick();
  check("N4 push to caregivers with a phone: «ETNARA Care» + the general text", [A.cg1, A.cg2].every((p) => to(g1, p).length === 1
    && to(g1, p)[0].payload.notification.title === "ETNARA Care" && to(g1, p)[0].payload.notification.body === TEXT), JSON.stringify(g1.map((g) => g.payload.notification)));
  const all1 = JSON.stringify(g1.map((g) => g.payload));
  check("N4 nothing received names the agency, the municipality, the role, the time or a person",
    !all1.includes(ORG_A) && !/Caguas|Acompañante|@example\.invalid/.test(all1) && !all1.includes(o1));
  check("N5 quiet hours: the bell has it, the phone does not ring", to(g1, A.cgQuiet).length === 0 && of(rows1, A.cgQuiet).length === 1
    && (await noticesOf(o1)).find((r) => r.user_id === A.cgQuiet.userId)?.reason === "QUIET_HOURS");
  const target = await call("GET", `/me/notifications/${of(rows1, A.cg1)[0].id}/target`, A.cg1.token);
  check("N5 tapping it opens the caregiver's SmartMatch («Disponibles»)", target.status === 200 && target.body.path === "/caregiver/smartmatch"
    && target.body.portal === "caregiver", JSON.stringify(target.body));
  const targetOther = await call("GET", `/me/notifications/${of(rows1, A.cg1)[0].id}/target`, A.cg2.token);
  check("N5 another person cannot open someone else's notice", targetOther.status === 404, String(targetOther.status));

  // ---------------------------------------------------------------- N6 bursts: at most one push every 30 min
  const o2 = await draft(orgA, A.admin);
  await publish(orgA, o2, A.admin2);
  const g2 = await tick();
  const rows2 = await noticesOf(o2);
  check("N6 a second publication within 30 min: in the bell, but the phone does not ring again (OPPORTUNITY_THROTTLED)",
    to(g2, A.cg1).length === 0 && to(g2, A.cg2).length === 0 && of(rows2, A.cg1).length === 1
    && of(rows2, A.cg1)[0].reason === "OPPORTUNITY_THROTTLED", JSON.stringify(rows2.map((r) => r.reason)));
  await q(`UPDATE notifications SET created_at = now() - interval '31 minutes' WHERE notification_type = $1`, [TYPE]);

  // ---------------------------------------------------------------- N7 closed before sending: nothing rings, bell marked read
  const o3 = await draft(orgA, A.admin);
  await publish(orgA, o3, A.admin2);
  const cancel = await call("POST", `/organizations/${orgA}/smartmatch/opportunities/${o3}/cancel`, A.admin.token, { reason: "NO_LONGER_NEEDED" });
  const g3 = await tick();
  const rows3 = await noticesOf(o3);
  check("N7 cancelled before the push left: nothing rings (OPPORTUNITY_CLOSED) and the bell notice is marked read",
    cancel.status === 200 && to(g3, A.cg1).length === 0 && rows3.length === 3 && rows3.every((r) => r.read_at !== null)
    && of(rows3, A.cg1)[0].reason === "OPPORTUNITY_CLOSED", `cancel=${cancel.status} ${JSON.stringify(cancel.body).slice(0, 80)} ${JSON.stringify(rows3.map((r) => r.reason))}`);

  // ---------------------------------------------------------------- N8 expiry marks the notices read
  await q(`UPDATE smartmatch_opportunities SET expires_at = now() WHERE id = $1`, [o1]);
  await expireSmartMatchOpportunities();
  check("N8 an expired opportunity: its notices are marked read", (await noticesOf(o1)).every((r) => r.read_at !== null));

  // ---------------------------------------------------------------- N9 agency with push off; N10 other agency
  const oc = await draft(orgC, C.admin);
  await publish(orgC, oc, C.admin2);
  const gC = await tick();
  const rowsC = await noticesOf(oc);
  check("N9 agency with PUSH_NOTIFICATIONS off: the bell has it, the phone does not ring (FEATURE_OFF)",
    to(gC, C.cg).length === 0 && of(rowsC, C.cg).length === 1 && of(rowsC, C.cg)[0].reason === "FEATURE_OFF", JSON.stringify(rowsC.map((r) => r.reason)));
  const ob = await draft(orgB, B.admin);
  await publish(orgB, ob, B.admin2);
  const gB = await tick();
  check("N10 agency B's opportunity reaches only B's caregivers", to(gB, B.cg).length === 1 && to(gB, A.cg1).length === 0 && to(gB, A.cg2).length === 0
    && (await noticesOf(ob)).every((r) => r.user_id === B.cg.userId));

  // ---------------------------------------------------------------- N11 SmartMatch switched off: nothing new
  await q(`UPDATE organization_features SET enabled = false WHERE organization_id = $1 AND feature_code = 'SMARTMATCH'`, [orgB]);
  const offDraft = await call("POST", `/organizations/${orgB}/smartmatch/opportunities`, B.admin.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Acompañante",
    startsAt: new Date(Date.now() + 20 * 86400e3).toISOString(), endsAt: new Date(Date.now() + 20 * 86400e3 + 4 * 3600e3).toISOString() });
  check("N11 agency with SmartMatch off: it cannot create opportunities, so no new notices",
    offDraft.status === 404 && (await q(`SELECT count(*)::int n FROM notifications WHERE organization_id=$1 AND notification_type=$2`, [orgB, TYPE])).rows[0].n === 1,
    `draft=${offDraft.status} ${offDraft.body.error ?? ""}`);

  // ---------------------------------------------------------------- N12 one notice per person and opportunity; privileges
  let dup = "";
  try { await q(`INSERT INTO notifications (user_id,organization_id,notification_type,related_entity_type,related_entity_id,channel,status,sent_at) VALUES ($1,$2,$3,'smartmatch_opportunity',$4,'in_app','sent',now())`, [A.cg1.userId, orgA, TYPE, o2]); } catch (e) { dup = (e as Error).message; }
  check("N12 a second notice for the same person and opportunity is refused (unique index)", /duplicate key/.test(dup), dup);
  const execPublic = (await q<{ n: number }>(`SELECT count(*)::int n FROM pg_proc p WHERE p.proname = 'app_smartmatch_opportunity_publish_notify' AND has_function_privilege('public', p.oid, 'EXECUTE')`)).rows[0].n;
  check("N12 the trigger function is not executable by PUBLIC", execPublic === 0);
  check("N13 no 5xx", statuses.every((s) => s < 500), statuses.filter((s) => s >= 500).join(","));

  // ---------------------------------------------------------------- N14 rollback and re-apply
  await pool.end().catch(() => undefined); server.close();
  await q(readFileSync(new URL("../ops/155_smartmatch_new_opportunity_push.rollback.sql", import.meta.url), "utf8"));
  const left = (await q<{ t: number; c: number; i: number }>(`SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgname='smartmatch_opportunity_publish_notify') t,
     (SELECT count(*)::int FROM push_notification_catalog WHERE notification_type=$1) c,
     (SELECT count(*)::int FROM pg_class WHERE relname='idx_notifications_smartmatch_published_once') i`, [TYPE])).rows[0];
  const kept = (await q(`SELECT count(*)::int n FROM notifications WHERE notification_type=$1`, [TYPE])).rows[0].n;
  check("N14 rollback removes trigger, catalog row and index; notices already sent stay in the bell", left.t === 0 && left.c === 0 && left.i === 0 && kept > 0, JSON.stringify(left));
  for (let i = 0; i < 2; i++) await q(readFileSync(new URL("../migrations/155_smartmatch_new_opportunity_push.sql", import.meta.url), "utf8"));
  check("N14 155 re-applies cleanly twice", (await q(`SELECT count(*)::int n FROM pg_trigger WHERE tgname='smartmatch_opportunity_publish_notify'`)).rows[0].n === 1);

  console.log = origLog; console.error = origError;
  await db.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) origLog(`${r.pass ? "PASS" : "FAIL"} ${r.check}${r.pass ? "" : `  →  ${r.detail}`}`);
  origLog(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`); for (const r of results) process.stdout.write(`${r.pass ? "PASS" : "FAIL"} ${r.check}${r.pass ? "" : `  →  ${r.detail}`}\n`); process.exit(1); });
