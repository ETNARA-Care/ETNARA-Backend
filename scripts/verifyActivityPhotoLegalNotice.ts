/**
 * Activity photos v2 — D1 (the caregiver's «Quitar foto» window and holds) and
 * D2 (migration 144: daily in-app notice of overdue legal-hold reviews).
 *
 * Real app over HTTP as app_runtime, the notice's own code (runLegalReviewNotice,
 * startLegalReviewNoticeWorker) as app_runtime without a tenant context, a local
 * private S3 (moto). Synthetic people, residents and images only. Time is
 * simulated by moving dates in this disposable database.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 *   optional: PHOTO_TEST_S3_PORT (default 4571), PHOTO_TEST_PYTHON (python with moto)
 */
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CreateBucketCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
const NOTICE = "PHOTO_LEGAL_HOLD_REVIEW_OVERDUE";

async function main() {
  // ---------------------------------------------------------------- local private S3
  const s3Port = Number(process.env.PHOTO_TEST_S3_PORT ?? 4571);
  const moto: ChildProcess = spawn(process.env.PHOTO_TEST_PYTHON ?? "python3", ["-m", "moto.server", "-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
  const motoUrl = `http://127.0.0.1:${s3Port}`;
  let up = false;
  for (let i = 0; i < 240; i++) { try { await fetch(motoUrl); up = true; break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  if (!up) { moto.kill(); throw new Error("local S3 (moto) did not start"); }
  const bucket = `etnara-photos-notice-${randomBytes(4).toString("hex")}`;
  const s3 = new S3Client({ endpoint: motoUrl, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  Object.assign(process.env, {
    PHOTO_STORAGE_ENDPOINT: motoUrl, PHOTO_STORAGE_REGION: "us-east-1", PHOTO_STORAGE_BUCKET: bucket,
    PHOTO_STORAGE_ACCESS_KEY_ID: "test", PHOTO_STORAGE_SECRET_ACCESS_KEY: "test", PHOTO_STORAGE_FORCE_PATH_STYLE: "true",
  });
  // The expiry / purge job stays OFF for the whole run: the notice must work without it.
  delete process.env.STORAGE_ENDPOINT; delete process.env.STORAGE_BUCKET; delete process.env.PHOTO_RETENTION_JOB; delete process.env.PHOTO_LEGAL_HOLD_NOTICE;
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
  const logged: string[] = [];
  const origError = console.error, origLog = console.log;
  console.error = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.log = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  const { hashPassword } = await import("../src/security/password.js");
  // 145 (H1): this verifier's own bucket is bound as the photos' storage (operator procedure, test DB only).
  await (await import("./lib/photoStorageTestIdentity.js")).bindTestPhotoBucket(db, s3, bucket);
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const { env } = await import("../src/config/env.js");
  const { startPhotoRetentionWorker } = await import("../src/modules/activityPhotos/retentionJob.js");
  const { runLegalReviewNotice, startLegalReviewNoticeWorker } = await import("../src/modules/activityPhotos/legalReviewNotice.js");
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
  async function rt(userId: string, orgId: string, text: string, superadmin = false) {
    await runtime.query("BEGIN");
    try {
      await runtime.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`, [userId, orgId, superadmin ? "true" : "false"]);
      const r = await runtime.query(text); await runtime.query("ROLLBACK"); return { rows: r.rows as Json[], error: null as string | null };
    } catch (e) { await runtime.query("ROLLBACK").catch(() => undefined); return { rows: [] as Json[], error: (e as Error).message }; }
  }
  /** Moves dates in this disposable database (triggers off for this one statement). */
  async function shift(table: string, set: string, where: string, params: unknown[]) {
    await q(`BEGIN`); await q(`SET LOCAL session_replication_role = replica`); await q(`UPDATE ${table} SET ${set} WHERE ${where}`, params); await q(`COMMIT`);
  }

  // ---------------------------------------------------------------- synthetic fixtures (three agencies)
  const org = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgA = await org(`PLN A ${tag}`), orgB = await org(`PLN B ${tag}`), orgC = await org(`PLN C ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  const noteType = (await q<{ id: string }>(`SELECT id FROM care_event_types WHERE code='NOTE'`)).rows[0].id;
  type P = { email: string; userId: string; token: string; owm?: string; org: string; membership: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `pln-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let owm: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Synthetic ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
    }
    return { email, userId, token: "", owm, org: orgId, membership: m };
  }
  const A = {
    admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]), admin2: await person("a-admin2", orgA, ["ORGANIZATION_ADMIN"]),
    adminGone: await person("a-admin-gone", orgA, ["ORGANIZATION_ADMIN"]), sup: await person("a-sup", orgA, ["SUPERVISOR"]),
    cg: await person("a-cg", orgA, ["WORKER"], true), fam: await person("a-fam", orgA, ["FAMILY"]),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]), cg: await person("b-cg", orgB, ["WORKER"], true) };
  const C = { admin: await person("c-admin", orgC, ["ORGANIZATION_ADMIN"]), cg: await person("c-cg", orgC, ["WORKER"], true) };
  const platformUser = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [`pln-platform-${tag}@example.invalid`, hash])).rows[0].id;
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [platformUser]);
  const recipient = async (o: string) => (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Sintetica',$2,'active') RETURNING id`, [o, `R-${tag}`])).rows[0].id;
  const rA = await recipient(orgA), rB = await recipient(orgB), rC = await recipient(orgC);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_view_photos) VALUES ($1,$2,$3,'hija','active',true)`, [A.fam.userId, orgA, rA]);
  const shiftFor = async (o: string, rec: string, owm: string) => {
    const s = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '1 hour',now()+interval '3 hours','in_progress') RETURNING id`, [o, rec])).rows[0].id;
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,response_status,responded_at) VALUES ($1,$2,$3,'accepted',now())`, [o, s, owm]);
    return s;
  };
  const sA = await shiftFor(orgA, rA, A.cg.owm!), sB = await shiftFor(orgB, rB, B.cg.owm!), sC = await shiftFor(orgC, rC, C.cg.owm!);
  for (const p of [...Object.values(A), ...Object.values(B), ...Object.values(C)]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    p.token = r.body.token; await call("POST", "/me/active-organization", p.token, { organizationId: p.org });
  }
  const feature = (o: string, on: boolean) => q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'ACTIVITY_PHOTOS',$2)
    ON CONFLICT (organization_id,feature_code) DO UPDATE SET enabled=EXCLUDED.enabled`, [o, on]);
  for (const o of [orgA, orgB, orgC]) await feature(o, true);
  const form = () => sharp({ create: { width: 300, height: 400, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
  for (const [who, rec] of [[A.admin, rA], [B.admin, rB], [C.admin, rC]] as const) for (const t of ["PHOTO_CAPTURE", "PHOTO_SHARE_FAMILY"]) {
    await call("POST", `/organizations/${who.org}/care-recipients/${rec}/photo-consents?type=${t}&signerRole=LEGAL_REPRESENTATIVE`, who.token, await form(), "image/jpeg");
  }
  let n = 0;
  const send = async (who: P, sh: string, rec: string) => {
    const ev = (await q<{ id: string }>(`INSERT INTO care_events (organization_id,shift_id,care_recipient_id,organization_worker_membership_id,care_event_type_id,note_text,occurred_at) VALUES ($1,$2,$3,$4,$5,'Paseo sintetico',now()) RETURNING id`,
      [who.org, sh, rec, who.owm, noteType])).rows[0].id;
    const r = await call("POST", `/organizations/${who.org}/care-events/${ev}/photo`, who.token, await jpeg(n++));
    if (r.status !== 201) throw new Error(`upload ${r.status} ${JSON.stringify(r.body)}`);
    const id = r.body.photo.id as string;
    const key = (await q<{ k: string }>(`SELECT f.storage_key k FROM care_event_photos p JOIN stored_files f ON f.id=p.file_id WHERE p.id=$1`, [id])).rows[0].k;
    return { id, key, ev };
  };
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
  const basis = "Requerimiento judicial sintetico de conservacion";
  const reference = `CASO-SINT-${tag}`;
  const legal = (who: P, id: string, body: Json) => call("POST", `/organizations/${who.org}/activity-photos/${id}/legal-hold`, who.token, body);
  const hold = (who: P, id: string, body: Json) => call("POST", `/organizations/${who.org}/activity-photos/${id}/hold`, who.token, body);
  const remove = (who: P, id: string) => call("POST", `/organizations/${who.org}/activity-photos/${id}/delete`, who.token, {});
  const ref = (who: P, ev: string) => call("GET", `/organizations/${who.org}/care-events/${ev}/photo`, who.token);
  const checkOut = (o: string, sh: string, owm: string, user: string, minutesAgo: number) => q(`INSERT INTO verification_events (organization_id,shift_id,organization_worker_membership_id,verification_method_id,event_type,actor_user_id,occurred_at)
    SELECT $1,$2,$3,id,'check_out',$4,now()-make_interval(mins=>$5::int) FROM verification_methods WHERE code='CAREGIVER_SESSION'`, [o, sh, owm, user, minutesAgo]);
  const notices = async (where = "true", params: unknown[] = []) => (await q(`SELECT n.*, u.email FROM notifications n JOIN users u ON u.id=n.user_id
    WHERE n.notification_type='${NOTICE}' AND ${where} ORDER BY u.email`, params)).rows as Json[];
  const overdue = (id: string) => shift("care_event_photos", "legal_hold_review_at = now() - interval '1 day'", "id=$1", [id]);

  try {
    // ================================================================ D1 — the caregiver's «Quitar foto»
    const h1 = await send(A.cg, sA, rA);
    await hold(A.admin, h1.id, { action: "PLACE", reason: "Revision de una queja sintetica abierta", reviewAt: inDays(10) });
    const hView = (await ref(A.cg, h1.ev)).body.photo as Json;
    const hDel = await remove(A.cg, h1.id);
    const hAudit = Number((await q(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action='ACTIVITY_PHOTO_DELETED'`, [h1.id])).rows[0].n);
    check("K1 under an ordinary hold in force the caregiver sees no «Quitar foto» (canRemove false, keptByAgency true) and the backend refuses it (145: 409 PHOTO_KEPT_BY_AGENCY, the same code for any hold); the file stays, nothing audited as deleted",
      hView?.canRemove === false && hView?.keptByAgency === true && hDel.status === 409 && hDel.body.error === "PHOTO_KEPT_BY_AGENCY" && (await exists(h1.key)) && hAudit === 0,
      `${JSON.stringify(hView)} delete=${hDel.status} ${hDel.body.error} audit=${hAudit}`);
    const l1 = await send(A.cg, sA, rA);
    await legal(A.admin, l1.id, { action: "PLACE", basis, reference, reviewAt: inDays(30) });
    const lView = (await ref(A.cg, l1.ev)).body.photo as Json;
    const lDel = await remove(A.cg, l1.id);
    const viewText = JSON.stringify(lView);
    check("K2 under a legal hold the same: no button, 409 PHOTO_KEPT_BY_AGENCY (145: identical to K1); she learns only that the agency keeps it (never the basis, the reference or which kind of hold)",
      lView?.canRemove === false && lView?.keptByAgency === true && lDel.status === 409 && lDel.body.error === "PHOTO_KEPT_BY_AGENCY" && (await exists(l1.key))
        && Object.keys(lView ?? {}).sort().join(",") === "canRemove,id,keptByAgency,sharedWithFamily,status" && !viewText.includes("SINT") && !viewText.includes("judicial"),
      `${viewText} delete=${lDel.status} ${lDel.body.error}`);
    await hold(A.admin, h1.id, { action: "RELEASE", reason: "Queja sintetica cerrada sin conservar" });
    const rView = (await ref(A.cg, h1.ev)).body.photo as Json;
    const undo = await remove(A.cg, h1.id);
    const audit = (await q(`SELECT actor_user_id, new_value->>'kind' kind FROM audit_log WHERE entity_id=$1 AND action='ACTIVITY_PHOTO_DELETED'`, [h1.id])).rows;
    const hist = (await q(`SELECT action FROM care_event_photo_events WHERE photo_id=$1 ORDER BY occurred_at, id`, [h1.id])).rows.map((r) => r.action);
    check("K3 once released, inside her visit, she can remove it: CAREGIVER_UNDO, purged and verified, audited with her as the actor, in the history",
      rView?.canRemove === true && rView?.keptByAgency === false && undo.status === 200 && undo.body.photo?.kind === "CAREGIVER_UNDO" && !(await exists(h1.key))
        && audit.length === 1 && audit[0].actor_user_id === A.cg.userId && audit[0].kind === "CAREGIVER_UNDO" && hist.join(",").endsWith("DELETED,PURGED"),
      `${JSON.stringify(rView)} undo=${undo.status} audit=${JSON.stringify(audit)} hist=${hist.join(",")}`);
    // Window: up to 1 hour after the end of the visit (D1), then never.
    const w1 = await send(B.cg, sB, rB);
    const w2 = await send(B.cg, sB, rB);
    await checkOut(orgB, sB, B.cg.owm!, B.cg.userId, 30);
    const at30 = { view: (await ref(B.cg, w1.ev)).body.photo?.canRemove, remove: (await remove(B.cg, w1.id)).status };
    await q(`DELETE FROM verification_events WHERE shift_id=$1`, [sB]);
    await checkOut(orgB, sB, B.cg.owm!, B.cg.userId, 61);
    const at61 = { view: (await ref(B.cg, w2.ev)).status, remove: (await remove(B.cg, w2.id)).status };
    check("K4 the window is at most 1 hour after the visit ends: 30 min after check-out she can still remove it; 61 min after, the photo is out of her reach (404) and stays for the agency",
      at30.view === true && at30.remove === 200 && at61.view === 404 && at61.remove === 404 && (await exists(w2.key)), `+30=${JSON.stringify(at30)} +61=${JSON.stringify(at61)}`);
    // The confirmation lives in the app (ActivityPhotoThumb: «¿Quitar esta foto?» → «Sí, quitar»); covered by the frontend tests.

    // ================================================================ D2 — the daily notice
    // Agency A: 3 legal holds, 2 overdue (+ l1 above, review in 30 days). Agency B: 1 overdue. Agency C: 1 overdue, switch OFF.
    const a2 = await send(A.cg, sA, rA), a3 = await send(A.cg, sA, rA);
    for (const p of [a2, a3]) await legal(A.admin, p.id, { action: "PLACE", basis, reference, reviewAt: inDays(20) });
    const bOpen = await shiftFor(orgB, rB, B.cg.owm!);
    const b1 = await send(B.cg, bOpen, rB);
    await legal(B.admin, b1.id, { action: "PLACE", basis, reviewAt: inDays(20) });
    const c1 = await send(C.cg, sC, rC);
    await legal(C.admin, c1.id, { action: "PLACE", basis, reviewAt: inDays(20) });
    for (const p of [a2, a3, b1, c1]) await overdue(p.id);
    await feature(orgC, false);
    await q(`UPDATE organization_memberships SET status='revoked' WHERE id=$1`, [A.adminGone.membership]);

    const asRequest = await rt(A.admin.userId, orgA, `SELECT app_photo_legal_review_notify()`);
    const asCentral = await rt(platformUser, "", `SELECT app_photo_legal_review_notify()`, true);
    const asPublic = await q(`SELECT has_function_privilege('public', 'public.app_photo_legal_review_notify()', 'EXECUTE') AS ok`);
    check("N1 the notice function is for the background job only: refused from a request (agency context) and from ETNARA central; not executable by PUBLIC",
      /BACKGROUND_JOB_ONLY/.test(String(asRequest.error)) && /BACKGROUND_JOB_ONLY/.test(String(asCentral.error)) && asPublic.rows[0].ok === false,
      `${asRequest.error} | ${asCentral.error}`);

    // The expiry job is OFF (default) and the notice still runs.
    const runsBefore = Number((await q(`SELECT count(*) n FROM photo_retention_runs`)).rows[0].n);
    const stopJob = startPhotoRetentionWorker();
    const stopNotice = startLegalReviewNoticeWorker();
    let first: Json[] = [];
    for (let i = 0; i < 40 && first.length < 4; i++) { await new Promise((r) => setTimeout(r, 250)); first = await notices(); }
    stopJob(); stopNotice();
    const runsAfter = Number((await q(`SELECT count(*) n FROM photo_retention_runs`)).rows[0].n);
    check("N2 with the expiry/purge job OFF (PHOTO_RETENTION_JOB unset → off; it did not run) the notice worker still creates today's notices",
      env.PHOTO_RETENTION_JOB === "off" && env.PHOTO_LEGAL_HOLD_NOTICE === "on" && runsAfter === runsBefore && first.length === 4,
      `job=${env.PHOTO_RETENTION_JOB} notice=${env.PHOTO_LEGAL_HOLD_NOTICE} runs=${runsBefore}->${runsAfter} notices=${first.length}`);

    const byUser = Object.fromEntries(first.map((r) => [r.user_id, r]));
    const others = [A.sup, A.cg, A.fam, A.adminGone, B.cg, C.cg].filter((p) => byUser[p.userId]).map((p) => p.email);
    check("N3 only the ACTIVE administrators of each agency receive it, each with their own agency's count: A's two admins get 2, B's admin gets 1, C's admin 1 (145 §5: also with the switch off); nobody else (supervisor, caregiver, family, a revoked admin, ETNARA central)",
      byUser[C.admin.userId]?.item_count === 1 && byUser[C.admin.userId]?.organization_id === orgC && byUser[A.admin.userId]?.item_count === 2 && byUser[A.admin2.userId]?.item_count === 2 && byUser[B.admin.userId]?.item_count === 1
        && byUser[A.admin.userId]?.organization_id === orgA && byUser[B.admin.userId]?.organization_id === orgB && others.length === 0 && !byUser[platformUser],
      `${first.map((r) => `${r.email.split("-").slice(1, 3).join("-")}:${r.item_count}`).join(" ")} others=${others.join(",")}`);
    const rowText = JSON.stringify(first);
    check("N4 the notice holds the count and the agency only: no photo, resident, basis or reference; in-app (no e-mail, no SMS)",
      first.every((r) => r.related_entity_type === "organization" && r.related_entity_id === r.organization_id && r.care_recipient_id === null && r.channel === "in_app" && r.status === "sent")
        && ![a2.id, a3.id, b1.id, c1.id, rA, rB, reference, "judicial"].some((x) => rowText.includes(x)),
      first.map((r) => `${r.channel}/${r.related_entity_type}`).join(" "));

    const again = await runLegalReviewNotice();
    const parallel = await Promise.all([runLegalReviewNotice(), runLegalReviewNotice(), runLegalReviewNotice()]);
    const stillThree = (await notices()).length;
    check("N5 no duplicates: running again the same day (also three at once, as several replicas or hourly ticks would) creates nothing more",
      again === 0 && parallel.every((x) => x === 0) && stillThree === 4, `again=${again} parallel=${parallel} total=${stillThree}`);

    const api = await call("GET", "/me/notifications", A.admin.token);
    const item = (api.body.items as Json[]).find((x) => x.type === NOTICE);
    const apiB = await call("GET", "/me/notifications", B.admin.token);
    const itemsB = (apiB.body.items as Json[]).filter((x) => x.type === NOTICE);
    const supItems = ((await call("GET", "/me/notifications", A.sup.token)).body.items as Json[]).filter((x) => x.type === NOTICE);
    const itemText = JSON.stringify(item);
    check("N6 in the administrator's portal: «2 fotografías con retención legal tienen la revisión vencida», itemCount 2, pointing to her agency only; B's admin sees only B's (1); the supervisor none",
      api.status === 200 && item?.summary === "2 fotografías con retención legal tienen la revisión vencida" && item?.itemCount === 2 && item?.relatedEntityType === "organization"
        && item?.relatedEntityId === orgA && item?.careRecipientId === null && ![a2.id, a3.id, rA, reference].some((x) => itemText.includes(x))
        && itemsB.length === 1 && itemsB[0].itemCount === 1 && itemsB[0].summary === "1 fotografía con retención legal tiene la revisión vencida" && itemsB[0].relatedEntityId === orgB && supItems.length === 0,
      `${item?.summary} | B: ${itemsB.map((x) => x.summary).join(";")} | sup=${supItems.length}`);

    const link = await call("GET", `/organizations/${orgA}/activity-photos?legalReview=overdue`, A.admin.token);
    const linkIds = (link.body.photos as Json[] ?? []).map((p) => p.id).sort();
    const linkB = await call("GET", `/organizations/${orgB}/activity-photos?legalReview=overdue`, B.admin.token);
    const linkOthers = { sup: (await call("GET", `/organizations/${orgA}/activity-photos?legalReview=overdue`, A.sup.token)).status,
      cg: (await call("GET", `/organizations/${orgA}/activity-photos?legalReview=overdue`, A.cg.token)).status,
      fam: (await call("GET", `/organizations/${orgA}/activity-photos?legalReview=overdue`, A.fam.token)).status,
      bOnA: (await call("GET", `/organizations/${orgA}/activity-photos?legalReview=overdue`, B.admin.token)).status };
    check("N7 the link opens exactly the overdue legal reviews of her own agency (A: the 2 overdue, not the one still in time; B: its 1); caregiver, family and another agency refused",
      link.status === 200 && linkIds.join() === [a2.id, a3.id].sort().join() && (link.body.photos as Json[]).every((p) => p.legalHold?.reviewOverdue === true)
        && linkB.status === 200 && (linkB.body.photos as Json[]).map((p) => p.id).join() === b1.id && linkOthers.sup === 200
        && linkOthers.cg === 403 && linkOthers.fam === 403 && [403, 404].includes(linkOthers.bOnA),
      `A=${linkIds.length} B=${(linkB.body.photos as Json[] ?? []).length} ${JSON.stringify(linkOthers)}`);

    // Next day: a new notice with the current count (one of A's reviews is done meanwhile).
    await legal(A.admin, a3.id, { action: "REVIEW", basis: `${basis} (revisado)`, reviewAt: inDays(60) });
    await q(`UPDATE notifications SET notice_day = notice_day - 1 WHERE notification_type='${NOTICE}'`);
    const nextDay = await runLegalReviewNotice();
    const today = await notices(`n.notice_day = (now() AT TIME ZONE 'America/Puerto_Rico')::date`);
    const todayA = today.filter((r) => r.organization_id === orgA);
    check("N8 daily: the next day a new notice is created (one per administrator) with the CURRENT count (A: 1 after a review was done); yesterday's stays as it was",
      nextDay === 4 && todayA.length === 2 && todayA.every((r) => r.item_count === 1) && (await notices()).length === 8, `created=${nextDay} todayA=${todayA.map((r) => r.item_count)}`);

    // Nothing overdue → nothing more.
    await legal(A.admin, a2.id, { action: "REVIEW", basis: `${basis} (revisado)`, reviewAt: inDays(60) });
    await legal(B.admin, b1.id, { action: "REVIEW", basis: `${basis} (revisado)`, reviewAt: inDays(60) });
    await q(`UPDATE notifications SET notice_day = notice_day - 1 WHERE notification_type='${NOTICE}'`);
    const none = await runLegalReviewNotice();
    check("N9 when every review of A and B is up to date they get nothing; agency C (switch off, review still overdue) keeps getting its daily notice (145 §5)",
      none === 1 && (await notices(`n.organization_id = $1`, [orgC])).length === 3, `created=${none}`);

    const noticeLines = logged.filter((l) => l.includes("PHOTO_LEGAL_HOLD_NOTICE"));
    const leak = noticeLines.some((l) => [orgA, orgB, a2.id, a3.id, b1.id, reference, A.admin.email].some((x) => l.includes(x)));
    check("N10 the log carries only how many notices were created (no agency, user, photo or reference)",
      noticeLines.length >= 2 && !leak && noticeLines.every((l) => /^PHOTO_LEGAL_HOLD_NOTICE \{"created":\d+\}$/.test(l)), noticeLines.join(" | "));

    const badShape = await q(`INSERT INTO notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, channel, status, item_count, notice_day)
      VALUES ($1,$2,'${NOTICE}','care_recipient',$3,'email','sent',1,current_date)`, [A.admin.userId, orgA, rA]).then(() => "ALLOWED", (e) => (e as Error).message);
    const strayCount = await q(`INSERT INTO notifications (user_id, organization_id, notification_type, channel, status, item_count) VALUES ($1,$2,'NEW_MESSAGE','in_app','sent',3)`,
      [A.admin.userId, orgA]).then(() => "ALLOWED", (e) => (e as Error).message);
    check("N11 the database itself refuses a malformed notice (e-mail channel, pointing to a resident) and a count on any other notification",
      /notifications_legal_review_shape/.test(badShape) && /notifications_legal_review_shape/.test(strayCount), `${badShape.slice(0, 60)} | ${strayCount.slice(0, 60)}`);

    // Rollback of 144, then applied again.
    const before = await q(`SELECT count(*) n FROM care_event_photos WHERE legal_hold_basis IS NOT NULL`);
    await q(readFileSync(new URL("../ops/144_activity_photos_legal_review_notice.rollback.sql", import.meta.url), "utf8"));
    const goneCols = Number((await q(`SELECT count(*) n FROM information_schema.columns WHERE table_name='notifications' AND column_name IN ('item_count','notice_day')`)).rows[0].n);
    const goneFn = Number((await q(`SELECT count(*) n FROM pg_proc WHERE proname='app_photo_legal_review_notify'`)).rows[0].n);
    const after = await q(`SELECT count(*) n FROM care_event_photos WHERE legal_hold_basis IS NOT NULL`);
    await q(readFileSync(new URL("../migrations/144_activity_photos_legal_review_notice.sql", import.meta.url), "utf8"));
    await q(`INSERT INTO schema_migrations (filename) VALUES ('144_activity_photos_legal_review_notice.sql') ON CONFLICT DO NOTHING`);
    // 145 redefines the notice function (switch-off agencies): re-applied on top when this database has it.
    if ((await q(`SELECT 1 FROM schema_migrations WHERE filename = '145_activity_photos_hardening.sql'`)).rows.length > 0) {
      await q(readFileSync(new URL("../migrations/145_activity_photos_hardening.sql", import.meta.url), "utf8"));
    }
    const back = await rt("", "", `SELECT app_photo_legal_review_notify() AS n`);
    check("R1 the 144 rollback removes the notice (function, index, columns, its reminders) and leaves the legal holds untouched; applied again it works",
      goneCols === 0 && goneFn === 0 && before.rows[0].n === after.rows[0].n && back.error === null, `cols=${goneCols} fn=${goneFn} holds=${before.rows[0].n}->${after.rows[0].n} again=${back.error ?? "ok"}`);
  } finally {
    console.error = origError; console.log = origLog;
    server.close();
    await pool.end().catch(() => undefined);
    await runtime.end().catch(() => undefined);
    await db.end();
    moto.kill();
  }

  console.log("\nActivity photos v2 · D1 caregiver removal window · D2 daily legal-review notice (144)\n");
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nActivity photo legal notice: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error("Activity photo legal notice verification failed:", error);
  process.exit(1);
});
