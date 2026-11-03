/**
 * Activity photos v2 — migration 145 (security hardening after the 2-nov audit).
 *
 *  H  storage identity, missing files, circuit breakers, partial deletions (H1)
 *  P  privacy of the API and of PostgreSQL itself, audit log, relative's
 *     authorization against app_runtime, agencies separated, late upload (M1–M4, L1, I2, §6)
 *  F  ACTIVITY_PHOTOS off: legal-review-only mode, notice, ETNARA central warning (§5)
 *  G  agencies without an active administrator (§4)
 *  C  code against a database without 144/145 (M5), rollback guard
 *
 * Real app over HTTP as app_runtime, the job's own code, a local private S3
 * (moto) behind a small fault-injecting proxy. Synthetic people, residents and
 * images only; time is simulated by moving dates in this disposable database.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 *   optional: PHOTO_TEST_S3_PORT (default 4573), PHOTO_TEST_PYTHON (python with moto)
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CreateBucketCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import sharp from "sharp";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });
const jpeg = (i: number) => sharp({ create: { width: 900, height: 700, channels: 3, background: ["#5a8c78", "#c9a227", "#13294b", "#8a5a44", "#334455"][i % 5] } }).jpeg().toBuffer();

process.on("uncaughtException", (e) => { process.stderr.write(`UNCAUGHT ${(e as Error)?.stack ?? String(e)}\n`); process.exit(1); });
process.on("unhandledRejection", (e) => { process.stderr.write(`UNHANDLED ${(e as Error)?.stack ?? String(e)}\n`); process.exit(1); });

async function main() {
  // ---------------------------------------------------------------- local private S3 + fault-injecting proxy
  const s3Port = Number(process.env.PHOTO_TEST_S3_PORT ?? 4573);
  const moto: ChildProcess = spawn(process.env.PHOTO_TEST_PYTHON ?? "python3", ["-m", "moto.server", "-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
  const motoUrl = `http://127.0.0.1:${s3Port}`;
  let up = false;
  for (let i = 0; i < 240; i++) { try { await fetch(motoUrl); up = true; break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  if (!up) { moto.kill(); throw new Error("local S3 (moto) did not start"); }
  const fault = { deny: false, failHead: new Set<string>(), failDelete: new Set<string>() };
  const proxy = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    if (fault.deny) { res.writeHead(403, { "Content-Type": "application/xml" }); res.end("<Error><Code>AccessDenied</Code></Error>"); req.resume(); return; }
    if ((req.method === "HEAD" && fault.failHead.has(key)) || (req.method === "DELETE" && fault.failDelete.has(key))) {
      res.writeHead(500, { "Content-Type": "application/xml" }); res.end("<Error><Code>InternalError</Code></Error>"); req.resume(); return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const fwd = http.request(`${motoUrl}${req.url}`, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 500, r.headers); r.pipe(res); });
      fwd.on("error", () => { res.writeHead(502); res.end(); });
      fwd.end(Buffer.concat(chunks));
    });
  });
  proxy.listen(0, "127.0.0.1");
  await new Promise((r) => proxy.once("listening", r));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const bucket = `etnara-photos-hard-${randomBytes(4).toString("hex")}`;
  const s3 = new S3Client({ endpoint: motoUrl, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  Object.assign(process.env, {
    PHOTO_STORAGE_ENDPOINT: proxyUrl, PHOTO_STORAGE_REGION: "us-east-1", PHOTO_STORAGE_BUCKET: bucket,
    PHOTO_STORAGE_ACCESS_KEY_ID: "test", PHOTO_STORAGE_SECRET_ACCESS_KEY: "test", PHOTO_STORAGE_FORCE_PATH_STYLE: "true",
  });
  delete process.env.STORAGE_ENDPOINT; delete process.env.STORAGE_BUCKET; delete process.env.PHOTO_RETENTION_JOB;
  delete process.env.PHOTO_LEGAL_HOLD_NOTICE; delete process.env.AGENCY_ADMIN_GAP_NOTICE;
  const exists = (key: string) => s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).then(() => true, () => false);

  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const runtime = new pg.Client({ connectionString: u.toString() });
  await runtime.connect();
  const marker = await (await import("./lib/photoStorageTestIdentity.js")).bindTestPhotoBucket(db, s3, bucket);

  const logged: string[] = [];
  const origError = console.error, origLog = console.log;
  console.error = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.log = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const { env } = await import("../src/config/env.js");
  const { runRetentionCycle, RECONCILE_LIMITS } = await import("../src/modules/activityPhotos/retentionJob.js");
  const { runLegalReviewNotice, runAdminGapNotice, startLegalReviewNoticeWorker } = await import("../src/modules/activityPhotos/legalReviewNotice.js");
  const { resetPhotoStorageClientForTests } = await import("../src/modules/activityPhotos/photoStorage.js");
  const { verifyPhotoStorageIdentity, resetPhotoStorageIdentityCacheForTests } = await import("../src/modules/activityPhotos/storageIdentity.js");
  const { resetNotificationSchemaProbeForTests } = await import("../src/modules/notifications/notifications.service.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  server.keepAliveTimeout = 120_000; server.headersTimeout = 130_000; // long pauses must not race a reused keep-alive socket
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  async function call(method: string, path: string, token: string, body?: Json | Buffer, ct?: string): Promise<{ status: number; body: Json; text: string }> {
    // A GET on a keep-alive socket the server just closed is retried once (harness only; writes are never retried).
    if (method === "GET") { try { return await call1(method, path, token); } catch { return call1(method, path, token); } }
    return call1(method, path, token, body, ct);
  }
  async function call1(method: string, path: string, token: string, body?: Json | Buffer, ct?: string) {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": ct ?? (isBuf ? "image/jpeg" : "application/json") } : {}) },
      body: body === undefined ? undefined : isBuf ? new Uint8Array(body as Buffer) : JSON.stringify(body) }).catch((e) => { throw new Error(`fetch ${method} ${path}: ${(e as Error)?.cause ?? e} :: ${logged.slice(-6).join(" || ").slice(0, 1500)} :: ${results.length} checks`); });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: Json = {}; if ((res.headers.get("content-type") ?? "").includes("application/json")) { try { json = JSON.parse(buf.toString()); } catch { /* */ } }
    return { status: res.status, body: json, text: buf.toString("utf8") };
  }
  /** One statement as app_runtime with a request context, rolled back. */
  async function rt(userId: string, orgId: string, text: string, params: unknown[] = [], superadmin = false, pre?: string) {
    await runtime.query("BEGIN");
    try {
      await runtime.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`, [userId, orgId, superadmin ? "true" : "false"]);
      if (pre) await runtime.query(pre);
      const r = await runtime.query(text, params); await runtime.query("ROLLBACK"); return { rows: r.rows as Json[], error: null as string | null };
    } catch (e) { await runtime.query("ROLLBACK").catch(() => undefined); return { rows: [] as Json[], error: (e as Error).message }; }
  }
  async function shift(table: string, set: string, where: string, params: unknown[]) {
    await q(`BEGIN`); await q(`SET LOCAL session_replication_role = replica`); await q(`UPDATE ${table} SET ${set} WHERE ${where}`, params); await q(`COMMIT`);
  }
  const useStorage = (patch: { bucket?: string; endpoint?: string }) => {
    if (patch.bucket) (env as Json).PHOTO_STORAGE_BUCKET = patch.bucket;
    if (patch.endpoint) (env as Json).PHOTO_STORAGE_ENDPOINT = patch.endpoint;
    resetPhotoStorageClientForTests(); resetPhotoStorageIdentityCacheForTests();
  };
  const approvePolicy = (on: boolean) => q(on
    ? `UPDATE photo_retention_policies SET status='APPROVED', approved_by='prueba local sintetica', approved_at=now(), purge_enabled=true WHERE purpose='ACTIVITY_PHOTO'`
    : `UPDATE photo_retention_policies SET purge_enabled=false, status='PROVISIONAL', approved_by=NULL, approved_at=NULL WHERE purpose='ACTIVITY_PHOTO'`);
  const run = (mode: "simulate" | "on", over: Json = { orphanMinAgeMs: 0, orphanDeleteMinAgeMs: 0 }) => runRetentionCycle({ mode, reconcile: true, testOverrides: over });
  const finding = async (id: string) => (await q(`SELECT status, last_outcome, times_seen FROM photo_missing_findings WHERE photo_id=$1`, [id])).rows[0] as Json | undefined;
  const state = async (id: string) => (await q(`SELECT share_status, deletion_kind, legal_hold_basis IS NOT NULL AS legal FROM care_event_photos WHERE id=$1`, [id])).rows[0] as Json;
  const ageFindings = (ids: string[]) => shift("photo_missing_findings", "first_seen_at = now() - interval '25 hours', last_seen_at = now() - interval '13 hours'", "photo_id = ANY($1::uuid[])", [ids]);

  // ---------------------------------------------------------------- synthetic fixtures
  const org = async (name: string, status = "active") => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY',$2) RETURNING id`, [name, status])).rows[0].id;
  const orgH = await org(`HRD H ${tag}`), orgK = await org(`HRD K ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  const noteType = (await q<{ id: string }>(`SELECT id FROM care_event_types WHERE code='NOTE'`)).rows[0].id;
  type P = { email: string; userId: string; token: string; owm?: string; org: string; membership: string };
  async function person(key: string, orgId: string, roles: string[], worker = false, status = "active"): Promise<P> {
    const email = `hrd-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,$3) RETURNING id`, [userId, orgId, status])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let owm: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Synthetic ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
    }
    return { email, userId, token: "", owm, org: orgId, membership: m };
  }
  const H = { admin: await person("h-admin", orgH, ["ORGANIZATION_ADMIN"]), sup: await person("h-sup", orgH, ["SUPERVISOR"]),
    cg: await person("h-cg", orgH, ["WORKER"], true), fam: await person("h-fam", orgH, ["FAMILY"]) };
  const K = { admin: await person("k-admin", orgK, ["ORGANIZATION_ADMIN"]), sup: await person("k-sup", orgK, ["SUPERVISOR"]) };
  const central = { email: `hrd-central-${tag}@example.invalid`, userId: "", token: "" };
  central.userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [central.email, hash])).rows[0].id;
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.userId]);
  const rH = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Sintetica',$2,'active') RETURNING id`, [orgH, `R-${tag}`])).rows[0].id;
  const famRel = (await q<{ id: string }>(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_view_photos) VALUES ($1,$2,$3,'hija','active',true) RETURNING id`, [H.fam.userId, orgH, rH])).rows[0].id;
  const shiftFor = async (o: string, rec: string, owm: string, startAgo = "1 hour") => {
    const s = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-$3::interval,now()+interval '3 hours','in_progress') RETURNING id`, [o, rec, startAgo])).rows[0].id;
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,response_status,responded_at) VALUES ($1,$2,$3,'accepted',now())`, [o, s, owm]);
    return s;
  };
  const sH = await shiftFor(orgH, rH, H.cg.owm!);
  for (const p of [...Object.values(H), ...Object.values(K)]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    p.token = r.body.token; await call("POST", "/me/active-organization", p.token, { organizationId: p.org });
  }
  central.token = (await call("POST", "/auth/login", "", { email: central.email, password })).body.token;
  const feature = (o: string, on: boolean) => q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'ACTIVITY_PHOTOS',$2)
    ON CONFLICT (organization_id,feature_code) DO UPDATE SET enabled=EXCLUDED.enabled`, [o, on]);
  await feature(orgH, true); await feature(orgK, true);
  const form = () => sharp({ create: { width: 300, height: 400, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
  for (const t of ["PHOTO_CAPTURE", "PHOTO_SHARE_FAMILY"]) {
    await call("POST", `/organizations/${orgH}/care-recipients/${rH}/photo-consents?type=${t}&signerRole=LEGAL_REPRESENTATIVE`, H.admin.token, await form(), "image/jpeg");
  }
  await call("PUT", `/organizations/${orgH}/care-recipients/${rH}/photo-receipt`, H.fam.token, { decision: "accepted", textVersion: "test-v1" });
  let n = 0;
  const event = async (sh: string, occurredAgo = "0 minutes") => (await q<{ id: string }>(`INSERT INTO care_events (organization_id,shift_id,care_recipient_id,organization_worker_membership_id,care_event_type_id,note_text,occurred_at) VALUES ($1,$2,$3,$4,$5,'Paseo sintetico',now()-$6::interval) RETURNING id`,
    [orgH, sh, rH, H.cg.owm, noteType, occurredAgo])).rows[0].id;
  const send = async (sh = sH) => {
    const ev = await event(sh);
    const r = await call("POST", `/organizations/${orgH}/care-events/${ev}/photo`, H.cg.token, await jpeg(n++));
    if (r.status !== 201) throw new Error(`upload ${r.status} ${JSON.stringify(r.body)}`);
    const id = r.body.photo.id as string;
    const key = (await q<{ k: string }>(`SELECT f.storage_key k FROM care_event_photos p JOIN stored_files f ON f.id=p.file_id WHERE p.id=$1`, [id])).rows[0].k;
    return { id, key, ev };
  };
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
  const basis = "Requerimiento judicial sintetico de conservacion";
  const reference = `CASO-HRD-${tag}`;
  const legal = (who: P, id: string, body: Json) => call("POST", `/organizations/${who.org}/activity-photos/${id}/legal-hold`, who.token, body);
  const hold = (who: P, id: string, body: Json) => call("POST", `/organizations/${who.org}/activity-photos/${id}/hold`, who.token, body);
  const remove = (who: P, id: string, reason = "Eliminada por la agencia (prueba)") => call("POST", `/organizations/${who.org}/activity-photos/${id}/delete`, who.token, { reason });
  const image = (who: P, id: string) => call("GET", `/organizations/${who.org}/activity-photos/${id}/image`, who.token);
  // Earlier suites' photos have their files in THEIR buckets: placeholders here, so this bucket is complete.
  const placeholders = async () => {
    const foreign = (await q<{ k: string }>(`SELECT f.storage_key k FROM care_event_photos p JOIN stored_files f ON f.id = p.file_id
      WHERE p.deleted_at IS NULL AND p.organization_id <> $1`, [orgH])).rows;
    for (const r of foreign) if (!(await exists(r.k))) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: r.k, Body: Buffer.from("placeholder"), ContentType: "image/jpeg" }));
  };

  const startedAt = new Date().toISOString();
  try {
    await placeholders();
    const ph: Array<{ id: string; key: string; ev: string }> = [];
    for (let i = 0; i < 16; i++) ph.push(await send());
    await placeholders();
    const liveCount = Number((await q(`SELECT count(*) n FROM care_event_photos WHERE deleted_at IS NULL`)).rows[0].n);

    // ================================================================ H — storage identity and reconciliation
    const okCheck = await verifyPhotoStorageIdentity(runtime as never, "job");
    const bound = (await q(`SELECT marker, bound_by FROM photo_storage_identity`)).rows[0];
    const bindLater = await rt("", "", `SELECT app_photo_bind_storage_identity($1::uuid, 'job') AS ok`, [randomUUID()]);
    const bindReq = await rt(H.admin.userId, orgH, `SELECT app_photo_bind_storage_identity($1::uuid, 'job')`, [randomUUID()]);
    const updIdentity = await q(`UPDATE photo_storage_identity SET marker = gen_random_uuid()`).then(() => "ALLOWED", (e) => (e as Error).message);
    check("H01 the bucket proves its identity (marker in the bucket = marker in the database); with live photos nobody can bind another one (false), a request context is refused and the binding is append-only",
      okCheck === "OK" && bound?.marker === marker && bindLater.rows[0]?.ok === false && /PHOTO_JOB_ONLY/.test(String(bindReq.error)) && /HISTORY_APPEND_ONLY/.test(updIdentity),
      `${okCheck} bindLater=${bindLater.rows[0]?.ok} req=${bindReq.error} upd=${updIdentity.slice(0, 40)}`);

    // Pending removals to watch through the failure scenarios.
    await approvePolicy(true);
    const victim = ph[15];
    const qBefore = await remove(H.admin, victim.id);
    // (H01 binding was verified above; the removal purged at once with the bucket OK.)
    const keepQueued = ph[14];
    fault.failDelete.add(keepQueued.key);
    const queuedDel = await remove(H.admin, keepQueued.id);
    fault.failDelete.clear();

    fault.deny = true;
    const denied = await run("on");
    fault.deny = false;
    useStorage({ endpoint: "http://127.0.0.1:9" });
    const unreachable = await run("on");
    useStorage({ endpoint: proxyUrl });
    const kq1 = (await q(`SELECT purged_at FROM photo_purge_queue WHERE photo_id=$1`, [keepQueued.id])).rows[0];
    check("H02 storage access denied (403) or unreachable: the job does not touch the bucket at all (no purge, no reconciliation, nothing marked missing), records the cause in the run log and alerts",
      denied.storageCheck === "STORAGE_ACCESS_DENIED" && unreachable.storageCheck === "STORAGE_UNREACHABLE" && denied.reconciled === false && unreachable.reconciled === false
        && denied.purgedVerified + denied.purgeFailed + denied.missingFound + denied.missingMarked === 0 && kq1.purged_at === null && (await exists(keepQueued.key))
        && qBefore.body.photo?.purged === true && queuedDel.body.photo?.purged === false
        && logged.some((l) => l.includes("PHOTO_STORAGE_CHECK_FAILED") && l.includes("STORAGE_ACCESS_DENIED")),
      `denied=${denied.storageCheck} unreachable=${unreachable.storageCheck} queued=${JSON.stringify(kq1)}`);

    const wrong = `etnara-photos-wrong-${randomBytes(3).toString("hex")}`;
    await s3.send(new CreateBucketCommand({ Bucket: wrong }));
    useStorage({ bucket: wrong });
    const wrongRun = await run("on");
    const delWrong = await remove(H.admin, ph[13].id);
    await s3.send(new PutObjectCommand({ Bucket: wrong, Key: "_etnara/storage-identity.json", Body: JSON.stringify({ marker: randomUUID() }) }));
    resetPhotoStorageIdentityCacheForTests();
    const otherMarker = await run("on");
    useStorage({ bucket: `etnara-photos-absent-${tag}` });
    const absent = await run("on");
    useStorage({ bucket });
    const liveAfterWrong = Number((await q(`SELECT count(*) n FROM care_event_photos WHERE deleted_at IS NULL AND organization_id=$1`, [orgH])).rows[0].n);
    check("H03 a WRONG but existing (empty) bucket — e.g. after a restore — is detected (STORAGE_IDENTITY_MISSING): nothing reconciled, nothing tombstoned, a removal cuts access but does not delete there (queued); another deployment's marker → MISMATCH; a bucket that does not exist → BUCKET_NOT_FOUND",
      wrongRun.storageCheck === "STORAGE_IDENTITY_MISSING" && wrongRun.reconciled === false && wrongRun.missingMarked === 0 && otherMarker.storageCheck === "STORAGE_IDENTITY_MISMATCH"
        && absent.storageCheck === "STORAGE_BUCKET_NOT_FOUND" && delWrong.status === 200 && delWrong.body.photo?.purged === false && (await exists(ph[13].key))
        && liveAfterWrong === 13,
      `wrong=${wrongRun.storageCheck} other=${otherMarker.storageCheck} absent=${absent.storageCheck} del=${delWrong.body.photo?.purged} live=${liveAfterWrong}`);

    await shift("photo_purge_queue", "last_attempt_at = now() - interval '7 hours'", "photo_id = ANY($1::uuid[])", [[keepQueued.id, ph[13].id]]);
    const back = await run("on");
    check("H04 back on the right bucket, the queued removals are deleted and verified (no inconsistency left between database and storage)",
      back.storageCheck === "OK" && !(await exists(keepQueued.key)) && !(await exists(ph[13].key))
        && (await q(`SELECT count(*) n FROM photo_purge_queue WHERE photo_id = ANY($1::uuid[]) AND purged_at IS NULL`, [[keepQueued.id, ph[13].id]])).rows[0].n === "0",
      `purged=${back.purgedVerified}`);

    // Emptied bucket (the marker is gone with everything else).
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: "_etnara/storage-identity.json" }));
    resetPhotoStorageIdentityCacheForTests();
    const emptied = await run("on");
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "_etnara/storage-identity.json", Body: JSON.stringify({ marker }) }));
    resetPhotoStorageIdentityCacheForTests();
    check("H05 an emptied bucket (marker gone) stops everything: STORAGE_IDENTITY_MISSING, nothing marked missing although every file would answer 404",
      emptied.storageCheck === "STORAGE_IDENTITY_MISSING" && emptied.missingFound === 0 && emptied.missingMarked === 0, `${emptied.storageCheck}`);

    // Missing file, provisional policy.
    await approvePolicy(false);
    const m1 = ph[0];
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: m1.key }));
    const prov = await run("on");
    const f1 = await finding(m1.id);
    const img1 = await image(H.admin, m1.id);
    check("H06 a missing file with the PROVISIONAL policy is only a finding (open, policy_provisional): never tombstoned; its image answers 404 (not 500); alert with the count only",
      prov.missingFound === 1 && prov.missingMarked === 0 && (await state(m1.id)).share_status !== "deleted" && f1?.status === "open" && f1?.last_outcome === "policy_provisional"
        && img1.status === 404 && logged.some((l) => /PHOTO_FILES_MISSING.*"count":1/.test(l)), `${JSON.stringify(f1)} img=${img1.status}`);

    await approvePolicy(true);
    const firstApproved = await run("on");
    check("H07 with the policy APPROVED, a single sighting is not enough (not_confirmed, times_seen 1): a second run at least 24 h after the first is required",
      firstApproved.missingMarked === 0 && (await state(m1.id)).share_status !== "deleted" && (await finding(m1.id))?.last_outcome === "not_confirmed" && (await finding(m1.id))?.times_seen === 1,
      JSON.stringify(await finding(m1.id)));
    await ageFindings([m1.id]);
    const confirmed = await run("on");
    const st1 = await state(m1.id);
    const hist1 = (await q(`SELECT action FROM care_event_photo_events WHERE photo_id=$1 ORDER BY occurred_at, id`, [m1.id])).rows.map((r) => r.action);
    check("H08 confirmed in a later run (>= 24 h, APPROVED, re-checked once more): tombstoned RECONCILED, finding closed, history PURGED",
      confirmed.missingMarked === 1 && st1.share_status === "deleted" && st1.deletion_kind === "RECONCILED" && (await finding(m1.id))?.status === "tombstoned" && hist1.includes("DELETED") && hist1.includes("PURGED"),
      `${JSON.stringify(st1)} ${hist1.join(",")}`);

    // A file that comes back.
    const m2 = ph[1];
    const m2Body = await jpeg(99);
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: m2.key }));
    await run("on");
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: m2.key, Body: m2Body, ContentType: "image/jpeg" }));
    await ageFindings([m2.id]);
    const backRun = await run("on");
    check("H09 a file that reappears (bucket restored) closes its finding (reappeared) and the photo is untouched",
      backRun.missingMarked === 0 && (await finding(m2.id))?.status === "reappeared" && (await state(m2.id)).share_status !== "deleted" && (await image(H.admin, m2.id)).status === 200,
      JSON.stringify(await finding(m2.id)));

    // Holds and legal holds.
    const m3 = ph[2], m4 = ph[3];
    await hold(H.admin, m3.id, { action: "PLACE", reason: "Revision de una queja sintetica abierta", reviewAt: inDays(10) });
    await legal(H.admin, m4.id, { action: "PLACE", basis, reference, reviewAt: inDays(30) });
    for (const p of [m3, m4]) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: p.key }));
    await run("on");
    await ageFindings([m3.id, m4.id]);
    const heldRun = await run("on");
    check("H10 a missing file under an ordinary hold in force or under a legal hold is NEVER tombstoned (outcomes held / legal_hold); the lost evidence is reported (alert, counts only)",
      heldRun.missingMarked === 0 && (await state(m3.id)).share_status !== "deleted" && (await state(m4.id)).share_status !== "deleted"
        && (await finding(m3.id))?.last_outcome === "held" && (await finding(m4.id))?.last_outcome === "legal_hold" && heldRun.legalHeldMissing === 1
        && logged.some((l) => l.includes("PHOTO_LEGAL_HOLD_FILE_MISSING")),
      `${JSON.stringify(await finding(m3.id))} ${JSON.stringify(await finding(m4.id))} legalMissing=${heldRun.legalHeldMissing}`);

    // Anomaly: more than max(5, 2 %) missing at once.
    const anomalous = ph.slice(4, 10);
    const saved = new Map<string, Buffer>();
    for (const p of anomalous) { saved.set(p.key, await jpeg(7)); await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: p.key })); }
    const limit = Math.max(RECONCILE_LIMITS.missingMin, Math.ceil(RECONCILE_LIMITS.missingRatio * liveCount));
    await run("on");
    await ageFindings(anomalous.map((p) => p.id));
    const anomaly = await run("on");
    const tombAnom = Number((await q(`SELECT count(*) n FROM care_event_photos WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL`, [anomalous.map((p) => p.id)])).rows[0].n);
    check(`H11 too many files missing at once (${anomaly.missingFound} > ${limit}) halts the reconciliation (MISSING_ANOMALY): nothing tombstoned even for findings already confirmed; findings kept for review (outcome halted); alert`,
      anomaly.reconcileHalted === "MISSING_ANOMALY" && anomaly.missingMarked === 0 && tombAnom === 0 && (await finding(anomalous[0].id))?.last_outcome === "halted"
        && logged.some((l) => l.includes("PHOTO_RECONCILE_HALTED") && l.includes("MISSING_ANOMALY")),
      `found=${anomaly.missingFound} halted=${anomaly.reconcileHalted} tomb=${tombAnom}`);
    for (const p of anomalous) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: p.key, Body: saved.get(p.key)!, ContentType: "image/jpeg" }));

    // Storage errors on HEAD.
    const foreignKeys = (await q<{ k: string }>(`SELECT f.storage_key k FROM care_event_photos p JOIN stored_files f ON f.id = p.file_id
      WHERE p.deleted_at IS NULL AND p.organization_id <> $1 LIMIT 3`, [orgH])).rows.map((r) => r.k);
    for (const k of [ph[10].key, ph[11].key, ph[12].key, ...foreignKeys]) fault.failHead.add(k);
    const errRun = await run("on");
    fault.failHead.clear();
    check("H12 storage errors while checking files (> max(3, 1 %)) halt it (STORAGE_ERRORS): an error is never taken for a missing file, no finding recorded for them, nothing tombstoned",
      errRun.reconcileHalted === "STORAGE_ERRORS" && errRun.missingMarked === 0 && (await finding(ph[10].id)) === undefined && (await finding(ph[11].id)) === undefined, `${errRun.reconcileHalted} found=${errRun.missingFound}`);

    // Orphans anomaly.
    const orphanKeys = Array.from({ length: RECONCILE_LIMITS.orphansMin + 5 }, () => `activity-photos/${orgH}/${rH}/${randomUUID()}.jpg`);
    for (const k of orphanKeys) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: k, Body: Buffer.from("x"), ContentType: "image/jpeg" }));
    const orphRun = await run("on");
    const orphLeft = (await Promise.all(orphanKeys.map(exists))).filter(Boolean).length;
    check("H13 an anomalous number of orphan files (another deployment's bucket, a restored database) is reported but NOTHING is deleted (ORPHAN_ANOMALY), even with the policy APPROVED",
      orphRun.reconcileHalted === "ORPHAN_ANOMALY" && orphRun.orphansDeleted === 0 && orphLeft === orphanKeys.length, `${orphRun.reconcileHalted} found=${orphRun.orphansFound} left=${orphLeft}`);
    for (const k of orphanKeys) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: k }));

    // Partial failures while deleting.
    const [x1, x2, x3] = [ph[10], ph[11], ph[12]];
    fault.failDelete.add(x2.key);
    const dr = [await remove(H.admin, x1.id), await remove(H.admin, x2.id), await remove(H.admin, x3.id)];
    fault.failDelete.clear();
    const d2q = (await q(`SELECT purged_at, last_error_code, storage_key IS NOT NULL AS has_key FROM photo_purge_queue WHERE photo_id=$1`, [x2.id])).rows[0];
    const d2Access = [(await image(H.admin, x2.id)).status, (await image(H.fam, x2.id)).status];
    check("H14 a deletion failing in the middle of several: the others are deleted and verified; the failed one is already a tombstone (nobody sees it), keeps its key queued with the error — never a false «deleted»",
      dr.map((r) => r.body.photo?.purged).join() === "true,false,true" && !(await exists(x1.key)) && (await exists(x2.key)) && !(await exists(x3.key))
        && d2q.purged_at === null && d2q.has_key === true && !!d2q.last_error_code && d2Access.every((s) => s === 404) && (await state(x2.id)).share_status === "deleted",
      `${dr.map((r) => r.body.photo?.purged)} q=${JSON.stringify(d2q)} access=${d2Access}`);
    await shift("photo_purge_queue", "last_attempt_at = now() - interval '7 hours'", "photo_id=$1", [x2.id]);
    const retryRun = await run("on");
    check("H15 the next run retries it, deletes it and verifies its absence", retryRun.purgedVerified >= 1 && !(await exists(x2.key))
      && (await q(`SELECT purged_at FROM photo_purge_queue WHERE photo_id=$1`, [x2.id])).rows[0].purged_at !== null, `${retryRun.purgedVerified}`);

    // Many failures in a row: the purge stops after 5.
    const burst: Array<{ id: string; key: string; ev: string }> = [];
    for (let i = 0; i < 7; i++) burst.push(await send());
    for (const b of burst) fault.failDelete.add(b.key);
    for (const b of burst) await remove(H.admin, b.id);
    await shift("photo_purge_queue", "last_attempt_at = now() - interval '7 hours'", "photo_id = ANY($1::uuid[])", [burst.map((b) => b.id)]);
    const burstRun = await run("on");
    fault.failDelete.clear();
    check("H16 repeated deletion failures stop the purge after 5 in a row (PURGE_HALTED): no hammering of a failing storage; the rest stay queued",
      burstRun.purgeFailed === 5 && burstRun.errorCodes.includes("PURGE_HALTED") && (await Promise.all(burst.map((b) => exists(b.key)))).every(Boolean), `failed=${burstRun.purgeFailed} ${burstRun.errorCodes}`);
    await shift("photo_purge_queue", "last_attempt_at = now() - interval '7 hours'", "photo_id = ANY($1::uuid[])", [burst.map((b) => b.id)]);
    await run("on");

    // Legal hold: no path deletes it.
    const lh = await send();
    await legal(H.admin, lh.id, { action: "PLACE", basis, reference, reviewAt: inDays(20) });
    const lhCg = await remove(H.cg, lh.id);
    await shift("care_event_photos", "retention_until = now() - interval '1 day'", "id=$1", [lh.id]);
    const lhAdmin = await remove(H.admin, lh.id);
    const lhRun = await run("on");
    check("H17 a photo under a legal hold is deleted by no path: administration (409 PHOTO_ON_LEGAL_HOLD), caregiver (409 PHOTO_KEPT_BY_AGENCY), expiry with the policy APPROVED, reconciliation",
      lhAdmin.status === 409 && lhAdmin.body.error === "PHOTO_ON_LEGAL_HOLD" && lhCg.status === 409 && lhCg.body.error === "PHOTO_KEPT_BY_AGENCY"
        && (await state(lh.id)).share_status !== "deleted" && (await exists(lh.key)) && lhRun.expiredMarked >= 0, `${lhAdmin.body.error} ${lhCg.body.error} ${(await state(lh.id)).share_status}`);
    await approvePolicy(false);

    const runLog = JSON.stringify((await q(`SELECT * FROM photo_retention_runs WHERE started_at >= $1`, [startedAt])).rows);
    const leak = logged.some((l) => l.includes("activity-photos/") || l.includes(bucket) || l.includes(wrong));
    check("H18 run log and logs carry fixed codes and counts only (storage_check, reconcile_halted): never a key, a bucket name or a photo id",
      /STORAGE_ACCESS_DENIED/.test(runLog) && /MISSING_ANOMALY/.test(runLog) && !runLog.includes("activity-photos/") && !runLog.includes(bucket) && !leak, `leak=${leak}`);

    // ================================================================ P — privacy and isolation
    const pp = await send();
    await hold(H.admin, pp.id, { action: "PLACE", reason: "Revision de una queja sintetica abierta", reviewAt: inDays(10) });
    const ppHold = await remove(H.cg, pp.id);
    await hold(H.admin, pp.id, { action: "RELEASE", reason: "Queja sintetica cerrada sin conservar" });
    await legal(H.admin, pp.id, { action: "PLACE", basis, reference, reviewAt: inDays(30) });
    const ppLegal = await remove(H.cg, pp.id);
    const cgView = (await call("GET", `/organizations/${orgH}/care-events/${pp.ev}/photo`, H.cg.token)).body.photo as Json;
    check("P01 the caregiver gets the SAME answer for an ordinary hold and a legal hold (409 PHOTO_KEPT_BY_AGENCY) and her view says only keptByAgency",
      ppHold.status === 409 && ppLegal.status === 409 && ppHold.body.error === "PHOTO_KEPT_BY_AGENCY" && ppLegal.body.error === "PHOTO_KEPT_BY_AGENCY"
        && JSON.stringify(ppHold.body) === JSON.stringify(ppLegal.body) && cgView?.keptByAgency === true && Object.keys(cgView).sort().join() === "canRemove,id,keptByAgency,sharedWithFamily,status",
      `${ppHold.text} | ${ppLegal.text} | ${JSON.stringify(cgView)}`);

    const cols = ["legal_hold_basis", "legal_hold_reference", "legal_hold_by_user_id", "hold_reason", "review_reason", "deletion_reason"];
    const asCg: Awaited<ReturnType<typeof rt>>[] = [], asAdmin: Awaited<ReturnType<typeof rt>>[] = [];
    for (const c of cols) asCg.push(await rt(H.cg.userId, orgH, `SELECT ${c} FROM care_event_photos WHERE id=$1`, [pp.id]));
    for (const c of cols) asAdmin.push(await rt(H.admin.userId, orgH, `SELECT ${c} FROM care_event_photos WHERE id=$1`, [pp.id]));
    const star = await rt(H.admin.userId, orgH, `SELECT * FROM care_event_photos WHERE id=$1`, [pp.id]);
    const evReason = await rt(H.admin.userId, orgH, `SELECT reason FROM care_event_photo_events WHERE photo_id=$1`, [pp.id]);
    const okCols = await rt(H.cg.userId, orgH, `SELECT id, share_status, legal_hold_placed_at IS NOT NULL AS legal FROM care_event_photos WHERE id=$1`, [pp.id]);
    check("P02 PostgreSQL itself refuses the confidential columns to app_runtime (motive, legal basis, reference, author, review and deletion reasons; history text) — for the caregiver AND for managers; non-confidential columns still readable",
      [...asCg, ...asAdmin, star, evReason].every((r) => /permission denied/.test(String(r.error))) && okCols.error === null && okCols.rows[0]?.legal === true,
      `${[...asCg, ...asAdmin, star, evReason].filter((r) => !/permission denied/.test(String(r.error))).length} not denied`);

    const listAdmin = ((await call("GET", `/organizations/${orgH}/activity-photos?legalReview=active`, H.admin.token)).body.photos as Json[]).find((x) => x.id === pp.id);
    const listSup = ((await call("GET", `/organizations/${orgH}/activity-photos?legalReview=active`, H.sup.token)).body.photos as Json[]).find((x) => x.id === pp.id);
    const histAdmin = ((await call("GET", `/organizations/${orgH}/activity-photos/${pp.id}/history`, H.admin.token)).body.history as Json[]).find((x) => x.action === "LEGAL_HOLD_PLACED");
    const histSup = ((await call("GET", `/organizations/${orgH}/activity-photos/${pp.id}/history`, H.sup.token)).body.history as Json[]).find((x) => x.action === "LEGAL_HOLD_PLACED");
    const supFn = await rt(H.sup.userId, orgH, `SELECT * FROM app_photo_confidential($1::uuid[])`, [[pp.id]]);
    const supText = JSON.stringify(listSup) + JSON.stringify(histSup) + JSON.stringify(supFn.rows);
    check("P03 §6: the supervisor sees THAT a legal hold exists and its dates, never the basis, the reference or its author (list, history and the database function); the administrator sees them",
      listAdmin?.legalHold?.basis === basis && listAdmin?.legalHold?.reference === reference && String(histAdmin?.reason).includes(reference)
        && listSup?.legalHold && !("basis" in listSup.legalHold) && !("reference" in listSup.legalHold) && !("by" in listSup.legalHold) && !!listSup.legalHold.reviewAt
        && histSup && histSup.reason === null && supFn.rows[0]?.legal_hold_basis === null && supFn.rows[0]?.hold_reason !== undefined
        && !supText.includes(reference) && !supText.includes("judicial"),
      `admin=${listAdmin?.legalHold?.basis ? "basis" : "-"} sup=${JSON.stringify(listSup?.legalHold)} histSup=${histSup?.reason}`);

    const photoActions = `(action LIKE 'ACTIVITY\\_PHOTO\\_%' OR action LIKE 'PHOTO\\_%')`;
    const ownerPhotoAudit = Number((await q(`SELECT count(*) n FROM audit_log WHERE organization_id=$1 AND ${photoActions}`, [orgH])).rows[0].n);
    await q(`INSERT INTO audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id) VALUES ($1,$2,$2,'SYNTHETIC_TEST_EVENT','organization',$2)`, [H.admin.userId, orgH]);
    const centralAudit = await rt(central.userId, "", `SELECT count(*) n FROM audit_log WHERE ${photoActions}`, [], true);
    const centralOther = await rt(central.userId, "", `SELECT count(*) n FROM audit_log WHERE NOT ${photoActions}`, [], true);
    const supAudit = await rt(H.sup.userId, orgH, `SELECT count(*) FILTER (WHERE action LIKE 'ACTIVITY\\_PHOTO\\_LEGAL\\_HOLD\\_%') legal, count(*) FILTER (WHERE action='ACTIVITY_PHOTO_UPLOADED') up FROM audit_log WHERE organization_id=$1`, [orgH]);
    const adminAudit = await rt(H.admin.userId, orgH, `SELECT count(*) FILTER (WHERE action LIKE 'ACTIVITY\\_PHOTO\\_LEGAL\\_HOLD\\_%') legal FROM audit_log WHERE organization_id=$1`, [orgH]);
    const kAudit = await rt(K.admin.userId, orgK, `SELECT count(*) n FROM audit_log WHERE organization_id=$1`, [orgH]);
    check("P04 audit log: ETNARA central reads NO photo, consent or relative-authorization entry (other entries still visible); legal-hold entries only for the agency's administration; another agency nothing",
      ownerPhotoAudit > 10 && Number(centralAudit.rows[0]?.n) === 0 && Number(centralOther.rows[0]?.n) > 0 && Number(supAudit.rows[0]?.legal) === 0 && Number(supAudit.rows[0]?.up) > 0
        && Number(adminAudit.rows[0]?.legal) > 0 && Number(kAudit.rows[0]?.n) === 0,
      `owner=${ownerPhotoAudit} central=${centralAudit.rows[0]?.n}/${centralOther.rows[0]?.n} sup=${JSON.stringify(supAudit.rows[0])} admin=${adminAudit.rows[0]?.legal} k=${kAudit.rows[0]?.n}`);

    const forged = await rt(H.admin.userId, orgH, `UPDATE family_relationships SET photo_receipt='declined', photo_receipt_at=now() WHERE id=$1`, [famRel], false, `SELECT set_config('app.photo_receipt_writer','on',true)`);
    const forgedFam = await rt(H.fam.userId, orgH, `UPDATE family_relationships SET photo_receipt_at=now() WHERE id=$1`, [famRel], false, `SELECT set_config('app.photo_receipt_writer','on',true)`);
    const forgedIns = await rt(H.admin.userId, orgH, `INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_view_photos,photo_receipt,photo_receipt_at) VALUES ($1,$2,$3,'hijo','active',true,'accepted',now())`, [K.sup.userId, orgH, rH], false, `SELECT set_config('app.photo_receipt_writer','on',true)`);
    const legitCol = await rt(H.admin.userId, orgH, `UPDATE family_relationships SET can_view_photos=false WHERE id=$1 RETURNING photo_receipt`, [famRel]);
    const viaFn = await call("PUT", `/organizations/${orgH}/care-recipients/${rH}/photo-receipt`, H.fam.token, { decision: "declined", textVersion: "test-v2" });
    const afterFn = (await q(`SELECT photo_receipt FROM family_relationships WHERE id=$1`, [famRel])).rows[0].photo_receipt;
    await q(`UPDATE family_relationships SET status='revoked' WHERE id=$1`, [famRel]);
    const reactivate = await rt(H.admin.userId, orgH, `UPDATE family_relationships SET status='active' WHERE id=$1 RETURNING photo_receipt`, [famRel]);
    check("P05 the relative's authorization cannot be forged by app_runtime even with the session variable set: UPDATE and INSERT of those columns are refused by PostgreSQL (manager or relative context); other columns still writable; only the relative's function changes it; reactivation still resets it",
      [forged, forgedFam, forgedIns].every((r) => /permission denied/.test(String(r.error))) && legitCol.error === null && legitCol.rows[0]?.photo_receipt === "accepted"
        && viaFn.status === 200 && afterFn === "declined" && reactivate.error === null && reactivate.rows[0]?.photo_receipt === "not_answered",
      `forged=${forged.error?.slice(0, 40)} fam=${forgedFam.error?.slice(0, 40)} ins=${forgedIns.error?.slice(0, 40)} legit=${legitCol.error} fn=${viaFn.status}/${afterFn} react=${reactivate.error ?? reactivate.rows[0]?.photo_receipt}`);
    await q(`UPDATE family_relationships SET status='active' WHERE id=$1`, [famRel]);

    await hold(H.admin, ph[9].id, { action: "PLACE", reason: "Revision de una queja sintetica abierta", reviewAt: inDays(10) });
    const iso = {
      list: (await call("GET", `/organizations/${orgH}/activity-photos`, K.admin.token)).status,
      image: (await image(K.admin, pp.id)).status,
      kImageOwnPath: (await call("GET", `/organizations/${orgK}/activity-photos/${pp.id}/image`, K.admin.token)).status,
      history: (await call("GET", `/organizations/${orgK}/activity-photos/${pp.id}/history`, K.admin.token)).status,
      legal: (await call("POST", `/organizations/${orgK}/activity-photos/${pp.id}/legal-hold`, K.admin.token, { action: "RELEASE", basis: "Intento de otra agencia sintetica" })).status,
      mode: (await call("GET", `/organizations/${orgH}/activity-photos/mode`, K.admin.token)).status,
      kept: (await rt(K.admin.userId, orgK, `SELECT app_photo_kept_by_agency($1::uuid) k`, [pp.id])).rows[0]?.k,
      holdActive: (await rt(K.admin.userId, orgK, `SELECT app_photo_hold_active($1::uuid) k`, [ph[9].id])).rows[0]?.k,
      holdActiveOwn: (await rt(H.admin.userId, orgH, `SELECT app_photo_hold_active($1::uuid) k`, [ph[9].id])).rows[0]?.k,
      conf: (await rt(K.admin.userId, orgK, `SELECT * FROM app_photo_confidential($1::uuid[])`, [[pp.id]])).rows.length,
    };
    check("P06 another agency gets nothing: list/image/history/legal-hold/mode refused; the yes/no helpers answer false for another agency's photo (I2: app_photo_hold_active now checks the agency); the confidential function returns nothing",
      iso.list === 403 && [403, 404].includes(iso.image) && iso.kImageOwnPath === 404 && iso.history === 404 && iso.legal === 404 && iso.mode === 403
        && iso.kept === false && iso.holdActive === false && iso.holdActiveOwn === true && iso.conf === 0, JSON.stringify(iso));

    // L1: a late upload (allowed up to 12 h after the activity) after the caregiver's 1-hour window.
    const lateShift = await shiftFor(orgH, rH, H.cg.owm!, "4 hours");
    const lateEv = await event(lateShift, "150 minutes");
    await q(`INSERT INTO verification_events (organization_id,shift_id,organization_worker_membership_id,verification_method_id,event_type,actor_user_id,occurred_at)
      SELECT $1,$2,$3,id,'check_out',$4,now()-interval '90 minutes' FROM verification_methods WHERE code='CAREGIVER_SESSION'`, [orgH, lateShift, H.cg.owm, H.cg.userId]);
    const late = await call("POST", `/organizations/${orgH}/care-events/${lateEv}/photo`, H.cg.token, await jpeg(5));
    const lateCg = late.body.photo?.id ? (await call("GET", `/organizations/${orgH}/care-events/${lateEv}/photo`, H.cg.token)).status : -1;
    const lateAgency = late.body.photo?.id ? (await image(H.admin, late.body.photo.id)).status : -1;
    check("P07 L1: a late upload (activity within 12 h, more than 1 h after her check-out) no longer answers 500: it is stored (201), is out of her reach afterwards (404) and the agency sees it",
      late.status === 201 && lateCg === 404 && lateAgency === 200, `upload=${late.status} ${late.body.error ?? ""} cg=${lateCg} agency=${lateAgency}`);

    // ================================================================ F — the switch OFF: legal review only
    const fOver = await send();
    await legal(H.admin, fOver.id, { action: "PLACE", basis, reviewAt: inDays(20) });
    await shift("care_event_photos", "legal_hold_review_at = now() - interval '1 day'", "id=$1", [fOver.id]);
    const notHeld = ph[2]; // m3: ordinary hold only
    const centralBefore = await call("GET", `/platform/organizations/${orgH}/features`, central.token);
    const kFeatures = await call("GET", `/platform/organizations/${orgK}/features`, central.token);
    const turnOff = await call("PUT", `/platform/organizations/${orgH}/features/ACTIVITY_PHOTOS`, central.token, { enabled: false, reason: "Prueba sintetica de apagado" });
    check("F01 ETNARA central is WARNED (one boolean) that the agency has photos under a legal hold, before and when switching the module off; the switch-off is NOT blocked; an agency without holds: false; never how many or which",
      centralBefore.status === 200 && centralBefore.body.activityPhotosLegalHolds === true && kFeatures.body.activityPhotosLegalHolds === false
        && turnOff.status === 200 && turnOff.body.feature?.enabled === false && turnOff.body.feature?.legalHoldsKept === true
        && !JSON.stringify(centralBefore.body).includes(pp.id) && !JSON.stringify(turnOff.body).includes(reference),
      `before=${centralBefore.body.activityPhotosLegalHolds} k=${kFeatures.body.activityPhotosLegalHolds} off=${turnOff.status} kept=${turnOff.body.feature?.legalHoldsKept}`);

    const modes = {
      admin: (await call("GET", `/organizations/${orgH}/activity-photos/mode`, H.admin.token)).body.mode,
      sup: (await call("GET", `/organizations/${orgH}/activity-photos/mode`, H.sup.token)).body.mode,
      cg: (await call("GET", `/organizations/${orgH}/activity-photos/mode`, H.cg.token)).body.mode,
    };
    const offList = await call("GET", `/organizations/${orgH}/activity-photos`, H.admin.token);
    const offIds = (offList.body.photos as Json[] ?? []).map((x) => x.id);
    const supList = await call("GET", `/organizations/${orgH}/activity-photos`, H.sup.token);
    check("F02 switch off: the administration enters a legal-review-only mode and sees ONLY the photos under a legal hold; supervision and caregivers have no photo screen (404 FEATURE_NOT_ENABLED)",
      modes.admin === "legal-review" && modes.sup === "off" && modes.cg === "off" && offList.status === 200 && offIds.length >= 3
        && (offList.body.photos as Json[]).every((x) => x.legalHold) && !offIds.includes(notHeld.id) && supList.status === 404 && supList.body.error === "FEATURE_NOT_ENABLED",
      `${JSON.stringify(modes)} list=${offList.status}/${offIds.length} sup=${supList.status}`);

    const ev2 = await event(sH);
    const blocked = {
      upload: (await call("POST", `/organizations/${orgH}/care-events/${ev2}/photo`, H.cg.token, await jpeg(3))).status,
      hold: (await hold(H.admin, pp.id, { action: "PLACE", reason: "Intento con el modulo apagado sintetico", reviewAt: inDays(5) })).status,
      del: (await remove(H.admin, notHeld.id)).status,
      share: (await call("POST", `/organizations/${orgH}/activity-photos/${notHeld.id}/review`, H.admin.token, { decision: "WITHDRAW", expectedStatus: "approved", reason: "x prueba" })).status,
      consent: (await call("GET", `/organizations/${orgH}/care-recipients/${rH}/photo-consents`, H.admin.token)).status,
      receipt: (await call("PUT", `/organizations/${orgH}/care-recipients/${rH}/photo-receipt`, H.fam.token, { decision: "accepted", textVersion: "v3" })).status,
      newLegal: (await legal(H.admin, notHeld.id, { action: "PLACE", basis, reviewAt: inDays(20) })).status,
      supLegal: (await legal(H.sup, fOver.id, { action: "REVIEW", basis, reviewAt: inDays(20) })).status,
    };
    check("F03 switch off: no capture/upload, no sharing, no ordinary hold, no removal, no consents, no relative's authorization and NO NEW legal hold (all 404); supervision cannot act on legal holds",
      Object.entries(blocked).every(([k, s]) => (k === "supLegal" ? [403, 404].includes(s) : s === 404)), JSON.stringify(blocked));

    const auditViewsBefore = Number((await q(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action='ACTIVITY_PHOTO_LEGAL_HOLD_VIEWED'`, [fOver.id])).rows[0].n);
    const viewHeld = await image(H.admin, fOver.id);
    const viewAudit = (await q(`SELECT new_value->>'mode' m, actor_user_id FROM audit_log WHERE entity_id=$1 AND action='ACTIVITY_PHOTO_LEGAL_HOLD_VIEWED' ORDER BY occurred_at DESC LIMIT 1`, [fOver.id])).rows[0];
    const viewOther = (await image(H.admin, notHeld.id)).status;
    const viewSup = (await image(H.sup, fOver.id)).status;
    const viewFam = (await image(H.fam, pp.id)).status;
    const histHeld = (await call("GET", `/organizations/${orgH}/activity-photos/${fOver.id}/history`, H.admin.token)).status;
    const histOther = (await call("GET", `/organizations/${orgH}/activity-photos/${notHeld.id}/history`, H.admin.token)).status;
    check("F04 the administration may view a photo under a legal hold when needed for the review — every view is audited (mode legal-review, her as actor); any other photo, supervision and family: 404; history only for held photos",
      viewHeld.status === 200 && viewAudit?.m === "legal-review" && viewAudit?.actor_user_id === H.admin.userId && auditViewsBefore === 0
        && viewOther === 404 && viewSup === 404 && viewFam === 404 && histHeld === 200 && histOther === 404,
      `held=${viewHeld.status} audit=${JSON.stringify(viewAudit)} other=${viewOther} sup=${viewSup} fam=${viewFam} hist=${histHeld}/${histOther}`);

    const offNoticeBefore = Number((await q(`SELECT count(*) n FROM notifications WHERE notification_type='PHOTO_LEGAL_HOLD_REVIEW_OVERDUE' AND organization_id=$1`, [orgH])).rows[0].n);
    await runLegalReviewNotice();
    const offNotice = (await q(`SELECT user_id, item_count FROM notifications WHERE notification_type='PHOTO_LEGAL_HOLD_REVIEW_OVERDUE' AND organization_id=$1`, [orgH])).rows;
    const review = await legal(H.admin, fOver.id, { action: "REVIEW", basis: `${basis} (revisado)`, reviewAt: inDays(30) });
    const reviewAudit = (await q(`SELECT new_value->>'moduleOn' m FROM audit_log WHERE entity_id=$1 AND action='ACTIVITY_PHOTO_LEGAL_HOLD_REVIEW' ORDER BY occurred_at DESC LIMIT 1`, [fOver.id])).rows[0];
    check("F05 switch off: the daily overdue-review notice keeps reaching the administration; she can confirm the review (audited, moduleOn false)",
      offNoticeBefore === 0 && offNotice.length === 1 && offNotice[0].user_id === H.admin.userId && offNotice[0].item_count === 1 && review.status === 200 && reviewAudit?.m === "false",
      `notices=${offNotice.length} review=${review.status} audit=${JSON.stringify(reviewAudit)}`);

    for (const p of [fOver, pp, m4, lh]) await legal(H.admin, p.id, { action: "RELEASE", basis: "La obligacion termino segun el abogado sintetico" });
    const remaining = Number((await q(`SELECT count(*) n FROM care_event_photos WHERE organization_id=$1 AND deleted_at IS NULL AND legal_hold_placed_at IS NOT NULL`, [orgH])).rows[0].n);
    const modeAfter = (await call("GET", `/organizations/${orgH}/activity-photos/mode`, H.admin.token)).body.mode;
    const listAfter = (await call("GET", `/organizations/${orgH}/activity-photos`, H.admin.token)).status;
    const centralAfter = (await call("GET", `/platform/organizations/${orgH}/features`, central.token)).body.activityPhotosLegalHolds;
    check("F06 switch off: she can release the legal holds; with none left the photo screen closes for everyone (mode off, 404) and central's warning goes away",
      remaining === 0 && modeAfter === "off" && listAfter === 404 && centralAfter === false, `remaining=${remaining} mode=${modeAfter} list=${listAfter} central=${centralAfter}`);
    await feature(orgH, true);

    // ================================================================ G — agencies without an active administrator
    const D1 = await org(`HRD D1 ${tag}`), D2 = await org(`HRD D2 ${tag}`, "trial"), D3 = await org(`HRD D3 ${tag}`, "suspended"), D4 = await org(`HRD D4 ${tag}`), D5 = await org(`HRD D5 ${tag}`);
    const d1 = { admin: await person("d1-admin", D1, ["ORGANIZATION_ADMIN"]), sup: await person("d1-sup", D1, ["SUPERVISOR"]) };
    const d2 = { invited: await person("d2-inv", D2, ["ORGANIZATION_ADMIN"], false, "invited"), sup: await person("d2-sup", D2, ["SUPERVISOR"]) };
    const d4 = { admin: await person("d4-admin", D4, ["ORGANIZATION_ADMIN"]), sup: await person("d4-sup", D4, ["SUPERVISOR"]), cg: await person("d4-cg", D4, ["WORKER"], true),
      fam: await person("d4-fam", D4, ["FAMILY"]) };
    const d5 = { admin: await person("d5-admin", D5, ["ORGANIZATION_ADMIN"]), sup: await person("d5-sup", D5, ["SUPERVISOR"]) };
    await person("d3-sup", D3, ["SUPERVISOR"]);
    await q(`UPDATE users SET status='disabled' WHERE id=$1`, [d4.admin.userId]);
    await q(`UPDATE organization_memberships SET status='revoked' WHERE id=$1`, [d5.admin.membership]);
    const mine = [D1, D2, D3, D4, D5];
    const gapNotices = async () => (await q(`SELECT n.user_id, n.organization_id, n.notification_type, n.item_count, n.care_recipient_id, n.channel, n.read_at
      FROM notifications n WHERE n.notification_type IN ('AGENCY_NO_ACTIVE_ADMIN','PLATFORM_AGENCY_NO_ACTIVE_ADMIN') AND n.organization_id = ANY($1::uuid[])`, [mine])).rows as Json[];
    const asReq = await rt(d1.admin.userId, D1, `SELECT app_org_admin_gap_notify()`);
    const asCen = await rt(central.userId, "", `SELECT app_org_admin_gap_notify()`, [], true);
    const g0 = await runAdminGapNotice();
    const gaps0 = (await q(`SELECT organization_id FROM organization_admin_gaps WHERE organization_id = ANY($1::uuid[])`, [mine])).rows.map((r) => r.organization_id).sort();
    check("G01 background job only (request context and central refused); an episode opens for agencies with no ACTIVE administrator — invitation not accepted (D2), disabled account (D4), revoked membership (D5) — not for D1 (active admin) or a suspended agency (D3); nobody is notified before 24 h",
      /BACKGROUND_JOB_ONLY/.test(String(asReq.error)) && /BACKGROUND_JOB_ONLY/.test(String(asCen.error)) && gaps0.join() === [D2, D4, D5].sort().join() && (await gapNotices()).length === 0 && g0 >= 0,
      `gaps=${gaps0.length} notices=${(await gapNotices()).length}`);

    await shift("organization_admin_gaps", "since = now() - interval '25 hours'", "organization_id = ANY($1::uuid[])", [mine]);
    await runAdminGapNotice();
    const g1 = await gapNotices();
    const byKey = (t: string, o: string, uid: string) => g1.filter((x) => x.notification_type === t && x.organization_id === o && x.user_id === uid).length;
    const notOthers = g1.filter((x) => [d1.admin.userId, d1.sup.userId, d4.cg.userId, d4.fam.userId, d4.admin.userId, d5.admin.userId, d2.invited.userId, K.sup.userId].includes(x.user_id)).length;
    check("G02 after 24 h: each affected agency's ACTIVE supervisors get «no administration» (their own agency) and ETNARA central gets one per agency; nobody else (caregiver, family, disabled/revoked/invited admin, other agencies' staff)",
      byKey("AGENCY_NO_ACTIVE_ADMIN", D2, d2.sup.userId) === 1 && byKey("AGENCY_NO_ACTIVE_ADMIN", D4, d4.sup.userId) === 1 && byKey("AGENCY_NO_ACTIVE_ADMIN", D5, d5.sup.userId) === 1
        && [D2, D4, D5].every((o) => byKey("PLATFORM_AGENCY_NO_ACTIVE_ADMIN", o, central.userId) === 1) && notOthers === 0
        && g1.every((x) => x.item_count === null && x.care_recipient_id === null && x.channel === "in_app"),
      `${g1.length} notices others=${notOthers}`);

    const again = await runAdminGapNotice();
    const par = await Promise.all([runAdminGapNotice(), runAdminGapNotice(), runAdminGapNotice()]);
    check("G03 no duplicates: again and three at once create nothing more for these agencies", (await gapNotices()).length === g1.length, `again=${again} par=${par}`);

    const supLogin = await call("POST", "/auth/login", "", { email: d4.sup.email, password });
    await call("POST", "/me/active-organization", supLogin.body.token, { organizationId: D4 });
    const supRes = await call("GET", "/me/notifications", supLogin.body.token);
    const supItems = ((supRes.body.items ?? []) as Json[])
      .filter((x) => x.type === "AGENCY_NO_ACTIVE_ADMIN");
    const cenItems = ((await call("GET", "/me/notifications?limit=100", central.token)).body.items as Json[] ?? []).filter((x) => x.type === "PLATFORM_AGENCY_NO_ACTIVE_ADMIN" && mine.includes(x.relatedEntityId));
    const allText = JSON.stringify([...supItems, ...cenItems]).toLowerCase();
    check("G04 the texts: supervision «Tu agencia no tiene administración activa. Pide a ETNARA que restablezca una administradora.»; central «La agencia <nombre> no tiene administración activa»; no word about photos or legal holds",
      supItems.length === 1 && supItems[0].summary === "Tu agencia no tiene administración activa. Pide a ETNARA que restablezca una administradora."
        && cenItems.length === 3 && cenItems.some((x) => x.summary === `La agencia HRD D4 ${tag} no tiene administración activa`)
        && !/foto|photo|retenci|legal/.test(allText), `${supItems[0]?.summary} | ${cenItems.map((x) => x.summary).join(" ; ")}`);

    await q(`UPDATE users SET status='active' WHERE id=$1`, [d4.admin.userId]);
    await runAdminGapNotice();
    const closed = (await q(`SELECT count(*) n FROM organization_admin_gaps WHERE organization_id=$1`, [D4])).rows[0].n;
    await q(`UPDATE users SET status='disabled' WHERE id=$1`, [d4.admin.userId]);
    await runAdminGapNotice();
    await q(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND organization_id=$2 AND notification_type='PLATFORM_AGENCY_NO_ACTIVE_ADMIN'`, [central.userId, D4]);
    await shift("organization_admin_gaps", "since = now() - interval '25 hours'", "organization_id=$1", [D4]);
    await runAdminGapNotice();
    const d4After = (await gapNotices()).filter((x) => x.organization_id === D4 && [central.userId, d4.sup.userId].includes(x.user_id));
    check("G05 when an administrator is back the episode closes; a NEW episode notifies again after 24 h — but never a second UNREAD notice of the same kind to the same person (the supervisor still had hers unread; central had read hers)",
      closed === "0" && d4After.filter((x) => x.notification_type === "PLATFORM_AGENCY_NO_ACTIVE_ADMIN").length === 2 && d4After.filter((x) => x.notification_type === "AGENCY_NO_ACTIVE_ADMIN").length === 1,
      `closed=${closed} d4=${d4After.map((x) => x.notification_type).join(",")}`);

    // ================================================================ C — compatibility and reversal
    const refusal = await q(readFileSync(new URL("../ops/145_activity_photos_hardening.rollback.sql", import.meta.url), "utf8")).then(() => "ALLOWED", (e) => (e as Error).message);
    await q(`ROLLBACK`).catch(() => undefined);
    check("C01 the 145 rollback refuses while there are OPEN missing-file findings (review data)", /ROLLBACK_145_REFUSED/.test(refusal), refusal.slice(0, 80));

    await q(`UPDATE photo_missing_findings SET status='reappeared', resolved_at=now() WHERE status='open'`);
    await q(readFileSync(new URL("../ops/145_activity_photos_hardening.rollback.sql", import.meta.url), "utf8"));
    await q(readFileSync(new URL("../ops/144_activity_photos_legal_review_notice.rollback.sql", import.meta.url), "utf8"));
    resetNotificationSchemaProbeForTests();
    const oldDbNotif = await call("GET", "/me/notifications", H.admin.token);
    const oldDbCentral = await call("GET", "/me/notifications", central.token);
    const oldDbFeatures = await call("GET", `/platform/organizations/${orgH}/features`, central.token);
    const before = logged.length;
    const stop = startLegalReviewNoticeWorker();
    await new Promise((r) => setTimeout(r, 1500));
    stop();
    const workerLines = logged.slice(before).join(" | ");
    check("C02 M5: this code against a database WITHOUT 144/145 (wrong deployment order): notifications still answer 200 for everyone (no 500), central's features 200, and the notice worker only reports the missing migration once (no crash)",
      oldDbNotif.status === 200 && oldDbCentral.status === 200 && oldDbFeatures.status === 200 && oldDbFeatures.body.activityPhotosLegalHolds === false
        && /PHOTO_LEGAL_HOLD_NOTICE_UNAVAILABLE/.test(workerLines) && /AGENCY_ADMIN_GAP_NOTICE_UNAVAILABLE/.test(workerLines),
      `notif=${oldDbNotif.status} central=${oldDbCentral.status} features=${oldDbFeatures.status} worker=${workerLines.slice(0, 160)}`);

    await q(readFileSync(new URL("../migrations/144_activity_photos_legal_review_notice.sql", import.meta.url), "utf8"));
    await q(`INSERT INTO schema_migrations (filename) VALUES ('144_activity_photos_legal_review_notice.sql') ON CONFLICT DO NOTHING`);
    await q(readFileSync(new URL("../migrations/145_activity_photos_hardening.sql", import.meta.url), "utf8"));
    await q(`INSERT INTO schema_migrations (filename) VALUES ('145_activity_photos_hardening.sql') ON CONFLICT DO NOTHING`);
    await (await import("./lib/photoStorageTestIdentity.js")).bindTestPhotoBucket(db, s3, bucket);
    resetNotificationSchemaProbeForTests();
    const reNotif = await call("GET", "/me/notifications", H.admin.token);
    const reDenied = await rt(H.admin.userId, orgH, `SELECT legal_hold_basis FROM care_event_photos LIMIT 1`);
    check("C03 the 145 rollback restores 144's state (then 144's rollback works); applied again, 144 + 145 work and the column protection is back",
      reNotif.status === 200 && /permission denied/.test(String(reDenied.error)), `notif=${reNotif.status} denied=${!!reDenied.error}`);
  } catch (e) {
    process.stderr.write(`MAIN ${(e as Error)?.stack ?? String(e)}\n`);
    throw e;
  } finally {
    console.error = origError; console.log = origLog;
    server.close(); proxy.close();
    await pool.end().catch(() => undefined);
    await runtime.end().catch(() => undefined);
    await db.end();
    moto.kill();
  }
  const width = Math.max(...results.map((r) => r.check.length));
  console.log(`| Check${" ".repeat(Math.max(0, width - 5))} | Result | Detail |`);
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nActivity photos hardening (145): ${results.length - failed}/${results.length} PASS`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`); process.exit(1); });
