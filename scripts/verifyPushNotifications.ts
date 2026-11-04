/**
 * Web Push (146) — end-to-end verification on a disposable database.
 *
 * Real app over HTTP as app_runtime; the real sender code (runPushTick) with a capturing
 * transport that does the REAL encryption (web-push generateRequestDetails: RFC 8291 +
 * VAPID RFC 8292) and then DECRYPTS each message with the phone's private key, so every
 * check is made on what a phone would actually receive. No network, no real push service.
 * Synthetic people, residents and endpoints only.
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
  const runtime = new pg.Client({ connectionString: u.toString() });
  await runtime.connect();
  const logged: string[] = [];
  const origLog = console.log, origError = console.error;
  console.log = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.error = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const { runPushTick, runPushCleanup, startPushWorker } = await import("../src/modules/push/push.worker.js");
  const { pushVapidDetails } = await import("../src/modules/push/push.config.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json: Json = {}; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: json };
  }
  async function rt(userId: string, text: string, superadmin = false) {
    await runtime.query("BEGIN");
    try {
      await runtime.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id','',true), set_config('app.is_superadmin',$2,true)`, [userId, superadmin ? "true" : "false"]);
      const r = await runtime.query(text); await runtime.query("ROLLBACK"); return { rows: r.rows as Json[], error: null as string | null };
    } catch (e) { await runtime.query("ROLLBACK").catch(() => undefined); return { rows: [] as Json[], error: (e as Error).message }; }
  }

  // ---------------------------------------------------------------- fixtures: agencies A, B (push on), C (push off)
  const org = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const ORG_A_NAME = `Agencia Pushprueba A ${tag}`;
  const orgA = await org(ORG_A_NAME), orgB = await org(`Agencia Pushprueba B ${tag}`), orgC = await org(`Agencia Pushprueba C ${tag}`);
  const pushOn = (o: string, on: boolean) => q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'PUSH_NOTIFICATIONS',$2)
    ON CONFLICT (organization_id,feature_code) DO UPDATE SET enabled=EXCLUDED.enabled`, [o, on]);
  await pushOn(orgA, true); await pushOn(orgB, true); await pushOn(orgC, false);

  type Phone = { endpoint: string; ecdh: ReturnType<typeof createECDH>; p256dh: string; auth: string };
  const newPhone = (): Phone => {
    const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
    return { endpoint: `https://fcm.googleapis.com/fcm/send/synthetic-${randomBytes(12).toString("hex")}`, ecdh,
      p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
  };
  type P = { key: string; email: string; userId: string; token: string; sessionId: string; phone: Phone; org: string; owm?: string };
  const people: P[] = [];
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `push-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let owm: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Sintetica ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
    }
    const p: P = { key, email, userId, token: "", sessionId: "", phone: newPhone(), org: orgId, owm };
    people.push(p); return p;
  }
  const A = {
    admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]), adminOff: await person("a-admin-off", orgA, ["ORGANIZATION_ADMIN"]),
    sup: await person("a-sup", orgA, ["SUPERVISOR"]), supIn: await person("a-sup-in", orgA, ["SUPERVISOR"]),
    cg: await person("a-cg", orgA, ["WORKER"], true), cgQuiet: await person("a-cg-quiet", orgA, ["WORKER"], true),
    cgOut: await person("a-cg-out", orgA, ["WORKER"], true),
    fam: await person("a-fam", orgA, ["FAMILY"]), famMuted: await person("a-fam-muted", orgA, ["FAMILY"]), famOther: await person("a-fam-other", orgA, ["FAMILY"]),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]), cg: await person("b-cg", orgB, ["WORKER"], true) };
  const C = { admin: await person("c-admin", orgC, ["ORGANIZATION_ADMIN"]) };
  // Supervisor in A AND administrator in B (multi-agency).
  const multi = await person("multi", orgA, ["ORGANIZATION_ADMIN"]);
  { const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [multi.userId, orgB])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='ORGANIZATION_ADMIN'`, [m, orgB]); }
  const platformUser = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [`push-platform-${tag}@example.invalid`, hash])).rows[0].id;
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [platformUser]);

  const RESIDENT = `Pushresidente${tag}`;
  const recipient = async (o: string, last: string) => (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Sintetica',$2,'active') RETURNING id`, [o, last])).rows[0].id;
  const rA = await recipient(orgA, RESIDENT), rA2 = await recipient(orgA, `Otro${tag}`), rB = await recipient(orgB, `B${tag}`);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_receive_notifications) VALUES ($1,$2,$3,'hija','active',true)`, [A.fam.userId, orgA, rA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_receive_notifications) VALUES ($1,$2,$3,'hijo','active',false)`, [A.famMuted.userId, orgA, rA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_receive_notifications) VALUES ($1,$2,$3,'nieta','active',true)`, [A.famOther.userId, orgA, rA2]);
  const shiftA = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()+interval '2 hours',now()+interval '6 hours','confirmed') RETURNING id`, [orgA, rA])).rows[0].id;
  const shiftB = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()+interval '2 hours',now()+interval '6 hours','confirmed') RETURNING id`, [orgB, rB])).rows[0].id;

  // ---------------------------------------------------------------- login, config and registration
  for (const p of people) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    p.token = r.body.token;
    p.sessionId = (await q<{ id: string }>(`SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [p.userId])).rows[0].id;
  }
  const cfg = await call("GET", "/me/push/config", A.admin.token);
  check("R1 config: enabled with the VAPID public key only (never the private key)", cfg.status === 200 && cfg.body.enabled === true
    && cfg.body.publicKey === vapidKeys.publicKey && !JSON.stringify(cfg.body).includes(vapidKeys.privateKey), JSON.stringify(cfg.body).slice(0, 80));
  check("R1 config needs a session", (await call("GET", "/me/push/config", "")).status === 401);

  const reg = (p: P, phone = p.phone, label = "iPhone de prueba") => call("POST", "/me/push/subscriptions", p.token,
    { endpoint: phone.endpoint, keys: { p256dh: phone.p256dh, auth: phone.auth }, deviceLabel: label });
  const bad = async (endpoint: string) => (await call("POST", "/me/push/subscriptions", A.admin.token, { endpoint, keys: { p256dh: A.admin.phone.p256dh, auth: A.admin.phone.auth } }));
  const r1 = await bad("https://evil.example.invalid/push/abc"), r2 = await bad("http://fcm.googleapis.com/fcm/send/x1234567890"),
    r3 = await bad("https://169.254.169.254/latest/meta-data"), r4 = await bad("https://fcm.googleapis.com.evil.example/fcm/send/x"),
    r5 = await bad("https://fcm.googleapis.com@evil.example/fcm/send/x");
  check("R2 only known push services (no arbitrary hosts, http, metadata IP, look-alike hosts, userinfo)",
    [r1, r2, r3, r4, r5].every((r) => r.status === 400), [r1, r2, r3, r4, r5].map((r) => `${r.status}:${r.body.error}`).join(" "));
  const badKeys = await call("POST", "/me/push/subscriptions", A.admin.token, { endpoint: A.admin.phone.endpoint, keys: { p256dh: "x", auth: "y" } });
  check("R2 malformed keys refused", badKeys.status === 400, String(badKeys.status));
  for (const p of people) { const r = await reg(p); if (r.status !== 201) check(`R2 register ${p.key}`, false, `${r.status} ${JSON.stringify(r.body)}`); }
  check("R2 every synthetic person registers her phone", (await q(`SELECT count(*)::int n FROM push_subscriptions`)).rows[0].n >= people.length);
  const again = await reg(A.admin);
  check("R2 re-registering the same phone keeps ONE subscription", again.status === 201
    && (await q(`SELECT count(*)::int n FROM push_subscriptions WHERE user_id=$1`, [A.admin.userId])).rows[0].n === 1);
  // Central: no platform login session is needed to prove the database refuses it.
  const centralReg = await rt(platformUser, `SELECT app_push_register('${randomUUID()}', 'https://fcm.googleapis.com/fcm/send/central123456', '${A.admin.phone.p256dh}', '${A.admin.phone.auth}', NULL)`, true);
  check("R2 ETNARA Central cannot register (superadmin context refused)", /PUSH_NOT_ALLOWED/.test(centralReg.error ?? ""), centralReg.error ?? "");
  const otherSession = await rt(A.admin.userId, `SELECT app_push_register('${B.admin.sessionId}', 'https://fcm.googleapis.com/fcm/send/stolen1234567', '${A.admin.phone.p256dh}', '${A.admin.phone.auth}', NULL)`);
  check("R2 a session of another person is refused", /PUSH_SESSION_INVALID/.test(otherSession.error ?? ""), otherSession.error ?? "");

  // ---------------------------------------------------------------- RLS and isolation
  const seeOwn = await rt(A.admin.userId, `SELECT user_id FROM push_subscriptions`);
  check("R3 a person sees only her own phones", !seeOwn.error && seeOwn.rows.length === 1 && seeOwn.rows[0].user_id === A.admin.userId, String(seeOwn.rows.length));
  const centralSee = await rt(platformUser, `SELECT count(*)::int n FROM push_subscriptions`, true);
  check("R3 ETNARA Central reads no subscription", !centralSee.error && centralSee.rows[0].n === 0, centralSee.error ?? JSON.stringify(centralSee.rows));
  const delOther = await rt(A.admin.userId, `DELETE FROM push_subscriptions WHERE user_id='${B.admin.userId}' RETURNING id`);
  check("R3 deleting another person's phone affects nothing", !delOther.error && delOther.rows.length === 0, delOther.error ?? "");
  const direct = await rt(A.admin.userId, `INSERT INTO push_subscriptions (user_id,session_id,endpoint,p256dh,auth) VALUES ('${A.admin.userId}','${A.admin.sessionId}','https://evil.example/x123456789012345','${A.admin.phone.p256dh}','${A.admin.phone.auth}')`);
  check("R3 app_runtime cannot insert a subscription directly (only through the validating function)", /permission denied/.test(direct.error ?? ""), direct.error ?? "");
  for (const t of ["push_outbox", "push_deliveries", "push_subscription_events", "push_notification_catalog"]) {
    const r = await rt(A.admin.userId, `SELECT count(*) FROM ${t}`);
    check(`R3 app_runtime has no direct access to ${t}`, /permission denied/.test(r.error ?? ""), r.error ?? "readable");
  }
  const claimCtx = await rt(A.admin.userId, `SELECT * FROM app_push_claim(5)`);
  check("R3 the sending functions refuse a request context", /BACKGROUND_JOB_ONLY/.test(claimCtx.error ?? ""), claimCtx.error ?? "");
  const resolveOther = await rt(A.admin.userId, `SELECT reason FROM app_push_resolve((SELECT id FROM notifications WHERE user_id='${B.admin.userId}' LIMIT 1))`);
  check("R3 app_push_resolve says nothing about another person's notices", !resolveOther.error, resolveOther.error ?? "");

  // ---------------------------------------------------------------- capturing transport: real encryption, then decryption
  type Got = { endpoint: string; payload: Json; headers: Record<string, string> };
  const received: Got[] = [];
  const statusFor = new Map<string, number[]>();
  const sender = async (job: { endpoint: string; p256dh: string; auth: string; ttl_seconds: number; urgency: "normal" | "high" }, payload: string, vapid: { subject: string; publicKey: string; privateKey: string }) => {
    const details = webpush.generateRequestDetails({ endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth } }, payload,
      { TTL: job.ttl_seconds, urgency: job.urgency, vapidDetails: vapid, contentEncoding: "aes128gcm" });
    const phone = people.map((p) => p.phone).concat(extraPhones).find((ph) => ph.endpoint === job.endpoint)!;
    const clear = ece.decrypt(details.body as Buffer, { version: "aes128gcm", privateKey: phone.ecdh, authSecret: phone.auth });
    received.push({ endpoint: job.endpoint, payload: JSON.parse(clear.toString("utf8")), headers: details.headers as Record<string, string> });
    const queue = statusFor.get(job.endpoint);
    return queue && queue.length ? queue.shift()! : 201;
  };
  const extraPhones: Phone[] = [];
  const vapid = pushVapidDetails()!;
  const tick = async () => { const before = received.length; await runPushTick(sender as never, vapid); return received.slice(before); };
  const notify = async (p: P, type: string, orgId: string | null, extra: { entityType?: string; entityId?: string; recipient?: string | null } = {}) =>
    (await q<{ id: string }>(`INSERT INTO notifications (user_id,organization_id,notification_type,related_entity_type,related_entity_id,care_recipient_id,channel,status,sent_at)
      VALUES ($1,$2,$3,$4,$5,$6,'in_app','sent',now()) RETURNING id`, [p.userId, orgId, type, extra.entityType ?? "shift", extra.entityId ?? shiftA, extra.recipient ?? null])).rows[0].id;
  const to = (got: Got[], p: P) => got.filter((g) => g.endpoint === p.phone.endpoint);
  const reasonOf = async (id: string) => (await q<{ state: string; reason: string | null }>(`SELECT state, reason FROM push_outbox WHERE notification_id=$1`, [id])).rows[0];

  // S1 agency: administrator by default, payload content
  const nAcc = await notify(A.admin, "SHIFT_ASSIGNMENT_ACCEPTED", orgA);
  const g1 = await tick();
  const p1 = to(g1, A.admin)[0];
  check("S1 administrator receives «Una cuidadora aceptó un turno»", p1?.payload?.notification?.body === "Una cuidadora aceptó un turno"
    && p1.payload.notification.title === "ETNARA Care", JSON.stringify(p1?.payload ?? null));
  check("S1 payload: only web_push + notification{title, body, navigate, lang, dir, silent}", !!p1 && p1.payload.web_push === 8030
    && Object.keys(p1.payload).sort().join() === "notification,web_push"
    && Object.keys(p1.payload.notification).sort().join() === "body,dir,lang,navigate,silent,title");
  check("S1 link carries only the opaque notice id", p1?.payload?.notification?.navigate === `https://app.example.invalid/abrir?n=${nAcc}`, p1?.payload?.notification?.navigate);
  check("S1 VAPID: Authorization «vapid t=…, k=<public key>», aes128gcm, TTL and Urgency set", !!p1
    && p1.headers.Authorization.startsWith("vapid t=") && p1.headers.Authorization.includes(`k=${vapidKeys.publicKey}`)
    && p1.headers["Content-Encoding"] === "aes128gcm" && String(p1.headers.TTL) === "21600" && (p1.headers.Urgency ?? "normal") === "normal", JSON.stringify(p1?.headers ?? {}).slice(0, 160));

  // S2 preferences: admin opted out, supervisor default off, supervisor opted in
  await call("PUT", "/me/push/preferences", A.adminOff.token, { quietEnabled: false, quietStart: "22:00", quietEnd: "07:00", agencyAlerts: false });
  const prefIn = await call("PUT", "/me/push/preferences", A.supIn.token, { quietEnabled: false, quietStart: "22:00", quietEnd: "07:00", agencyAlerts: true });
  check("S2 preferences API: supervisor role and effective value", prefIn.status === 200 && prefIn.body.agencyRole === "supervisor" && prefIn.body.agencyAlertsEffective === true, JSON.stringify(prefIn.body));
  const nOff = await notify(A.adminOff, "SHIFT_DELAY_REPORTED", orgA), nSup = await notify(A.sup, "SHIFT_DELAY_REPORTED", orgA), nSupIn = await notify(A.supIn, "SHIFT_DELAY_REPORTED", orgA);
  const g2 = await tick();
  check("S2 administrator who turned agency alerts off: no push", to(g2, A.adminOff).length === 0 && (await reasonOf(nOff)).reason === "AGENCY_ALERTS_OFF");
  check("S2 supervisor by default: no push (decision 2)", to(g2, A.sup).length === 0 && (await reasonOf(nSup)).reason === "SUPERVISOR_NOT_OPTED_IN");
  check("S2 supervisor who opted in: push, «high» urgency", to(g2, A.supIn).length === 1 && to(g2, A.supIn)[0].headers.Urgency === "high" && !!nSupIn);

  // S3 incidents: agency yes, family never (decision 1)
  const incidentId = randomUUID();
  const nIncAdmin = await notify(A.admin, "NEW_INCIDENT", orgA, { entityType: "incident", entityId: incidentId, recipient: rA });
  const nIncFam = await notify(A.fam, "NEW_INCIDENT", orgA, { entityType: "incident", entityId: incidentId, recipient: rA });
  const g3 = await tick();
  check("S3 incident: administrator receives «Se registró un incidente nuevo»", to(g3, A.admin)[0]?.payload.notification.body === "Se registró un incidente nuevo" && !!nIncAdmin);
  check("S3 incident: family gets NO push (inbox only)", to(g3, A.fam).length === 0 && (await reasonOf(nIncFam)).reason === "NOT_FOR_THIS_ROLE");
  const inbox = await call("GET", "/me/notifications", A.fam.token);
  check("S3 …and the incident is still in the family inbox", (inbox.body.items ?? []).some((i: Json) => i.id === nIncFam));

  // S4 family: arrival once, muted relative, other resident
  const nArr = await notify(A.fam, "FAMILY_CAREGIVER_ARRIVED", orgA, { recipient: rA });
  const nStart = await notify(A.fam, "SHIFT_STARTED", orgA, { recipient: rA });
  const nMuted = await notify(A.famMuted, "FAMILY_CAREGIVER_ARRIVED", orgA, { recipient: rA });
  const nOther = await notify(A.famOther, "FAMILY_CAREGIVER_ARRIVED", orgA, { recipient: rA });
  const g4 = await tick();
  check("S4 family: «La cuidadora llegó» once (SHIFT_STARTED after the arrival does not ring again)",
    to(g4, A.fam).length === 1 && to(g4, A.fam)[0].payload.notification.body === "La cuidadora llegó" && (await reasonOf(nStart)).reason === "DUPLICATE_ARRIVAL" && !!nArr);
  check("S4 relative without notice permission: no push", to(g4, A.famMuted).length === 0 && (await reasonOf(nMuted)).reason === "NOT_FOR_THIS_ROLE");
  check("S4 relative of ANOTHER resident: no push for this resident", to(g4, A.famOther).length === 0 && (await reasonOf(nOther)).reason === "NOT_FOR_THIS_ROLE");
  const threadId = randomUUID();
  await notify(A.fam, "NEW_MESSAGE", orgA, { entityType: "message_thread", entityId: threadId });
  const nMsgAdmin = await notify(A.admin, "NEW_MESSAGE", orgA, { entityType: "message_thread", entityId: threadId });
  const g4b = await tick();
  check("S4 family message: «Tienes un mensaje nuevo»; agency messages are not pushed", to(g4b, A.fam)[0]?.payload.notification.body === "Tienes un mensaje nuevo"
    && to(g4b, A.admin).length === 0 && (await reasonOf(nMsgAdmin)).reason === "NOT_FOR_THIS_ROLE");

  // S5 caregiver
  const nPend = await notify(A.cg, "SHIFT_ASSIGNMENT_PENDING", orgA, { entityType: "shift", entityId: shiftA });
  await notify(A.cg, "SHIFT_RESCHEDULED", orgA); await notify(A.cg, "SHIFT_LOCATION_CHANGED", orgA); await notify(A.cg, "SHIFT_CANCELLED", orgA);
  const g5 = await tick();
  check("S5 caregiver: new shift, schedule change, address change, cancellation", to(g5, A.cg).map((g) => g.payload.notification.body).sort().join("|")
    === ["Cambió el horario de uno de tus turnos", "Cambió la dirección de uno de tus turnos", "Se canceló uno de tus turnos", "Tienes un turno nuevo pendiente de respuesta"].sort().join("|") && !!nPend,
    to(g5, A.cg).map((g) => g.payload.notification.body).join("|"));

  // S6 isolation: feature off, other agency, forged organisation
  const nC = await notify(C.admin, "SHIFT_ASSIGNMENT_ACCEPTED", orgC);
  await notify(B.admin, "SHIFT_ASSIGNMENT_ACCEPTED", orgB, { entityId: shiftB });
  const nForged = await notify(A.admin, "SHIFT_ASSIGNMENT_ACCEPTED", orgB, { entityId: shiftB });
  const g6 = await tick();
  check("S6 agency with PUSH_NOTIFICATIONS off: nothing sent", to(g6, C.admin).length === 0 && (await reasonOf(nC)).reason === "FEATURE_OFF");
  check("S6 agency B's notice reaches only B's phone", to(g6, B.admin).length === 1 && to(g6, A.admin).length === 0);
  check("S6 a notice tied to an agency the person does not belong to is never sent", (await reasonOf(nForged)).reason === "NO_ACTIVE_MEMBERSHIP");

  // S7 quiet hours (per person; inbox unchanged)
  const now = (await q<{ h: string; e: string }>(`SELECT to_char((now() AT TIME ZONE 'America/Puerto_Rico') - interval '1 hour','HH24:MI') h, to_char((now() AT TIME ZONE 'America/Puerto_Rico') + interval '1 hour','HH24:MI') e`)).rows[0];
  const quiet = await call("PUT", "/me/push/preferences", A.cgQuiet.token, { quietEnabled: true, quietStart: now.h, quietEnd: now.e, agencyAlerts: null });
  const nQuiet = await notify(A.cgQuiet, "SHIFT_CANCELLED", orgA);
  const g7 = await tick();
  check("S7 quiet hours: no push, notice still in the inbox", quiet.status === 200 && to(g7, A.cgQuiet).length === 0 && (await reasonOf(nQuiet)).reason === "QUIET_HOURS"
    && ((await call("GET", "/me/notifications", A.cgQuiet.token)).body.items ?? []).some((i: Json) => i.id === nQuiet));
  const badRange = await call("PUT", "/me/push/preferences", A.cgQuiet.token, { quietEnabled: true, quietStart: "22:00", quietEnd: "22:00", agencyAlerts: null });
  check("S7 an empty quiet range is refused", badRange.status === 400);

  // S8 logout and password change remove that session's phones; S9 session expiry does not
  const logout = await call("POST", "/auth/logout", A.cgOut.token);
  check("S8 logout removes the phones of that session", logout.status < 300 && (await q(`SELECT count(*)::int n FROM push_subscriptions WHERE user_id=$1`, [A.cgOut.userId])).rows[0].n === 0
    && (await q(`SELECT count(*)::int n FROM push_subscription_events WHERE user_id=$1 AND reason='SESSION_ENDED'`, [A.cgOut.userId])).rows[0].n === 1);
  const nAfterLogout = await notify(A.cgOut, "SHIFT_CANCELLED", orgA);
  const g8 = await tick();
  check("S8 …and nothing is sent to that phone afterwards", to(g8, A.cgOut).length === 0 && (await reasonOf(nAfterLogout)) === undefined);
  await q(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id=$1`, [A.cg.sessionId]);
  await notify(A.cg, "SHIFT_UNASSIGNED", orgA);
  const g9 = await tick();
  check("S9 an EXPIRED (not closed) session keeps the phone: notices still arrive (decision 5)", to(g9, A.cg).length === 1);
  await q(`UPDATE sessions SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL`, [A.cg.userId]);
  check("S8 password change (all sessions revoked) removes every phone of the person",
    (await q(`SELECT count(*)::int n FROM push_subscriptions WHERE user_id=$1`, [A.cg.userId])).rows[0].n === 0);

  // S10 agency suspended: B-only people lose their phones; multi-agency person keeps hers, but nothing from B
  await notify(B.cg, "SHIFT_CANCELLED", orgB, { entityId: shiftB }); // queued, not yet sent
  await q(`UPDATE organizations SET status='suspended' WHERE id=$1`, [orgB]);
  const bLeft = (await q(`SELECT count(*)::int n FROM push_subscriptions WHERE user_id = ANY($1)`, [[B.admin.userId, B.cg.userId]])).rows[0].n;
  const ev = (await q<{ reason: string; subscription_count: number }>(`SELECT reason, subscription_count FROM push_subscription_events WHERE organization_id=$1 ORDER BY reason`, [orgB])).rows;
  check("S10 suspension revokes the phones of people whose only access was that agency, with an audit event (counts only)",
    bLeft === 0 && ev.some((e) => e.reason === "ORGANIZATION_SUSPENDED" && e.subscription_count === 2), JSON.stringify(ev));
  check("S10 a person with access in another agency keeps her phone (audited as UNLINKED_OTHER_ACCESS_KEPT)",
    (await q(`SELECT count(*)::int n FROM push_subscriptions WHERE user_id=$1`, [multi.userId])).rows[0].n === 1 && ev.some((e) => e.reason === "UNLINKED_OTHER_ACCESS_KEPT"));
  const nMultiB = await notify(multi, "SHIFT_ASSIGNMENT_ACCEPTED", orgB, { entityId: shiftB });
  await notify(multi, "SHIFT_ASSIGNMENT_ACCEPTED", orgA);
  const g10 = await tick();
  check("S10 …and receives agency A's notices but nothing from suspended B", to(g10, multi).length === 1 && (await reasonOf(nMultiB)).reason === "ORGANIZATION_INACTIVE");
  const reB = await reg(B.admin);
  check("S10 while suspended, B-only people cannot re-register", reB.status === 403 && reB.body.error === "PUSH_NO_ACTIVE_ACCESS", `${reB.status} ${reB.body.error}`);
  const evCols = (await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='push_subscription_events'`)).rows.map((r) => r.column_name);
  check("S10 the audit table has no endpoint or key column", !evCols.some((c) => /endpoint|p256dh|auth/.test(c)), evCols.join(","));
  await q(`UPDATE organizations SET status='active' WHERE id=$1`, [orgB]);
  check("S10 after reactivation the person can activate again", (await reg(B.admin)).status === 201);

  // S11 caregiver deactivated / membership revoked
  await q(`UPDATE organization_worker_memberships SET status='inactive' WHERE id=$1`, [A.cgQuiet.owm]);
  await call("PUT", "/me/push/preferences", A.cgQuiet.token, { quietEnabled: false, quietStart: "22:00", quietEnd: "07:00", agencyAlerts: null });
  const nInactive = await notify(A.cgQuiet, "SHIFT_ASSIGNMENT_PENDING", orgA);
  const g11 = await tick();
  check("S11 inactive caregiver: no push", to(g11, A.cgQuiet).length === 0 && (await reasonOf(nInactive)).reason === "NOT_FOR_THIS_ROLE");
  await q(`UPDATE organization_memberships SET status='revoked', revoked_at=now() WHERE user_id=$1`, [A.cgQuiet.userId]);
  const clean = await runPushCleanup();
  check("S11 cleanup removes the phones of people with no active access", (await q(`SELECT count(*)::int n FROM push_subscriptions WHERE user_id=$1`, [A.cgQuiet.userId])).rows[0].n === 0
    && (clean.noAccess ?? 0) >= 1, JSON.stringify(clean));

  // S12 push-service answers: 410 removes, 500 retries with backoff, 400 fails
  statusFor.set(A.supIn.phone.endpoint, [410]);
  await notify(A.supIn, "SHIFT_LATE_ARRIVAL", orgA, { entityId: randomUUID() });
  await tick();
  check("S12 410 Gone: the phone is removed (ENDPOINT_GONE)", (await q(`SELECT count(*)::int n FROM push_subscriptions WHERE user_id=$1`, [A.supIn.userId])).rows[0].n === 0
    && (await q(`SELECT count(*)::int n FROM push_subscription_events WHERE user_id=$1 AND reason='ENDPOINT_GONE'`, [A.supIn.userId])).rows[0].n === 1);
  statusFor.set(A.admin.phone.endpoint, [503]);
  const nRetry = await notify(A.admin, "SHIFT_LATE_ARRIVAL", orgA, { entityId: randomUUID() });
  await tick();
  const d1 = (await q<{ state: string; attempts: number; wait: number }>(`SELECT state, attempts, extract(epoch FROM next_attempt_at - now())::int wait FROM push_deliveries WHERE notification_id=$1`, [nRetry])).rows[0];
  check("S12 503: retried later with backoff", d1?.state === "pending" && d1.attempts === 1 && d1.wait >= 20, JSON.stringify(d1));
  await q(`UPDATE push_deliveries SET next_attempt_at = now() WHERE notification_id=$1`, [nRetry]);
  const gRetry = await tick();
  check("S12 …and delivered on the retry", to(gRetry, A.admin).length === 1
    && (await q(`SELECT state FROM push_deliveries WHERE notification_id=$1`, [nRetry])).rows[0].state === "sent");
  statusFor.set(A.admin.phone.endpoint, [400]);
  const nFail = await notify(A.admin, "SHIFT_LATE_ARRIVAL", orgA, { entityId: randomUUID() });
  await tick();
  check("S12 400: failed, not retried, phone kept", (await q(`SELECT state FROM push_deliveries WHERE notification_id=$1`, [nFail])).rows[0].state === "failed"
    && (await q(`SELECT count(*)::int n FROM push_subscriptions WHERE user_id=$1`, [A.admin.userId])).rows[0].n === 1);

  // S13 nothing older than 24 h
  const nOld = await notify(A.admin, "SHIFT_LATE_ARRIVAL", orgA, { entityId: randomUUID() });
  await q(`UPDATE push_outbox SET created_at = now() - interval '25 hours' WHERE notification_id=$1`, [nOld]);
  const g13 = await tick();
  check("S13 a notice queued more than 24 h ago is not sent", to(g13, A.admin).length === 0 && (await reasonOf(nOld)).reason === "EXPIRED");

  // S14 where a notice opens
  const t1 = await call("GET", `/me/notifications/${nAcc}/target`, A.admin.token);
  check("S14 agency notice opens the shift", t1.status === 200 && t1.body.path === `/agency/shifts/${shiftA}` && t1.body.organizationId === orgA && t1.body.portal === "agency", JSON.stringify(t1.body));
  const t2 = await call("GET", `/me/notifications/${nPend}/target`, A.cg.token);
  check("S14 caregiver notice opens her shift (after logging in again)", t2.status === 401); // her sessions were revoked above
  const relog = await call("POST", "/auth/login", "", { email: A.cg.email, password });
  const t2b = await call("GET", `/me/notifications/${nPend}/target`, relog.body.token);
  check("S14 …after logging in again: /caregiver/shifts/<shift>", t2b.body.path === `/caregiver/shifts/${shiftA}`, JSON.stringify(t2b.body));
  const nMsgFam = (await q<{ id: string }>(`SELECT id FROM notifications WHERE user_id=$1 AND notification_type='NEW_MESSAGE'`, [A.fam.userId])).rows[0].id;
  const t3 = await call("GET", `/me/notifications/${nMsgFam}/target`, A.fam.token);
  check("S14 family message opens the conversation", t3.body.path === `/family/messages?thread=${threadId}`, JSON.stringify(t3.body));
  const t4 = await call("GET", `/me/notifications/${nAcc}/target`, B.admin.token);
  check("S14 another person's notice id: 404 (no information)", t4.status === 404);
  const t5 = await call("GET", `/me/notifications/${nIncFam}/target`, A.fam.token);
  check("S14 family incident (inbox only) has no push destination: path null → inbox", t5.status === 200 && t5.body.path === null);
  const nMultiA = (await q<{ id: string }>(`SELECT id FROM notifications WHERE user_id=$1 AND organization_id=$2 LIMIT 1`, [multi.userId, orgA])).rows[0].id;
  await q(`UPDATE organizations SET status='suspended' WHERE id=$1`, [orgA]);
  const t6 = await call("GET", `/me/notifications/${nMultiA}/target`, multi.token);
  check("S14 notice of a suspended agency: path null", t6.status === 200 && t6.body.path === null, JSON.stringify(t6.body));
  await q(`UPDATE organizations SET status='active' WHERE id=$1`, [orgA]);
  // Re-register the phones removed by A's suspension (people whose only access was A).
  for (const p of [A.admin, A.fam]) await reg(p);
  check("S14 invalid id: 400", (await call("GET", `/me/notifications/not-a-uuid/target`, A.admin.token)).status === 400);

  // S15 test notice
  const test1 = await call("POST", "/me/push/test", A.fam.token);
  const g15 = await tick();
  const test2 = await call("POST", "/me/push/test", A.fam.token);
  check("S15 «Enviar prueba»: arrives with the fixed text; a second one within a minute is refused",
    test1.status === 202 && to(g15, A.fam)[0]?.payload.notification.body === "Las notificaciones están activadas en este teléfono" && test2.status === 429, `${test1.status} ${test2.status}`);
  await reg(A.sup); // her phone was revoked with agency A's suspension above
  const noSub = await call("POST", "/me/push/test", A.sup.token);
  await call("POST", "/me/push/subscriptions/unsubscribe", A.sup.token, { endpoint: A.sup.phone.endpoint });
  const noSub2 = await call("POST", "/me/push/test", A.sup.token);
  check("S15 without an activated phone the test is refused", noSub.status === 202 && noSub2.status === 409, `${noSub.status} ${noSub2.status}`);

  // S16 list and delete own phones; device limit; same phone, another person
  const list = await call("GET", "/me/push/subscriptions", A.fam.token);
  check("S16 «Mis teléfonos»: label and this-session flag, never the endpoint", list.status === 200 && list.body.items.length === 1
    && list.body.items[0].deviceLabel === "iPhone de prueba" && list.body.items[0].thisSession === true && !JSON.stringify(list.body).includes("fcm.googleapis"), JSON.stringify(list.body).slice(0, 160));
  for (let i = 0; i < 11; i++) { const ph = newPhone(); extraPhones.push(ph); await reg(A.supIn, ph, `Teléfono ${i}`); }
  check("S16 at most 10 phones per person (oldest dropped, audited)", (await q(`SELECT count(*)::int n FROM push_subscriptions WHERE user_id=$1`, [A.supIn.userId])).rows[0].n === 10
    && (await q(`SELECT count(*)::int n FROM push_subscription_events WHERE user_id=$1 AND reason='DEVICE_LIMIT'`, [A.supIn.userId])).rows[0].n >= 1);
  const shared = await reg(A.famOther, A.fam.phone, "Teléfono compartido");
  check("S16 a shared phone moves to whoever activates it last (the previous person stops receiving there)", shared.status === 201
    && (await q(`SELECT user_id FROM push_subscriptions WHERE endpoint=$1`, [A.fam.phone.endpoint])).rows[0].user_id === A.famOther.userId
    && (await q(`SELECT count(*)::int n FROM push_subscription_events WHERE user_id=$1 AND reason='DEVICE_REASSIGNED'`, [A.fam.userId])).rows[0].n === 1);
  const own = (await call("GET", "/me/push/subscriptions", A.supIn.token)).body.items[0].id;
  check("S16 delete own phone 204; someone else's 404", (await call("DELETE", `/me/push/subscriptions/${own}`, A.supIn.token)).status === 204
    && (await call("DELETE", `/me/push/subscriptions/${(await q<{ id: string }>(`SELECT id FROM push_subscriptions WHERE user_id=$1 LIMIT 1`, [A.supIn.userId])).rows[0].id}`, B.admin.token)).status === 404);

  // S17 real origins: a database function and a service (trigger fires for both)
  const shiftLate = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '20 minutes',now()+interval '3 hours','confirmed') RETURNING id`, [orgA, rA])).rows[0].id;
  await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,response_status,responded_at) VALUES ($1,$2,$3,'accepted',now())`, [orgA, shiftLate, A.cg.owm]);
  // The late-arrival job only runs for agencies in the «En camino» pilot.
  await q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'EN_CAMINO',true) ON CONFLICT (organization_id,feature_code) DO UPDATE SET enabled=true`, [orgA]);
  await runtime.query(`SELECT app_notify_late_shift_arrivals()`);
  const g17 = await tick();
  check("S17 a notice created by a database job (late arrival) is pushed to the administrator", to(g17, A.admin).some((g) => g.payload.notification.body === "Un turno no tiene llegada registrada"));

  // S18 no names, residents, addresses or agency names in anything a phone received; logs carry counts only
  const all = JSON.stringify(received.map((r) => r.payload));
  check("S18 nothing received contains a resident, agency, e-mail, uuid other than the notice id, or digits in the text",
    !all.includes(RESIDENT) && !all.includes(ORG_A_NAME) && !all.includes("@example.invalid")
    && received.every((r) => !/[0-9]/.test(r.payload.notification.body) && !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(r.payload.notification.body)), `${received.length} messages`);
  // Run the real worker loop once to capture its own log line.
  const stop = startPushWorker(sender as never);
  await notify(A.admin, "SHIFT_LATE_ARRIVAL", orgA, { entityId: randomUUID() });
  await new Promise((r) => setTimeout(r, 6_500)); stop();
  const logText = logged.join("\n");
  check("S18 logs: counts only (no endpoint, key, notice id, text)", logText.includes("PUSH_TICK") && !/fcm\.googleapis|synthetic-|aceptó|llegada registrada/i.test(logText)
    && !people.some((p) => logText.includes(p.userId)), logText.split("\n").filter((l) => l.includes("PUSH")).slice(-2).join(" | "));

  // ---------------------------------------------------------------- 147: SmartMatch, actividades, fin de visita
  // S21 SmartMatch: the applicant may belong to ANOTHER agency (B.cg applies to agency A).
  await q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'SMARTMATCH',true)
    ON CONFLICT (organization_id,feature_code) DO UPDATE SET enabled=true`, [orgA]);
  await reg(B.cg); // her phone went away with agency B's suspension (S10)
  await q(`BEGIN`); await q(`SET LOCAL session_replication_role = replica`);
  const opp = (await q<{ id: string }>(`INSERT INTO smartmatch_opportunities (organization_id,created_by_user_id,visibility,status,region_label,role_label,starts_at,ends_at)
    VALUES ($1,$2,'INTERNAL','PUBLISHED','Norte','Cuidadora',now()+interval '2 days',now()+interval '2 days 4 hours') RETURNING id`, [orgA, A.admin.userId])).rows[0].id;
  const app = (await q<{ id: string }>(`INSERT INTO smartmatch_applications (opportunity_id,caregiver_user_id,organization_id,status,consented_at,consent_version) VALUES ($1,$2,$3,'PENDING',now(),'v1') RETURNING id`,
    [opp, B.cg.userId, orgA])).rows[0].id;
  await q(`COMMIT`);
  const sm = { entityType: "smartmatch_application", entityId: app };
  await notify(A.admin, "SMARTMATCH_APPLICATION_SUBMITTED", orgA, sm);
  const nApproved = await notify(B.cg, "SMARTMATCH_APPLICATION_APPROVED", orgA, sm);
  const nForgedSm = await notify(B.admin, "SMARTMATCH_APPLICATION_APPROVED", orgA, sm);
  const g21 = await tick();
  check("S21 agency: «Nueva solicitud en SmartMatch»", to(g21, A.admin).some((g) => g.payload.notification.body === "Nueva solicitud en SmartMatch"));
  check("S21 applicant from ANOTHER agency gets «Tu solicitud de SmartMatch fue aprobada»", to(g21, B.cg).length === 1
    && to(g21, B.cg)[0].payload.notification.body === "Tu solicitud de SmartMatch fue aprobada", JSON.stringify(await reasonOf(nApproved)));
  check("S21 someone who is not the applicant never gets it (even with the application id)", to(g21, B.admin).length === 0
    && (await reasonOf(nForgedSm)).reason === "NO_ACTIVE_MEMBERSHIP", JSON.stringify(await reasonOf(nForgedSm)));
  const tSm = await call("GET", `/me/notifications/${nApproved}/target`, B.cg.token);
  check("S21 opening it: her own applications, without switching to the publishing agency", tSm.status === 200
    && tSm.body.path === `/caregiver/smartmatch?tab=mine&application=${app}` && tSm.body.organizationId === null && tSm.body.portal === "caregiver", JSON.stringify(tSm.body));
  const nSubmittedA = (await q<{ id: string }>(`SELECT id FROM notifications WHERE user_id=$1 AND notification_type='SMARTMATCH_APPLICATION_SUBMITTED'`, [A.admin.userId])).rows[0].id;
  const tSa = await call("GET", `/me/notifications/${nSubmittedA}/target`, A.admin.token);
  check("S21 agency opens that application in its review", tSa.body.path === `/agency/smartmatch?application=${app}`, JSON.stringify(tSa.body));
  await q(`UPDATE organization_features SET enabled=false WHERE organization_id=$1 AND feature_code='SMARTMATCH'`, [orgA]);
  const nSmOff = await notify(B.cg, "SMARTMATCH_APPLICATION_REJECTED", orgA, sm);
  const g21b = await tick();
  check("S21 with SmartMatch off in the publishing agency: no push", to(g21b, B.cg).length === 0 && (await reasonOf(nSmOff)).reason === "FEATURE_OFF");

  // S22 activities to the family: at most one push every 30 min per resident; the rest stay in the inbox
  const act = () => notify(A.famOther, "NEW_CARE_EVENT", orgA, { entityType: "care_event", entityId: randomUUID(), recipient: rA2 });
  const a1 = await act(); const g22a = await tick();
  const a2 = await act(); const g22b = await tick();
  check("S22 first activity: «Se registró una nueva actividad de cuidado»", to(g22a, A.fam).some((g) => g.payload.notification.body === "Se registró una nueva actividad de cuidado"), JSON.stringify(await reasonOf(a1)));
  check("S22 a second one within 30 min does not ring (ACTIVITY_THROTTLED) but is in the inbox", to(g22b, A.fam).length === 0
    && (await reasonOf(a2)).reason === "ACTIVITY_THROTTLED"
    && ((await call("GET", "/me/notifications", A.famOther.token)).body.items ?? []).some((i: Json) => i.id === a2));
  await q(`UPDATE notifications SET created_at = now() - interval '31 minutes' WHERE id = ANY($1)`, [[a1, a2]]);
  const a3 = await act(); const g22c = await tick();
  check("S22 after 30 min it rings again", to(g22c, A.fam).length === 1, JSON.stringify(await reasonOf(a3)));
  const nActAdmin = await notify(A.admin, "NEW_CARE_EVENT", orgA, { entityType: "care_event", entityId: randomUUID(), recipient: rA2 });
  await tick();
  check("S22 activities are never pushed to the agency", (await reasonOf(nActAdmin)).reason === "NOT_FOR_THIS_ROLE");
  const tAct = await call("GET", `/me/notifications/${a3}/target`, A.famOther.token);
  check("S22 opening an activity: the family's activity page", tAct.body.path === "/family/activity", JSON.stringify(tAct.body));

  // S23 end of visit: family and agency
  await notify(A.famOther, "SHIFT_COMPLETED", orgA, { recipient: rA2 });
  await notify(A.admin, "SHIFT_COMPLETED", orgA);
  const g23 = await tick();
  check("S23 family: «La cuidadora terminó la visita»", to(g23, A.fam).some((g) => g.payload.notification.body === "La cuidadora terminó la visita"));
  check("S23 agency: «Una cuidadora terminó un turno»", to(g23, A.admin).some((g) => g.payload.notification.body === "Una cuidadora terminó un turno"));
  const all147 = JSON.stringify([...g21, ...g22a, ...g22c, ...g23].map((r) => r.payload));
  check("S23 nothing received names an agency, resident or person", !all147.includes(ORG_A_NAME) && !all147.includes(RESIDENT) && !all147.includes("@example.invalid"));

  // S19 switched off: no keys or PUSH_ENABLED=off → nothing sent, config disabled
  const offTick = await runPushTick(sender as never, null);
  check("S19 without VAPID configuration the sender does nothing", offTick.sent === 0 && offTick.expanded === 0);

  // S20 rollback, then the migration again (idempotent)
  const rollback147 = readFileSync(new URL("../ops/147_web_push_smartmatch_activities.rollback.sql", import.meta.url), "utf8");
  const rollback = readFileSync(new URL("../ops/146_web_push_notifications.rollback.sql", import.meta.url), "utf8");
  await pool.end().catch(() => undefined); server.close();
  await q(rollback147);
  check("S20 147 rollback: catalogue back to the 20 rows of 146", (await q(`SELECT count(*)::int n FROM push_notification_catalog`)).rows[0].n === 20);
  await q(rollback);
  const gone = (await q<{ n: number }>(`SELECT count(*)::int n FROM pg_class WHERE relname LIKE 'push\\_%'`)).rows[0].n;
  const trig = (await q<{ n: number }>(`SELECT count(*)::int n FROM pg_trigger WHERE tgname IN ('notifications_push_enqueue','sessions_push_cleanup','organizations_push_cleanup')`)).rows[0].n;
  const featureRows = (await q<{ n: number }>(`SELECT count(*)::int n FROM organization_features WHERE feature_code='PUSH_NOTIFICATIONS'`)).rows[0].n;
  check("S20 rollback removes tables, functions, triggers and the PUSH_NOTIFICATIONS switch rows", gone === 0 && trig === 0 && featureRows === 0, `tables ${gone} triggers ${trig} features ${featureRows}`);
  const nAfterRollback = await q(`INSERT INTO notifications (user_id,organization_id,notification_type,channel,status,sent_at) VALUES ($1,$2,'SHIFT_CANCELLED','in_app','sent',now()) RETURNING id`, [A.admin.userId, orgA]);
  check("S20 after rollback, notices keep working (in-app)", nAfterRollback.rows.length === 1);
  for (let i = 0; i < 2; i++) {
    await q(readFileSync(new URL("../migrations/146_web_push_notifications.sql", import.meta.url), "utf8"));
    await q(readFileSync(new URL("../migrations/147_web_push_smartmatch_activities.sql", import.meta.url), "utf8"));
  }
  check("S20 146 + 147 re-apply cleanly twice after a rollback", (await q(`SELECT count(*)::int n FROM push_notification_catalog`)).rows[0].n === 30);

  console.log = origLog; console.error = origError;
  await runtime.end(); await db.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) origLog(`${r.pass ? "PASS" : "FAIL"} ${r.check}${r.pass ? "" : `  →  ${r.detail}`}`);
  origLog(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`); for (const r of results) process.stdout.write(`${r.pass ? "PASS" : "FAIL"} ${r.check}${r.pass ? "" : `  →  ${r.detail}`}\n`); process.exit(1); });
