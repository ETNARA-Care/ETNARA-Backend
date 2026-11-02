/**
 * Activity photos v2 (migration 141) — the relative's own authorization (A2),
 * direct sending, caregiver window, provisional 30-day expiry, withdrawal,
 * removal with verified purge, exceptional holds, storage errors, isolation.
 *
 * Real Express app over HTTP as app_runtime, a local private S3 (moto) behind a
 * small local proxy that can make the storage fail on purpose. Synthetic people,
 * residents and images only. Time is simulated by moving dates in this
 * disposable database (triggers off only for those lines, as the owner).
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 *   optional: PHOTO_TEST_S3_PORT (default 4569), PHOTO_TEST_PYTHON (python with moto)
 */
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CreateBucketCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import sharp from "sharp";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });
const syntheticJpeg = (i: number) => sharp({ create: { width: 1200, height: 900, channels: 3, background: ["#5a8c78", "#c9a227", "#13294b", "#8a5a44"][i % 4] } })
  .withExif({ IFD0: { Make: "SyntheticCam", Model: "FakeModel" } }).jpeg().toBuffer();

async function main() {
  // ---------------------------------------------------------------- local S3 + failure proxy
  const s3Port = Number(process.env.PHOTO_TEST_S3_PORT ?? 4569);
  const moto: ChildProcess = spawn(process.env.PHOTO_TEST_PYTHON ?? "python3", ["-m", "moto.server", "-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
  const motoUrl = `http://127.0.0.1:${s3Port}`;
  let up = false;
  for (let i = 0; i < 240; i++) { try { await fetch(motoUrl); up = true; break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  if (!up) { moto.kill(); throw new Error("local S3 (moto) did not start"); }
  /** off: pass-through; "down": every request 503; "fake-delete": DELETE answered 204 without deleting. */
  const storage = { mode: "off" as "off" | "down" | "fake-delete" };
  const proxy = http.createServer((req, res) => {
    if (storage.mode === "down") { res.writeHead(503); res.end("<Error><Code>ServiceUnavailable</Code></Error>"); req.resume(); return; }
    if (storage.mode === "fake-delete" && req.method === "DELETE") { res.writeHead(204); res.end(); req.resume(); return; }
    const fwd = http.request({ host: "127.0.0.1", port: s3Port, method: req.method, path: req.url, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    fwd.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(fwd);
  }).listen(0);
  await new Promise((r) => proxy.once("listening", r));
  const endpoint = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const bucket = `etnara-photos-v2-${randomBytes(4).toString("hex")}`;
  const s3 = new S3Client({ endpoint: motoUrl, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  Object.assign(process.env, {
    PHOTO_STORAGE_ENDPOINT: endpoint, PHOTO_STORAGE_REGION: "us-east-1", PHOTO_STORAGE_BUCKET: bucket,
    PHOTO_STORAGE_ACCESS_KEY_ID: "test", PHOTO_STORAGE_SECRET_ACCESS_KEY: "test", PHOTO_STORAGE_FORCE_PATH_STYLE: "true",
    PHOTO_MAX_UPLOAD_BYTES: String(6 * 1024 * 1024),
  });
  delete process.env.STORAGE_ENDPOINT; delete process.env.STORAGE_BUCKET;
  const objects = async (prefix: string) => (await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))).KeyCount ?? 0;
  const exists = (key: string) => s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).then(() => true, () => false);

  // ---------------------------------------------------------------- database + app as app_runtime
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
  const origError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  const bodies: string[] = [];
  async function call(method: string, path: string, token: string, body?: Json | Buffer, contentType?: string) {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + path, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": contentType ?? (isBuf ? "image/jpeg" : "application/json") } : {}) },
      body: body === undefined ? undefined : isBuf ? new Uint8Array(body as Buffer) : JSON.stringify(body),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: Json = {};
    if ((res.headers.get("content-type") ?? "").includes("application/json")) { try { json = JSON.parse(buf.toString("utf8")); } catch { /* ignore */ } bodies.push(buf.toString("utf8")); }
    return { status: res.status, body: json, bytes: buf };
  }
  /** One statement as app_runtime with a tenant context (rolled back unless commit). */
  async function rt(userId: string | null, orgId: string | null, text: string, params: unknown[] = [], commit = false) {
    await runtime.query("BEGIN");
    try {
      await runtime.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [userId ?? "", orgId ?? ""]);
      const r = await runtime.query(text, params);
      await runtime.query(commit ? "COMMIT" : "ROLLBACK");
      return { rows: r.rows as Json[], error: null as string | null };
    } catch (e) { await runtime.query("ROLLBACK").catch(() => undefined); return { rows: [] as Json[], error: (e as Error).message }; }
  }
  /** Owner-only time travel for this disposable database. */
  async function shift(table: string, set: string, where: string, params: unknown[]) {
    await q(`BEGIN`); await q(`SET LOCAL session_replication_role = replica`);
    await q(`UPDATE ${table} SET ${set} WHERE ${where}`, params); await q(`COMMIT`);
  }

  // ---------------------------------------------------------------- synthetic fixtures
  const org = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgA = await org(`PHV2 A ${tag}`), orgB = await org(`PHV2 B ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  const noteType = (await q<{ id: string }>(`SELECT id FROM care_event_types WHERE code='NOTE'`)).rows[0].id;
  type P = { email: string; userId: string; token: string; owm?: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `phv2-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let owm: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Synthetic ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
    }
    return { email, userId, token: "", owm };
  }
  const A = {
    admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]), sup: await person("a-sup", orgA, ["SUPERVISOR"]),
    cg1: await person("a-cg1", orgA, ["WORKER"], true), cg2: await person("a-cg2", orgA, ["WORKER"], true),
    famYes: await person("a-famyes", orgA, ["FAMILY"]), famNo: await person("a-famno", orgA, ["FAMILY"]), famLate: await person("a-famlate", orgA, ["FAMILY"]),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]), cg: await person("b-cg", orgB, ["WORKER"], true), fam: await person("b-fam", orgB, ["FAMILY"]) };
  const platform = await person("platform", orgA, []);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [platform.userId]);
  const recipient = async (o: string) => (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Sintetica',$2,'active') RETURNING id`, [o, `V2-${tag}`])).rows[0].id;
  const r1 = await recipient(orgA), rNoShare = await recipient(orgA), rB = await recipient(orgB);
  for (const [f, o, rec] of [[A.famYes, orgA, r1], [A.famNo, orgA, r1], [A.famLate, orgA, r1], [A.famYes, orgA, rNoShare], [B.fam, orgB, rB]] as const) {
    await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_view_photos) VALUES ($1,$2,$3,'hija','active',true)`, [f.userId, o, rec]);
  }
  async function shiftFor(o: string, rec: string, owm: string) {
    const s = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '1 hour',now()+interval '3 hours','in_progress') RETURNING id`, [o, rec])).rows[0].id;
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,response_status,responded_at) VALUES ($1,$2,$3,'accepted',now())`, [o, s, owm]);
    return s;
  }
  const sA = await shiftFor(orgA, r1, A.cg1.owm!), sA2 = await shiftFor(orgA, r1, A.cg1.owm!), sNS = await shiftFor(orgA, rNoShare, A.cg1.owm!), sB = await shiftFor(orgB, rB, B.cg.owm!);
  const activity = async (o: string, sh: string, rec: string, owm: string) => (await q<{ id: string }>(`INSERT INTO care_events (organization_id,shift_id,care_recipient_id,organization_worker_membership_id,care_event_type_id,note_text,occurred_at)
    VALUES ($1,$2,$3,$4,$5,'Paseo sintetico',now()) RETURNING id`, [o, sh, rec, owm, noteType])).rows[0].id;
  for (const p of [...Object.values(A), ...Object.values(B), platform]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${p.email} ${r.status}`);
    p.token = r.body.token;
    if (p !== platform) await call("POST", "/me/active-organization", p.token, { organizationId: Object.values(B).includes(p) ? orgB : orgA });
  }
  const O = `/organizations/${orgA}`;
  const enable = (o: string, on: boolean) => q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'ACTIVITY_PHOTOS',$2)
    ON CONFLICT (organization_id,feature_code) DO UPDATE SET enabled = EXCLUDED.enabled`, [o, on]);
  const form = () => sharp({ create: { width: 400, height: 500, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
  const consent = async (who: P, o: string, rec: string, type: string) => call("POST", `/organizations/${o}/care-recipients/${rec}/photo-consents?type=${type}&signerRole=LEGAL_REPRESENTATIVE`, who.token, await form(), "image/jpeg");
  let n = 0;
  const send = async (who: P, o: string, sh: string, rec: string) => {
    const ev = await activity(o, sh, rec, who.owm!);
    const r = await call("POST", `/organizations/${o}/care-events/${ev}/photo`, who.token, await syntheticJpeg(n++));
    return { ev, status: r.status, photo: r.body.photo as Json };
  };
  const image = (who: P, id: string, o = orgA) => call("GET", `/organizations/${o}/activity-photos/${id}/image`, who.token);
  const receipt = (who: P, rec: string, decision: string, textVersion = "autorizacion-v1") => call("PUT", `${O}/care-recipients/${rec}/photo-receipt`, who.token, { decision, textVersion });
  const del = (who: P, id: string, reason?: string, o = orgA) => call("POST", `/organizations/${o}/activity-photos/${id}/delete`, who.token, reason ? { reason } : {});
  const hold = (who: P, id: string, body: Json, o = orgA) => call("POST", `/organizations/${o}/activity-photos/${id}/hold`, who.token, body);
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
  const keyOf = async (photoId: string) => (await q<{ k: string }>(`SELECT f.storage_key k FROM care_event_photos p JOIN stored_files f ON f.id=p.file_id WHERE p.id=$1`, [photoId])).rows[0].k;
  const checkOut = (sh: string, owm: string, user: string, hoursAgo: number) => q(`INSERT INTO verification_events (organization_id,shift_id,organization_worker_membership_id,verification_method_id,event_type,actor_user_id,occurred_at)
    SELECT $1,$2,$3,id,'check_out',$4,now()-make_interval(hours=>$5::int) FROM verification_methods WHERE code='CAREGIVER_SESSION'`, [orgA, sh, owm, user, hoursAgo]);

  try {
    // ---------------------------------------------------------------- 0. switch off
    const off = [await call("GET", `${O}/care-recipients/${r1}/photo-receipt`, A.famYes.token), await receipt(A.famYes, r1, "accepted"),
      await call("GET", `${O}/care-recipients/${r1}/photo-recipients`, A.admin.token), await del(A.admin, randomUUID(), "Prueba apagado"), await hold(A.admin, randomUUID(), { action: "RELEASE", reason: "Prueba con interruptor apagado" })];
    check("F1 ACTIVITY_PHOTOS off: every new route answers 404 FEATURE_NOT_ENABLED", off.every((r) => r.status === 404 && r.body.error === "FEATURE_NOT_ENABLED"), off.map((r) => r.status).join(","));
    await enable(orgA, true); await enable(orgB, true);
    for (const [who, o, rec] of [[A.admin, orgA, r1], [A.admin, orgA, rNoShare], [B.admin, orgB, rB]] as const) await consent(who, o, rec, "PHOTO_CAPTURE");
    for (const [who, o, rec] of [[A.admin, orgA, r1], [B.admin, orgB, rB]] as const) await consent(who, o, rec, "PHOTO_SHARE_FAMILY");

    // ---------------------------------------------------------------- 1. the relative's own authorization
    const start = await call("GET", `${O}/care-recipients/${r1}/photo-receipt`, A.famYes.token);
    const before = await send(A.cg1, orgA, sA, r1);
    const accept = await receipt(A.famYes, r1, "accepted");
    const decline = await receipt(A.famNo, r1, "declined");
    check("G1 the authorization starts at «not answered» (= no); the relative accepts or declines it; the text version is recorded",
      start.status === 200 && start.body.receipt?.decision === "not_answered" && accept.status === 200 && accept.body.receipt?.decision === "accepted"
        && decline.status === 200 && (await call("GET", `${O}/care-recipients/${r1}/photo-receipt`, A.famYes.token)).body.receipt?.textVersion === "autorizacion-v1",
      `${start.body.receipt?.decision} ${accept.status} ${decline.status}`);
    const after = await send(A.cg1, orgA, sA, r1);
    const a2: Record<string, number> = { beforeAcceptance: (await image(A.famYes, before.photo.id)).status, afterAcceptance: (await image(A.famYes, after.photo.id)).status,
      declined: (await image(A.famNo, after.photo.id)).status, notAnswered: (await image(A.famLate, after.photo.id)).status };
    await receipt(A.famLate, r1, "accepted");
    a2.lateAcceptsOld = (await image(A.famLate, after.photo.id)).status;
    const tlYes = await call("GET", `${O}/care-recipients/${r1}/timeline`, A.famYes.token);
    const refs = (tlYes.body.items as Json[] ?? []).filter((i) => i.photo?.visible).map((i) => i.photo.reference);
    check("G2 A2: only photos SENT AFTER the relative's authorization (no retroactive access); declined or unanswered sees nothing; the timeline agrees",
      a2.beforeAcceptance === 404 && a2.afterAcceptance === 200 && a2.declined === 404 && a2.notAnswered === 404 && a2.lateAcceptsOld === 404
        && refs.length === 1 && refs[0] === after.photo.id, `${JSON.stringify(a2)} timeline=${refs.length}`);
    const otherSets = {
      managerDirect: (await rt(A.admin.userId, orgA, `UPDATE family_relationships SET photo_receipt='accepted', photo_receipt_at=now() WHERE user_id=$1`, [A.famNo.userId])).error,
      ownerDirect: await q(`UPDATE family_relationships SET photo_receipt='accepted', photo_receipt_at=now() WHERE user_id=$1`, [A.famNo.userId]).then(() => "ALLOWED", (e) => (e as Error).message),
      managerApi: (await receipt(A.admin, r1, "accepted")).status, caregiverApi: (await receipt(A.cg1, r1, "accepted")).status,
      otherAgencyRelative: (await call("PUT", `${O}/care-recipients/${r1}/photo-receipt`, B.fam.token, { decision: "accepted", textVersion: "x" })).status,
      platform: (await call("PUT", `${O}/care-recipients/${r1}/photo-receipt`, platform.token, { decision: "accepted", textVersion: "x" })).status,
      badDecision: (await receipt(A.famYes, r1, "maybe")).status, badVersion: (await receipt(A.famYes, r1, "accepted", "<script>")).status,
      foreignResident: (await receipt(A.famYes, rB, "accepted")).status,
    };
    check("G3 nobody but the relative sets it: manager (SQL or API), owner without the function, caregiver, another agency's relative, ETNARA central refused; bad input 400",
      /PHOTO_RECEIPT_SELF_ONLY/.test(String(otherSets.managerDirect)) && /PHOTO_RECEIPT_SELF_ONLY/.test(otherSets.ownerDirect) && otherSets.managerApi === 404 && otherSets.caregiverApi === 404
        && otherSets.otherAgencyRelative === 403 && [403, 404].includes(otherSets.platform)
        && (await q(`SELECT photo_receipt FROM family_relationships WHERE user_id=$1 AND care_recipient_id=$2`, [A.famNo.userId, r1])).rows[0].photo_receipt === "declined"
        && otherSets.badDecision === 400 && otherSets.badVersion === 400 && otherSets.foreignResident === 404,
      JSON.stringify(otherSets));
    const recips = await call("GET", `${O}/care-recipients/${r1}/photo-recipients`, A.sup.token);
    const recipsCg = await call("GET", `${O}/care-recipients/${r1}/photo-recipients`, A.cg1.token);
    const recipsFam = await call("GET", `${O}/care-recipients/${r1}/photo-recipients`, A.famYes.token);
    const recipsB = await call("GET", `/organizations/${orgB}/care-recipients/${r1}/photo-recipients`, B.admin.token);
    const byMail = Object.fromEntries((recips.body.recipients as Json[] ?? []).map((x) => [x.email, x.receipt]));
    check("G4 managers see who receives photos (accepted / declined / not answered); caregivers, relatives and another agency do not",
      recips.status === 200 && byMail[A.famYes.email] === "accepted" && byMail[A.famNo.email] === "declined" && recipsCg.status === 403 && recipsFam.status === 403 && recipsB.status === 404,
      `${recips.status} ${JSON.stringify(byMail)} cg=${recipsCg.status} fam=${recipsFam.status} B=${recipsB.status}`);
    const events = (await q(`SELECT decision, text_version FROM family_photo_receipt_events e JOIN family_relationships fr ON fr.id=e.family_relationship_id WHERE fr.user_id=$1`, [A.famYes.userId])).rows;
    const appendOnly = await q(`DELETE FROM family_photo_receipt_events`).then(() => "ALLOWED", (e) => (e as Error).message);
    const audits = Number((await q(`SELECT count(*) n FROM audit_log WHERE organization_id=$1 AND action IN ('PHOTO_RECEIPT_ACCEPTED','PHOTO_RECEIPT_DECLINED')`, [orgA])).rows[0].n);
    check("G5 every decision is audited (append-only history with text version + audit log)", events.length >= 1 && events[0].text_version === "autorizacion-v1" && /HISTORY_APPEND_ONLY/.test(appendOnly) && audits >= 3,
      `${events.length} ${appendOnly} audit=${audits}`);

    // ---------------------------------------------------------------- 2. direct sending
    await receipt(A.famYes, rNoShare, "accepted");
    const noShare = await send(A.cg1, orgA, sNS, rNoShare);
    const noShareFam = await image(A.famYes, noShare.photo.id);
    const noShareAgency = await image(A.admin, noShare.photo.id);
    const manualShare = await call("POST", `${O}/activity-photos/${noShare.photo.id}/review`, A.admin.token, { decision: "APPROVE", expectedStatus: "pending" });
    check("D1 direct sending: with the sharing consent it is shared at once; without it, it stays for the agency only and nobody can share it by hand",
      after.status === 201 && after.photo.sharedWithFamily === true && noShare.status === 201 && noShare.photo.sharedWithFamily === false && noShare.photo.status === "pending"
        && noShareFam.status === 404 && noShareAgency.status === 200 && manualShare.status === 409 && manualShare.body.error === "PHOTO_NOT_SHAREABLE",
      `${after.photo.status} ${noShare.photo.status} fam=${noShareFam.status} agency=${noShareAgency.status} manual=${manualShare.status}`);

    // ---------------------------------------------------------------- 3. caregiver window (no permanent gallery)
    const w = await send(A.cg1, orgA, sA2, r1);
    const during = { image: (await image(A.cg1, w.photo.id)).status, status: (await call("GET", `${O}/care-events/${w.ev}/photo`, A.cg1.token)).body.photo?.canRemove };
    const otherCg = (await image(A.cg2, w.photo.id)).status;
    await checkOut(sA2, A.cg1.owm!, A.cg1.userId, 0);
    const justAfterCheckout = (await image(A.cg1, w.photo.id)).status;
    await q(`DELETE FROM verification_events WHERE shift_id=$1`, [sA2]); await checkOut(sA2, A.cg1.owm!, A.cg1.userId, 2);
    const afterWindow = { image: (await image(A.cg1, w.photo.id)).status, status: (await call("GET", `${O}/care-events/${w.ev}/photo`, A.cg1.token)).status,
      undo: (await del(A.cg1, w.photo.id)).status, agency: (await image(A.admin, w.photo.id)).status, family: (await image(A.famYes, w.photo.id)).status };
    const old = await send(A.cg1, orgA, sA, r1);
    await shift("care_event_photos", "created_at = now() - interval '25 hours'", "id=$1", [old.photo.id]);
    const after24h = (await image(A.cg1, old.photo.id)).status;
    check("W1 the caregiver sees her photo only in her window (until check-out + 1 h, at most 24 h after sending); never another caregiver; agency and family keep their history",
      during.image === 200 && during.status === true && otherCg === 404 && justAfterCheckout === 200 && afterWindow.image === 404 && afterWindow.status === 404
        && afterWindow.undo === 404 && afterWindow.agency === 200 && afterWindow.family === 200 && after24h === 404,
      `${JSON.stringify(during)} other=${otherCg} +0h=${justAfterCheckout} ${JSON.stringify(afterWindow)} 24h=${after24h}`);

    // ---------------------------------------------------------------- 4. expiry (provisional 30 days): access ends, nothing is deleted
    const e = await send(A.cg1, orgA, sA, r1);
    const eKey = await keyOf(e.photo.id);
    const days = Math.round((Date.parse(e.photo.availableUntil) - Date.now()) / 86_400_000);
    await shift("care_event_photos", "retention_until = now() + interval '1 minute'", "id=$1", [e.photo.id]);
    const lastMinute = { family: (await image(A.famYes, e.photo.id)).status, agency: (await image(A.admin, e.photo.id)).status };
    await shift("care_event_photos", "retention_until = now() - interval '1 minute'", "id=$1", [e.photo.id]);
    const expired = { family: (await image(A.famYes, e.photo.id)).status, agency: (await image(A.admin, e.photo.id)).status, caregiver: (await image(A.cg1, e.photo.id)).status };
    const tlExp = ((await call("GET", `${O}/care-recipients/${r1}/timeline`, A.famYes.token)).body.items as Json[]).some((i) => i.photo?.reference === e.photo.id);
    const listed = ((await call("GET", `${O}/activity-photos`, A.admin.token)).body.photos as Json[]).find((p) => p.id === e.photo.id);
    const holdAfterExpiry = await hold(A.admin, e.photo.id, { action: "PLACE", reason: "Investigacion de una queja", reviewAt: inDays(30) });
    const reshowExpired = await call("POST", `${O}/activity-photos/${e.photo.id}/review`, A.admin.token, { decision: "WITHDRAW", expectedStatus: "approved", reason: "Fuera de plazo" });
    check("X1 provisional retention: 30 days from sending; at expiry nobody sees it (family, agency, caregiver, timeline) even with no deletion job; the file is NOT deleted; no hold or decision after expiry",
      days === 30 && lastMinute.family === 200 && lastMinute.agency === 200 && Object.values(expired).every((s) => s === 404) && !tlExp
        && listed?.expired === true && listed?.viewable === false && listed?.deletion === null && (await exists(eKey))
        && holdAfterExpiry.status === 409 && holdAfterExpiry.body.error === "PHOTO_EXPIRED" && reshowExpired.status === 409,
      `days=${days} ${JSON.stringify(lastMinute)} ${JSON.stringify(expired)} tl=${tlExp} listed=${JSON.stringify({ e: listed?.expired, v: listed?.viewable })} object=${await exists(eKey)} hold=${holdAfterExpiry.body.error}`);

    // ---------------------------------------------------------------- 5. exceptional holds
    const h = await send(A.cg1, orgA, sA, r1);
    const bad = {
      shortReason: (await hold(A.admin, h.photo.id, { action: "PLACE", reason: "corto", reviewAt: inDays(10) })).status,
      tooFar: (await hold(A.admin, h.photo.id, { action: "PLACE", reason: "Investigacion de un incidente", reviewAt: inDays(91) })).body.error,
      caregiver: (await hold(A.cg1, h.photo.id, { action: "PLACE", reason: "Investigacion de un incidente", reviewAt: inDays(10) })).status,
      family: (await hold(A.famYes, h.photo.id, { action: "PLACE", reason: "Investigacion de un incidente", reviewAt: inDays(10) })).status,
      otherAgency: (await hold(B.admin, h.photo.id, { action: "PLACE", reason: "Investigacion de un incidente", reviewAt: inDays(10) }, orgB)).status,
      platform: (await hold(platform, h.photo.id, { action: "PLACE", reason: "Investigacion de un incidente", reviewAt: inDays(10) })).status,
    };
    const placed = await hold(A.admin, h.photo.id, { action: "PLACE", reason: "Investigacion de un incidente", reviewAt: inDays(60) });
    const twice = await hold(A.sup, h.photo.id, { action: "PLACE", reason: "Otra retencion distinta", reviewAt: inDays(60) });
    const sameReason = await hold(A.sup, h.photo.id, { action: "RENEW", reason: "Investigacion de un incidente", reviewAt: inDays(80) });
    const renew1 = await hold(A.sup, h.photo.id, { action: "RENEW", reason: "La investigacion sigue abierta", reviewAt: inDays(85) });
    const delHeld = await del(A.admin, h.photo.id, "Intento de eliminar retenida");
    check("H1 holds need reason (≥ 10), responsible manager and review ≤ 90 days; only the agency's managers; one at a time; a renewal needs a new reason; a held photo cannot be deleted",
      bad.shortReason === 400 && bad.tooFar === "PHOTO_HOLD_REVIEW_INVALID" && bad.caregiver === 403 && bad.family === 403 && bad.otherAgency === 404 && bad.platform === 403
        && placed.status === 200 && twice.body.error === "PHOTO_HOLD_EXISTS" && sameReason.body.error === "PHOTO_HOLD_REASON_REQUIRED" && renew1.status === 200
        && delHeld.status === 409 && delHeld.body.error === "PHOTO_ON_HOLD",
      `${JSON.stringify(bad)} place=${placed.status} twice=${twice.body.error} same=${sameReason.body.error} renew=${renew1.status} del=${delHeld.body.error}`);
    await shift("care_event_photos", "retention_until = now() - interval '1 minute'", "id=$1", [h.photo.id]);
    const heldExpired = { manager: (await image(A.admin, h.photo.id)).status, family: (await image(A.famYes, h.photo.id)).status, caregiver: (await image(A.cg1, h.photo.id)).status };
    const renew2 = await hold(A.admin, h.photo.id, { action: "RENEW", reason: "Requerimiento legal pendiente", reviewAt: inDays(89) });
    const renew3 = await hold(A.admin, h.photo.id, { action: "RENEW", reason: "Otra renovacion mas", reviewAt: inDays(89) });
    check("H2 an expired photo under hold: only managers see it (family and caregiver no); at most 3 hold actions (place + 2 renewals)",
      heldExpired.manager === 200 && heldExpired.family === 404 && heldExpired.caregiver === 404 && renew2.status === 200 && renew3.body.error === "PHOTO_HOLD_LIMIT",
      `${JSON.stringify(heldExpired)} renew2=${renew2.status} renew3=${renew3.body.error}`);
    const cap = await send(A.cg1, orgA, sA, r1);
    await hold(A.admin, cap.photo.id, { action: "PLACE", reason: "Retencion para comprobar el tope", reviewAt: inDays(80) });
    // As if the first hold had been placed 185 days ago: the cap (270 days) ends in 85 days.
    await shift("care_event_photos", "hold_first_placed_at = now() - interval '185 days'", "id=$1", [cap.photo.id]);
    const beyondCap = await hold(A.admin, cap.photo.id, { action: "RENEW", reason: "Renovacion fuera del tope", reviewAt: inDays(89) });
    const release = await hold(A.admin, cap.photo.id, { action: "RELEASE", reason: "Ya no hace falta conservarla" });
    const replace = await hold(A.admin, cap.photo.id, { action: "PLACE", reason: "Volver a retener tras levantar", reviewAt: inDays(88) });
    check("H3 absolute cap of 270 days from the first hold (also across release and placing again); release needs a reason",
      beyondCap.body.error === "PHOTO_HOLD_LIMIT" && release.status === 200 && replace.body.error === "PHOTO_HOLD_LIMIT", `${beyondCap.body.error} ${release.status} ${replace.body.error}`);
    await shift("care_event_photos", "hold_review_at = now() - interval '1 minute'", "id=$1", [h.photo.id]);
    const lapsed = { manager: (await image(A.admin, h.photo.id)).status, listed: ((await call("GET", `${O}/activity-photos`, A.admin.token)).body.photos as Json[]).find((p) => p.id === h.photo.id)?.hold?.active };
    const hist = ((await call("GET", `${O}/activity-photos/${h.photo.id}/history`, A.admin.token)).body.history as Json[]).map((x) => x.action);
    check("H4 a hold lapses by itself at its review date (expired photo no longer visible); every hold action is in the history with its responsible manager",
      lapsed.manager === 404 && lapsed.listed === false && hist.filter((a) => a === "HOLD_PLACED").length === 1 && hist.filter((a) => a === "HOLD_RENEWED").length === 2,
      `${JSON.stringify(lapsed)} ${hist.join(",")}`);

    // ---------------------------------------------------------------- 6. removal + verified purge
    const formsBefore = await objects("photo-consent-forms/");
    const d = await send(A.cg1, orgA, sA, r1);
    const dKey = await keyOf(d.photo.id);
    const noReason = await del(A.admin, d.photo.id);
    const foreign = await del(B.admin, d.photo.id, "Otra agencia", orgB);
    const famDel = await del(A.famYes, d.photo.id, "Familia");
    const removed = await del(A.admin, d.photo.id, "Foto equivocada");
    const tomb = (await q(`SELECT p.share_status, p.deletion_kind, p.deleted_by_user_id, p.purge_verified_at, f.storage_key, f.checksum, f.size_bytes, f.status
      FROM care_event_photos p JOIN stored_files f ON f.id=p.file_id WHERE p.id=$1`, [d.photo.id])).rows[0];
    const queueRow = (await q(`SELECT storage_key, purged_at, verified_at FROM photo_purge_queue WHERE photo_id=$1`, [d.photo.id])).rows[0];
    const access = [await image(A.admin, d.photo.id), await image(A.famYes, d.photo.id), await image(A.cg1, d.photo.id)].map((r) => r.status);
    const again = await del(A.admin, d.photo.id, "Otra vez");
    const dHist = ((await call("GET", `${O}/activity-photos/${d.photo.id}/history`, A.admin.token)).body.history as Json[]).map((x) => x.action);
    check("E1 removal by a manager: reason required; other agencies and relatives refused; the object is deleted and its absence VERIFIED; tombstone without key, size or checksum; nobody sees it; terminal",
      noReason.status === 400 && foreign.status === 404 && famDel.status === 404 && removed.status === 200 && removed.body.photo?.kind === "MANUAL" && removed.body.photo?.purged === true
        && !(await exists(dKey)) && tomb.share_status === "deleted" && tomb.deletion_kind === "MANUAL" && tomb.deleted_by_user_id === A.admin.userId && tomb.purge_verified_at !== null
        && tomb.storage_key === `purged/${(await q(`SELECT file_id FROM care_event_photos WHERE id=$1`, [d.photo.id])).rows[0].file_id}` && tomb.checksum === null && Number(tomb.size_bytes) === 0
        && queueRow.storage_key === null && queueRow.verified_at !== null && access.every((s) => s === 404) && again.status === 409
        && dHist.join(",").endsWith("DELETED,PURGED") && (await objects("photo-consent-forms/")) === formsBefore,
      `${noReason.status} ${foreign.status} ${famDel.status} ${removed.status} ${JSON.stringify(removed.body.photo)} object=${await exists(dKey)} ${JSON.stringify(tomb)} access=${access} again=${again.status} ${dHist.join(",")}`);
    await q(`DELETE FROM verification_events WHERE shift_id=$1`, [sA2]); // a visit in progress again (after a check-out nothing can be attached)
    const c = await send(A.cg1, orgA, sA2, r1);
    const cKey = await keyOf(c.photo.id);
    const undo = await del(A.cg1, c.photo.id);
    check("E2 the caregiver removes her own photo inside her window (no reason needed): CAREGIVER_UNDO, deleted and verified",
      undo.status === 200 && undo.body.photo?.kind === "CAREGIVER_UNDO" && undo.body.photo?.purged === true && !(await exists(cKey)), JSON.stringify(undo.body));

    // ---------------------------------------------------------------- 7. storage errors: access is cut first, the queue keeps the purge
    const s1 = await send(A.cg1, orgA, sA, r1);
    const s1Key = await keyOf(s1.photo.id);
    storage.mode = "down";
    const downDel = await del(A.admin, s1.photo.id, "Almacenamiento caido");
    storage.mode = "off";
    const downQueue = (await q(`SELECT storage_key IS NOT NULL AS has_key, purged_at, attempts, last_error_code FROM photo_purge_queue WHERE photo_id=$1`, [s1.photo.id])).rows[0];
    const downAccess = [await image(A.admin, s1.photo.id), await image(A.famYes, s1.photo.id)].map((r) => r.status);
    const s2 = await send(A.cg1, orgA, sA, r1);
    const s2Key = await keyOf(s2.photo.id);
    storage.mode = "fake-delete";
    const fakeDel = await del(A.admin, s2.photo.id, "Borrado que no borra");
    storage.mode = "off";
    const fakeQueue = (await q(`SELECT purged_at, last_error_code FROM photo_purge_queue WHERE photo_id=$1`, [s2.photo.id])).rows[0];
    const fakeTomb = (await q(`SELECT purge_verified_at FROM care_event_photos WHERE id=$1`, [s2.photo.id])).rows[0];
    check("S1 storage down or a deletion that does not delete: the photo is removed for everyone at once, the purge is NOT marked done (no false «deleted»), the queue keeps the key and the error for V2's retries",
      downDel.status === 200 && downDel.body.photo?.purged === false && downQueue.has_key === true && downQueue.purged_at === null && downQueue.attempts === 1 && downQueue.last_error_code
        && downAccess.every((s) => s === 404) && (await exists(s1Key))
        && fakeDel.status === 200 && fakeDel.body.photo?.purged === false && fakeQueue.purged_at === null && fakeQueue.last_error_code === "STILL_PRESENT" && fakeTomb.purge_verified_at === null && (await exists(s2Key)),
      `${JSON.stringify(downDel.body.photo)} ${JSON.stringify(downQueue)} access=${downAccess} | ${JSON.stringify(fakeDel.body.photo)} ${JSON.stringify(fakeQueue)}`);
    const claimOther = await rt(A.sup.userId, orgA, `SELECT app_photo_purge_claim($1) AS k`, [s1.photo.id]);
    const claimB = await rt(B.admin.userId, orgB, `SELECT app_photo_purge_claim($1) AS k`, [s1.photo.id]);
    const resultOther = await rt(A.sup.userId, orgA, `SELECT app_photo_purge_result($1, true, NULL)`, [s1.photo.id], true).then(async () =>
      (await q(`SELECT purged_at FROM photo_purge_queue WHERE photo_id=$1`, [s1.photo.id])).rows[0].purged_at);
    await shift("care_event_photos", "deleted_at = now() - interval '6 minutes'", "id=$1", [s1.photo.id]);
    const claimLate = await rt(A.admin.userId, orgA, `SELECT app_photo_purge_claim($1) AS k`, [s1.photo.id]);
    const direct = {
      queue: (await rt(A.admin.userId, orgA, `SELECT count(*) FROM photo_purge_queue`)).error,
      policy: (await rt(A.admin.userId, orgA, `SELECT count(*) FROM photo_retention_policies`)).error,
      policyWrite: (await rt(A.admin.userId, orgA, `UPDATE photo_retention_policies SET retention_days=1`)).error,
    };
    check("S2 the purge queue and the policy are out of reach: app_runtime cannot read or write them; only the person who removed it, within 5 minutes, can claim the key; nobody else can mark it purged",
      claimOther.rows[0]?.k === null && claimB.rows[0]?.k === null && resultOther === null && claimLate.rows[0]?.k === null
        && /permission denied/.test(String(direct.queue)) && /permission denied/.test(String(direct.policy)) && /permission denied/.test(String(direct.policyWrite)),
      `${claimOther.rows[0]?.k} ${claimB.rows[0]?.k} ${resultOther} ${claimLate.rows[0]?.k} ${JSON.stringify(direct)}`);

    // ---------------------------------------------------------------- 8. policy and visit/relationship end do not delete
    const purgeOnProvisional = await q(`UPDATE photo_retention_policies SET purge_enabled = true WHERE purpose='ACTIVITY_PHOTO'`).then(() => "ALLOWED", (e) => (e as Error).message);
    const policy = (await q(`SELECT retention_days, status, purge_enabled FROM photo_retention_policies`)).rows;
    check("P1 the 30 days are PROVISIONAL: physical deletion by expiry cannot be enabled until the policy is APPROVED (database constraint)",
      /check constraint/.test(purgeOnProvisional) && policy.length === 1 && policy[0].retention_days === 30 && policy[0].status === "PROVISIONAL" && policy[0].purge_enabled === false,
      `${purgeOnProvisional.slice(0, 80)} ${JSON.stringify(policy)}`);
    const endR = await send(A.cg1, orgA, sA, r1);
    const endKey = await keyOf(endR.photo.id);
    await q(`UPDATE family_relationships SET status='revoked', revoked_at=now() WHERE user_id=$1 AND care_recipient_id=$2`, [A.famYes.userId, r1]);
    await q(`UPDATE care_recipients SET status='inactive' WHERE id=$1`, [r1]).catch(() => undefined);
    const endState = (await q(`SELECT share_status, deleted_at FROM care_event_photos WHERE id=$1`, [endR.photo.id])).rows[0];
    check("P2 visit end, end of the care relationship and revocations cut access but never delete: the photo row and its object are still there",
      endState.share_status === "approved" && endState.deleted_at === null && (await exists(endKey)) && (await image(A.famYes, endR.photo.id)).status === 404,
      `${JSON.stringify(endState)} object=${await exists(endKey)}`);

    // ---------------------------------------------------------------- 9. isolation, leaks, rollback guard
    const iso = {
      bDeleteA: (await call("POST", `${O}/activity-photos/${after.photo.id}/delete`, B.admin.token, { reason: "Otra agencia" })).status,
      bHoldA: (await hold(B.admin, after.photo.id, { action: "PLACE", reason: "Otra agencia intenta", reviewAt: inDays(5) })).status,
      platformDelete: (await del(platform, after.photo.id, "Central")).status,
      platformList: (await call("GET", `${O}/activity-photos`, platform.token)).status,
      bListsA: ((await call("GET", `/organizations/${orgB}/activity-photos`, B.admin.token)).body.photos as Json[]).some((p) => p.id === after.photo.id),
    };
    check("I1 another agency and ETNARA central cannot remove, hold or list this agency's photos",
      iso.bDeleteA === 403 && iso.bHoldA === 403 && [403, 404].includes(iso.platformDelete) && iso.platformList === 403 && iso.bListsA === false
        && (await q(`SELECT share_status FROM care_event_photos WHERE id=$1`, [after.photo.id])).rows[0].share_status === "approved", JSON.stringify(iso));
    const leak = bodies.some((b) => b.includes("activity-photos/") || b.includes(bucket) || b.includes("storage_key") || b.includes("purged/"));
    const logLeak = logged.some((l) => l.includes("activity-photos/") || l.includes(bucket));
    check("I2 no response or log line carries a storage key, bucket name or purge tombstone key", !leak && !logLeak, `responses=${leak} logs=${logLeak}`);
    const rollback = readFileSync(new URL("../ops/141_activity_photos_v2_receipt_retention.rollback.sql", import.meta.url), "utf8");
    const rb = await q(rollback).then(() => "APPLIED", async (e) => { await q("ROLLBACK").catch(() => undefined); return (e as Error).message; });
    const still = (await q(`SELECT count(*) n FROM schema_migrations WHERE filename='141_activity_photos_v2_receipt_retention.sql'`)).rows[0].n;
    check("R1 the rollback refuses to run once 141 data exists (authorizations, removals, holds), and changes nothing", /rollback 141 aborted/.test(rb) && Number(still) === 1, `${rb.slice(0, 120)} registered=${still}`);
  } finally {
    console.error = origError;
    server.close(); proxy.close();
    await pool.end().catch(() => undefined);
    await runtime.end().catch(() => undefined);
    await db.end();
    moto.kill();
  }

  console.log("\nActivity photos v2 (141) · authorization, direct sending, window, expiry, holds, removal\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nActivity photo v2: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Activity photo v2 verification failed:", error);
  process.exit(1);
});
