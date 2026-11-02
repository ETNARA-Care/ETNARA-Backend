/**
 * Activity photos v2 — V2 (migration 142): the expiry / purge job.
 *
 * Real app over HTTP as app_runtime, the job's own code (runRetentionCycle) as
 * app_runtime without a tenant context, a local private S3 (moto) behind a small
 * proxy that can make the storage fail. Synthetic people, residents and images
 * only. Time is simulated by moving dates in this disposable database.
 * The retention policy is approved ONLY inside this disposable database, to
 * prove what the job would do once (and only once) it is approved.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 *   optional: PHOTO_TEST_S3_PORT (default 4570), PHOTO_TEST_PYTHON (python with moto)
 */
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
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
const jpeg = (i: number) => sharp({ create: { width: 900, height: 700, channels: 3, background: ["#5a8c78", "#c9a227", "#13294b", "#8a5a44"][i % 4] } }).jpeg().toBuffer();

async function main() {
  // ---------------------------------------------------------------- local S3 + failure proxy
  const s3Port = Number(process.env.PHOTO_TEST_S3_PORT ?? 4570);
  const moto: ChildProcess = spawn(process.env.PHOTO_TEST_PYTHON ?? "python3", ["-m", "moto.server", "-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
  const motoUrl = `http://127.0.0.1:${s3Port}`;
  let up = false;
  for (let i = 0; i < 240; i++) { try { await fetch(motoUrl); up = true; break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  if (!up) { moto.kill(); throw new Error("local S3 (moto) did not start"); }
  const storage = { mode: "off" as "off" | "down" | "fake-delete" };
  const proxy = http.createServer((req, res) => {
    if (storage.mode === "down") { res.writeHead(503); res.end("<Error><Code>ServiceUnavailable</Code></Error>"); req.resume(); return; }
    if (storage.mode === "fake-delete" && req.method === "DELETE") { res.writeHead(204); res.end(); req.resume(); return; }
    const fwd = http.request({ host: "127.0.0.1", port: s3Port, method: req.method, path: req.url, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    fwd.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(fwd);
  }).listen(0);
  await new Promise((r) => proxy.once("listening", r));
  const bucket = `etnara-photos-ret-${randomBytes(4).toString("hex")}`;
  const s3 = new S3Client({ endpoint: motoUrl, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  Object.assign(process.env, {
    PHOTO_STORAGE_ENDPOINT: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, PHOTO_STORAGE_REGION: "us-east-1", PHOTO_STORAGE_BUCKET: bucket,
    PHOTO_STORAGE_ACCESS_KEY_ID: "test", PHOTO_STORAGE_SECRET_ACCESS_KEY: "test", PHOTO_STORAGE_FORCE_PATH_STYLE: "true",
  });
  delete process.env.STORAGE_ENDPOINT; delete process.env.STORAGE_BUCKET; delete process.env.PHOTO_RETENTION_JOB;
  const exists = (key: string) => s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).then(() => true, () => false);
  const countObjects = async (prefix: string) => (await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))).KeyCount ?? 0;

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
  const origError = console.error, origLog = console.log;
  console.error = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.log = (...a: unknown[]) => { const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); logged.push(line); if (!line.startsWith("PHOTO_RETENTION_RUN")) origLog(...a); };
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const { runRetentionCycle, startPhotoRetentionWorker } = await import("../src/modules/activityPhotos/retentionJob.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  async function call(method: string, path: string, token: string, body?: Json | Buffer, ct?: string) {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": ct ?? (isBuf ? "image/jpeg" : "application/json") } : {}) },
      body: body === undefined ? undefined : isBuf ? new Uint8Array(body as Buffer) : JSON.stringify(body) });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: Json = {}; if ((res.headers.get("content-type") ?? "").includes("application/json")) { try { json = JSON.parse(buf.toString()); } catch { /* */ } }
    return { status: res.status, body: json };
  }
  async function rt(userId: string, orgId: string, text: string, params: unknown[] = [], superadmin = false) {
    await runtime.query("BEGIN");
    try {
      await runtime.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`, [userId, orgId, superadmin ? "true" : "false"]);
      const r = await runtime.query(text, params); await runtime.query("ROLLBACK"); return { rows: r.rows as Json[], error: null as string | null };
    } catch (e) { await runtime.query("ROLLBACK").catch(() => undefined); return { rows: [] as Json[], error: (e as Error).message }; }
  }
  async function shift(table: string, set: string, where: string, params: unknown[]) {
    await q(`BEGIN`); await q(`SET LOCAL session_replication_role = replica`); await q(`UPDATE ${table} SET ${set} WHERE ${where}`, params); await q(`COMMIT`);
  }

  // ---------------------------------------------------------------- synthetic fixtures (two agencies)
  const org = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgA = await org(`PHR A ${tag}`), orgB = await org(`PHR B ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  const noteType = (await q<{ id: string }>(`SELECT id FROM care_event_types WHERE code='NOTE'`)).rows[0].id;
  type P = { email: string; userId: string; token: string; owm?: string; org: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `phr-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let owm: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Synthetic ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
    }
    return { email, userId, token: "", owm, org: orgId };
  }
  const A = { admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]), cg: await person("a-cg", orgA, ["WORKER"], true), fam: await person("a-fam", orgA, ["FAMILY"]) };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]), cg: await person("b-cg", orgB, ["WORKER"], true) };
  const platformUser = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [`phr-platform-${tag}@example.invalid`, hash])).rows[0].id;
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [platformUser]);
  const recipient = async (o: string) => (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Sintetica',$2,'active') RETURNING id`, [o, `R-${tag}`])).rows[0].id;
  const rA = await recipient(orgA), rB = await recipient(orgB);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_view_photos) VALUES ($1,$2,$3,'hija','active',true)`, [A.fam.userId, orgA, rA]);
  const shiftFor = async (o: string, rec: string, owm: string) => {
    const s = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '1 hour',now()+interval '3 hours','in_progress') RETURNING id`, [o, rec])).rows[0].id;
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,response_status,responded_at) VALUES ($1,$2,$3,'accepted',now())`, [o, s, owm]);
    return s;
  };
  const sA = await shiftFor(orgA, rA, A.cg.owm!), sB = await shiftFor(orgB, rB, B.cg.owm!);
  for (const p of [...Object.values(A), ...Object.values(B)]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    p.token = r.body.token; await call("POST", "/me/active-organization", p.token, { organizationId: p.org });
  }
  for (const o of [orgA, orgB]) await q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'ACTIVITY_PHOTOS',true) ON CONFLICT (organization_id,feature_code) DO UPDATE SET enabled=true`, [o]);
  const form = () => sharp({ create: { width: 300, height: 400, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
  for (const [who, rec] of [[A.admin, rA], [B.admin, rB]] as const) for (const t of ["PHOTO_CAPTURE", "PHOTO_SHARE_FAMILY"]) {
    await call("POST", `/organizations/${who.org}/care-recipients/${rec}/photo-consents?type=${t}&signerRole=LEGAL_REPRESENTATIVE`, who.token, await form(), "image/jpeg");
  }
  await call("PUT", `/organizations/${orgA}/care-recipients/${rA}/photo-receipt`, A.fam.token, { decision: "accepted", textVersion: "autorizacion-v1" });
  let n = 0;
  const send = async (who: P, sh: string, rec: string) => {
    const ev = (await q<{ id: string }>(`INSERT INTO care_events (organization_id,shift_id,care_recipient_id,organization_worker_membership_id,care_event_type_id,note_text,occurred_at) VALUES ($1,$2,$3,$4,$5,'Paseo sintetico',now()) RETURNING id`,
      [who.org, sh, rec, who.owm, noteType])).rows[0].id;
    const r = await call("POST", `/organizations/${who.org}/care-events/${ev}/photo`, who.token, await jpeg(n++));
    if (r.status !== 201) throw new Error(`upload ${r.status} ${JSON.stringify(r.body)}`);
    const id = r.body.photo.id as string;
    const key = (await q<{ k: string }>(`SELECT f.storage_key k FROM care_event_photos p JOIN stored_files f ON f.id=p.file_id WHERE p.id=$1`, [id])).rows[0].k;
    return { id, key };
  };
  const expire = (id: string) => shift("care_event_photos", "retention_until = now() - interval '1 minute'", "id=$1", [id]);
  const state = async (id: string) => (await q(`SELECT p.share_status, p.deletion_kind, p.purge_verified_at, p.hold_reason, f.storage_key, f.checksum, f.size_bytes
    FROM care_event_photos p JOIN stored_files f ON f.id=p.file_id WHERE p.id=$1`, [id])).rows[0] as Json;
  const image = (who: P, id: string) => call("GET", `/organizations/${who.org}/activity-photos/${id}/image`, who.token);
  const hold = (id: string, body: Json) => call("POST", `/organizations/${orgA}/activity-photos/${id}/hold`, A.admin.token, body);
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
  const run = (mode: "simulate" | "on", reconcile: boolean | "auto" = false, testOverrides?: Json) => runRetentionCycle({ mode, reconcile, testOverrides });
  const approvePolicy = (on: boolean) => q(on
    ? `UPDATE photo_retention_policies SET status='APPROVED', approved_by='prueba local sintetica', approved_at=now(), purge_enabled=true WHERE purpose='ACTIVITY_PHOTO'`
    : `UPDATE photo_retention_policies SET purge_enabled=false, status='PROVISIONAL', approved_by=NULL, approved_at=NULL WHERE purpose='ACTIVITY_PHOTO'`);

  try {
    // ---------------------------------------------------------------- 0. off by default, job-only functions
    const stop = startPhotoRetentionWorker();
    await new Promise((r) => setTimeout(r, 300)); stop();
    const runsAtStart = Number((await q(`SELECT count(*) n FROM photo_retention_runs`)).rows[0].n);
    const fromRequest: (string | null)[] = [];
    for (const sqlText of ["SELECT * FROM app_photo_retention_counts()", "SELECT app_photo_mark_expired(10)", "SELECT * FROM app_photo_purge_next(10)",
      "SELECT app_photo_record_lapsed_holds(10)", "SELECT * FROM app_photo_live_keys(NULL, 10)"]) fromRequest.push((await rt(A.admin.userId, orgA, sqlText)).error);
    const asPlatform = (await rt(platformUser, "", "SELECT * FROM app_photo_retention_counts()", [], true)).error;
    const readRuns = (await rt("", "", "SELECT count(*) FROM photo_retention_runs")).error;
    check("J0 the job is OFF by default (no run, nothing written); its functions refuse any request context and ETNARA central; app_runtime cannot read the run log",
      runsAtStart === 0 && fromRequest.every((e) => /PHOTO_JOB_ONLY/.test(String(e))) && /PHOTO_JOB_ONLY/.test(String(asPlatform)) && /permission denied/.test(String(readRuns)),
      `runs=${runsAtStart} ${fromRequest.join(" | ")} platform=${asPlatform} runs=${readRuns}`);

    // ---------------------------------------------------------------- scenario (counts are compared with a baseline: in CI the database is shared)
    const base0 = await run("simulate");
    const live = await send(A.cg, sA, rA);                      // not expired
    const e1 = await send(A.cg, sA, rA); await expire(e1.id);    // expired
    const h = await send(A.cg, sA, rA);                          // expired under a hold in force
    await hold(h.id, { action: "PLACE", reason: "Investigacion de un incidente", reviewAt: inDays(30) }); await expire(h.id);
    const lapsed = await send(A.cg, sA, rA);                     // hold lapsed, not expired
    await hold(lapsed.id, { action: "PLACE", reason: "Retencion que va a caducar", reviewAt: inDays(5) });
    await shift("care_event_photos", "hold_review_at = now() - interval '1 minute'", "id=$1", [lapsed.id]);
    const revoked = await send(A.cg, sA, rA);                    // relationship ended + consent revoked later (not expired)
    const qd = await send(A.cg, sA, rA);                         // a manual removal whose purge failed
    storage.mode = "down"; await call("POST", `/organizations/${orgA}/activity-photos/${qd.id}/delete`, A.admin.token, { reason: "Eliminada por la agencia" }); storage.mode = "off";
    const eB = await send(B.cg, sB, rB); await expire(eB.id);    // other agency, expired
    const formsBefore = await countObjects("photo-consent-forms/");

    // ---------------------------------------------------------------- 1. simulation: counts only
    const sim = await run("simulate", true);
    const unchanged = [await state(e1.id), await state(lapsed.id), await state(qd.id), await state(eB.id)];
    check("J1 simulation counts (expired, held, lapsed holds, pending removals) and changes NOTHING: no removal, no hold cleared, no retry, every file still there; the run is logged with counts only",
      sim.expiredDue - base0.expiredDue === 2 && sim.heldSkipped - base0.heldSkipped === 1 && sim.holdsLapsed - base0.holdsLapsed === 1
        && sim.queuePending - base0.queuePending === 1 && sim.expiredMarked === 0 && sim.purgedVerified === 0
        && unchanged[0].share_status === "approved" && unchanged[1].hold_reason !== null && unchanged[2].purge_verified_at === null && unchanged[3].share_status === "approved"
        && (await exists(e1.key)) && (await exists(qd.key)) && (await exists(eB.key)),
      JSON.stringify({ due: sim.expiredDue, held: sim.heldSkipped, lapsed: sim.holdsLapsed, queue: sim.queuePending, marked: sim.expiredMarked }));

    // ---------------------------------------------------------------- 2. real mode with the PROVISIONAL policy
    const direct = (await rt("", "", "SELECT app_photo_mark_expired(10)")).error;
    await shift("photo_purge_queue", "last_attempt_at = now() - interval '3 minutes'", "photo_id=$1", [qd.id]); // past its first back-off
    const prov = await run("on");
    const lapsedHist = (await q(`SELECT count(*) n FROM care_event_photo_events WHERE photo_id=$1 AND action='HOLD_EXPIRED'`, [lapsed.id])).rows[0].n;
    check("J2 real mode while the 30 days are PROVISIONAL: no expired photo is deleted (the database refuses), but the lapsed hold is recorded and the removal a person already decided is retried and verified",
      /PHOTO_PURGE_DISABLED/.test(String(direct)) && prov.expiredMarked === 0 && (await state(e1.id)).share_status === "approved" && (await exists(e1.key)) && (await exists(eB.key))
        && Number(lapsedHist) === 1 && (await state(lapsed.id)).hold_reason === null && prov.purgedVerified >= 1 && !(await exists(qd.key)) && (await state(qd.id)).purge_verified_at !== null,
      `${direct} marked=${prov.expiredMarked} lapsed=${lapsedHist} purged=${prov.purgedVerified}`);

    // ---------------------------------------------------------------- 3. what it would do once approved (disposable DB only)
    await approvePolicy(true);
    await q(`UPDATE family_relationships SET status='revoked', revoked_at=now() WHERE user_id=$1`, [A.fam.userId]);
    const consents = (await call("GET", `/organizations/${orgA}/care-recipients/${rA}/photo-consents`, A.admin.token)).body.consents as Json[];
    await call("POST", `/organizations/${orgA}/photo-consents/${consents.find((c) => c.type === "PHOTO_SHARE_FAMILY" && c.active)!.id}/revoke`, A.admin.token, { reason: "Revocacion sintetica" });
    const appr = await run("on");
    const e1s = await state(e1.id), hs = await state(h.id), eBs = await state(eB.id);
    const e1Hist = (await q(`SELECT action, actor_user_id, reason FROM care_event_photo_events WHERE photo_id=$1 ORDER BY occurred_at, (action <> 'UPLOADED')`, [e1.id])).rows;
    check("J3 with an APPROVED policy (only in this test database): expired photos of BOTH agencies are deleted, verified, tombstoned without key/size/checksum; history DELETED (RETENTION, no person) + PURGED",
      appr.expiredMarked >= 2 && appr.purgedVerified >= 2 && e1s.deletion_kind === "RETENTION" && e1s.purge_verified_at !== null && e1s.storage_key.startsWith("purged/")
        && e1s.checksum === null && Number(e1s.size_bytes) === 0 && !(await exists(e1.key)) && eBs.deletion_kind === "RETENTION" && !(await exists(eB.key))
        && e1Hist.some((x) => x.action === "DELETED" && x.actor_user_id === null && /^RETENTION/.test(x.reason)) && e1Hist.at(-1)?.action === "PURGED",
      `marked=${appr.expiredMarked} purged=${appr.purgedVerified} ${e1s.deletion_kind} ${e1Hist.map((x) => x.action).join(",")}`);
    check("J4 exceptions: a photo under a hold in force is NOT deleted (manager still sees it); not-yet-expired photos are NOT deleted although the relationship ended and the sharing consent was revoked; consent forms untouched",
      hs.share_status === "approved" && (await exists(h.key)) && (await image(A.admin, h.id)).status === 200 && (await state(live.id)).share_status === "approved" && (await exists(live.key))
        && (await state(revoked.id)).share_status === "approved" && (await exists(revoked.key)) && (await countObjects("photo-consent-forms/")) === formsBefore,
      `held=${hs.share_status} live=${(await state(live.id)).share_status} revoked=${(await state(revoked.id)).share_status} forms=${await countObjects("photo-consent-forms/")}/${formsBefore}`);
    await shift("care_event_photos", "hold_review_at = now() - interval '1 minute'", "id=$1", [h.id]);
    const afterLapse = await run("on");
    check("J5 when the hold lapses (review date passed, not renewed) it is recorded and the expired photo is deleted in the same run",
      afterLapse.holdsLapsed >= 1 && afterLapse.expiredMarked >= 1 && (await state(h.id)).deletion_kind === "RETENTION" && !(await exists(h.key)), JSON.stringify({ l: afterLapse.holdsLapsed, m: afterLapse.expiredMarked }));

    // ---------------------------------------------------------------- 4. storage errors, back-off, verification, alert
    const f = await send(A.cg, sA, rA); await expire(f.id);
    storage.mode = "down";
    const down = await run("on");
    storage.mode = "off";
    const fq1 = (await q(`SELECT attempts, last_error_code, purged_at FROM photo_purge_queue WHERE photo_id=$1`, [f.id])).rows[0];
    const blocked = await image(A.admin, f.id);
    const fAfterDown = { exists: await exists(f.key), status: (await state(f.id)).share_status };
    const tooSoon = await run("on");
    const fq2 = (await q(`SELECT attempts FROM photo_purge_queue WHERE photo_id=$1`, [f.id])).rows[0];
    const stillThereBeforeRetry = await exists(f.key);
    await shift("photo_purge_queue", "last_attempt_at = now() - interval '3 minutes'", "photo_id=$1", [f.id]);
    const retry = await run("on");
    check("S1 storage down: access is cut at once, the purge is NOT marked done and the error is kept; no retry before the back-off; after it, the retry deletes and verifies",
      down.expiredMarked >= 1 && down.purgeFailed >= 1 && fAfterDown.status === "deleted" && fq1.attempts === 1 && fq1.last_error_code && fq1.purged_at === null && blocked.status === 404 && fAfterDown.exists
        && fq2.attempts === 1 && stillThereBeforeRetry && retry.purgedVerified >= 1 && !(await exists(f.key)) && (await state(f.id)).purge_verified_at !== null,
      `${JSON.stringify(fq1)} soon=${tooSoon.purgedVerified}/${fq2.attempts} retry=${retry.purgedVerified} marked=${down.expiredMarked} failed=${down.purgeFailed} blocked=${blocked.status} before=${stillThereBeforeRetry} after=${await exists(f.key)} st=${JSON.stringify(await state(f.id))}`);
    const g = await send(A.cg, sA, rA); await expire(g.id);
    storage.mode = "fake-delete";
    const fake = await run("on");
    storage.mode = "off";
    const gq = (await q(`SELECT last_error_code, purged_at FROM photo_purge_queue WHERE photo_id=$1`, [g.id])).rows[0];
    check("S2 a delete that does not delete is caught by the verification (STILL_PRESENT): never a false «deleted»", fake.purgeFailed >= 1 && gq.last_error_code === "STILL_PRESENT" && gq.purged_at === null && (await exists(g.key)),
      JSON.stringify(gq));
    await shift("photo_purge_queue", "enqueued_at = now() - interval '25 hours', last_attempt_at = now() - interval '7 hours'", "photo_id=$1", [g.id]);
    storage.mode = "down";
    const old = await run("on");
    storage.mode = "off";
    check("S3 a removal pending for more than 24 h raises an alert (counts only) and is counted in the run log", old.pendingOver24h >= 1 && logged.some((l) => l.includes("PHOTO_PURGE_ALERT")),
      `pendingOver24h=${old.pendingOver24h}`);
    await shift("photo_purge_queue", "last_attempt_at = now() - interval '7 hours'", "photo_id=$1", [g.id]);
    await run("on");

    // ---------------------------------------------------------------- 5. reconciliation (weekly)
    const orphanKey = `activity-photos/${orgA}/${rA}/${randomUUID()}.jpg`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: orphanKey, Body: await jpeg(9), ContentType: "image/jpeg" }));
    const m = await send(A.cg, sA, rA);
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: m.key }));  // as if the database had been restored to before its removal
    await approvePolicy(false);
    const simRec = await run("simulate", true, { orphanMinAgeMs: 0, orphanDeleteMinAgeMs: 0 });
    const mAfterSim = (await state(m.id)).share_status;
    const provRec = await run("on", true, { orphanMinAgeMs: 0, orphanDeleteMinAgeMs: 0 });
    check("R1 reconciliation with the PROVISIONAL policy: the orphan file is found but NOT deleted; the photo whose file is gone is reported (simulate) and tombstoned RECONCILED (on); nobody sees it",
      simRec.reconciled && simRec.orphansFound === 1 && simRec.missingMarked >= 1 && mAfterSim !== "deleted" // simulate changed nothing
        && provRec.orphansFound === 1 && provRec.orphansDeleted === 0 && (await exists(orphanKey)) && provRec.missingMarked >= 1
        && (await state(m.id)).deletion_kind === "RECONCILED" && (await image(A.admin, m.id)).status === 404,
      JSON.stringify({ sim: [simRec.orphansFound, simRec.missingMarked], on: [provRec.orphansFound, provRec.orphansDeleted, provRec.missingMarked], orphan: await exists(orphanKey), m: await state(m.id), img: (await image(A.admin, m.id)).status }));
    const young = await run("on", true);
    check("R2 an orphan younger than 1 h (an upload in flight) is not even counted; reconciliation is weekly (auto does not repeat it)",
      young.orphansFound === 0 && (await run("on", "auto")).reconciled === false, `${young.orphansFound}`);
    await approvePolicy(true);
    const apprRec = await run("on", true, { orphanMinAgeMs: 0, orphanDeleteMinAgeMs: 0 });
    const keep = await send(A.cg, sA, rA);
    storage.mode = "down";
    const downRec = await run("on", true, { orphanMinAgeMs: 0, orphanDeleteMinAgeMs: 0 });
    storage.mode = "off";
    check("R3 with an APPROVED policy, an orphan older than the retention period is deleted (verified); with the storage down nothing is wrongly marked missing",
      apprRec.orphansDeleted === 1 && !(await exists(orphanKey)) && downRec.missingMarked === 0 && (await state(keep.id)).share_status !== "deleted" && (await exists(keep.key)) && downRec.errorCodes.length > 0,
      `${apprRec.orphansDeleted} down=${downRec.missingMarked} ${downRec.errorCodes.join(",")}`);

    // ---------------------------------------------------------------- 6. concurrency, audit, isolation, rollback guard
    const both = await Promise.all([run("simulate"), run("simulate")]);
    check("C1 two cycles at once (two replicas): one runs, the other is skipped (advisory lock)", both.filter((r) => r.skipped === "LOCKED").length === 1, both.map((r) => r.skipped ?? "ran").join(","));
    const runs = (await q(`SELECT * FROM photo_retention_runs ORDER BY started_at`)).rows;
    const runText = JSON.stringify(runs);
    const editRun = await q(`UPDATE photo_retention_runs SET orphans_found = 0`).then(() => "ALLOWED", (e) => (e as Error).message);
    check("A1 every run is in an append-only log with mode, policy (status/days/purge) and counts; it never holds a key, bucket name or id of a photo",
      runs.length >= 12 && runs.some((r) => r.mode === "simulate") && runs.some((r) => r.policy_status === "PROVISIONAL") && runs.some((r) => r.policy_status === "APPROVED")
        && !runText.includes("activity-photos/") && !runText.includes(bucket) && ![e1.id, h.id, f.id].some((id) => runText.includes(id)) && /HISTORY_APPEND_ONLY/.test(editRun),
      `runs=${runs.length} ${editRun.slice(0, 40)}`);
    const leak = logged.some((l) => l.includes("activity-photos/") || l.includes(bucket));
    check("A2 no log line carries a storage key or bucket name (counts and error classes only)", !leak, `${logged.length} lines`);
    const bView = await call("GET", `/organizations/${orgB}/activity-photos`, B.admin.token);
    check("I1 each agency sees only its own tombstones; the job acted on both agencies only by their own expiry",
      bView.status === 200 && (bView.body.photos as Json[]).every((p) => p.id === eB.id) && (bView.body.photos as Json[]).length === 1, `${bView.status} ${(bView.body.photos as Json[] ?? []).length}`);
    const rollback = readFileSync(new URL("../ops/142_activity_photos_retention_purge.rollback.sql", import.meta.url), "utf8");
    const rb = await q(rollback).then(() => "APPLIED", async (e) => { await q("ROLLBACK").catch(() => undefined); return (e as Error).message; });
    check("R4 the 142 rollback refuses to run once the job has left a trace (run log), and changes nothing", /rollback 142 aborted/.test(rb), rb.slice(0, 100));
    await approvePolicy(false);
  } finally {
    console.error = origError; console.log = origLog;
    server.close(); proxy.close();
    await pool.end().catch(() => undefined);
    await runtime.end().catch(() => undefined);
    await db.end();
    moto.kill();
  }

  console.log("\nActivity photos v2 · V2 expiry / purge job (142)\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nActivity photo retention: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Activity photo retention verification failed:", error);
  process.exit(1);
});
