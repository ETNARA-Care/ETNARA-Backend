/**
 * SmartMatch: cancel a PUBLISHED opportunity and automatic expiry (migration
 * 109). Proves authorization, mandatory reason, closure of pending
 * applications (CLOSED, never REJECTED), one notification per applicant,
 * append-only opportunity history, idempotent background job, and race
 * safety against concurrent submissions and decisions. Synthetic data only.
 *
 * Disposable databases only:
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
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
  const { notifyShiftsNotEnRoute } = await import("../src/modules/verification/verification.journey.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);

  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
  }
  const org = async (name: string) =>
    (await q<{ id: string }>(`WITH o AS (INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id), f AS (INSERT INTO organization_features (organization_id,feature_code,enabled) SELECT o.id, c, true FROM o, unnest(ARRAY['SMARTMATCH','EN_CAMINO']) c) SELECT id FROM o`, [name])).rows[0].id;
  const orgA = await org(`SX A ${tag}`);
  const orgB = await org(`SX B ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  for (const o of [orgA, orgB]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'SX') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  }
  type P = { email: string; userId: string; token: string; workerId?: string; membershipId?: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `sx-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    if (roles.length) {
      const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
      await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    }
    let workerId: string | undefined; let membershipId: string | undefined;
    if (worker) {
      workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Cuidadora ${key}`])).rows[0].id;
      membershipId = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
      await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [membershipId, orgId]);
      for (let d = 0; d < 7; d++) await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,'00:00','23:59')`, [membershipId, orgId, d]);
    }
    return { email, userId, token: "", workerId, membershipId };
  }
  const A = {
    admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]),
    admin2: await person("a-admin2", orgA, ["ORGANIZATION_ADMIN"]),
    supervisor: await person("a-sup", orgA, ["SUPERVISOR"]),
    cg1: await person("a-cg1", orgA, ["WORKER"], true),
    cg2: await person("a-cg2", orgA, ["WORKER"], true),
    cg3: await person("a-cg3", orgA, ["WORKER"], true),
    cg4: await person("a-cg4", orgA, ["WORKER"], true),
    cg5: await person("a-cg5", orgA, ["WORKER"], true),
    family: await person("a-family", orgA, ["FAMILY"]),
    familyMuted: await person("a-family-muted", orgA, ["FAMILY"]),
    familyRevoked: await person("a-family-revoked", orgA, ["FAMILY"]),
    platform: await person("platform", orgA, []),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]), family: await person("b-family", orgB, ["FAMILY"]),
    cg: await person("b-cg", orgB, ["WORKER"], true) };
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [A.platform.userId]);
  const recipient = async (o: string, last: string) =>
    (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Sintetico',$2) RETURNING id`, [o, `${last}-${tag}`])).rows[0].id;
  const rA = await recipient(orgA, "Casa");
  const rB = await recipient(orgB, "B");
  await q(`INSERT INTO care_recipient_locations (care_recipient_id,organization_id,address_line,municipality,is_primary) VALUES ($1,$2,'Calle Luna 12','Caguas',true)`, [rA, orgA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [A.family.userId, orgA, rA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_receive_notifications) VALUES ($1,$2,$3,'hijo','active',false)`, [A.familyMuted.userId, orgA, rA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,revoked_at) VALUES ($1,$2,$3,'nieto','revoked',now())`, [A.familyRevoked.userId, orgA, rA]);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [B.family.userId, orgB, rB]);

  for (const [p, o] of [...Object.values(A).map((p) => [p, orgA] as const), ...Object.values(B).map((p) => [p, orgB] as const)]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${p.email} ${r.status}`);
    p.token = r.body.token;
    if (p !== A.platform) await call("POST", "/me/active-organization", p.token, { organizationId: o });
  }
  const runtime = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await runtime.connect();
  async function asRuntime<T extends pg.QueryResultRow>(userId: string, orgId: string, text: string, params: unknown[] = [], superadmin = false) {
    await runtime.query("BEGIN");
    try {
      await runtime.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`, [userId, orgId, superadmin ? "true" : "false"]);
      return (await runtime.query<T>(text, params)).rows;
    } finally { await runtime.query("ROLLBACK"); }
  }
  const tryRuntime = async (userId: string, orgId: string, text: string, params: unknown[] = []) => {
    try { await asRuntime(userId, orgId, text, params); return null; } catch (e) { return e as Error; }
  };
  const notices = async (p: P, type: string) => ((await call("GET", "/me/notifications?limit=100", p.token)).body.items ?? [] as Json[]).filter((n: Json) => n.type === type);
  const at = (minutesFromNow: number) => { const d = new Date(Date.now() + minutesFromNow * 60_000); d.setUTCSeconds(0, 0); return d.toISOString(); };
  const S = `/organizations/${orgA}/smartmatch`;
  const consent = { consent: true, consentVersion: "smartmatch-consent-v1" };
  let dayOffset = 5;
  /** Draft by admin, published by admin2 (two-person rule), start days ahead. */
  async function published(publish = true) {
    const day = new Date(Date.now() + dayOffset++ * 86400e3); day.setUTCHours(14, 0, 0, 0);
    const d = await call("POST", `${S}/opportunities`, A.admin.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Acompañante",
      startsAt: day.toISOString(), endsAt: new Date(day.getTime() + 4 * 3600e3).toISOString() });
    const id = d.body.opportunity?.id as string;
    if (!id) throw new Error(`draft ${d.status} ${JSON.stringify(d.body)}`);
    if (publish) {
      const p = await call("POST", `${S}/opportunities/${id}/publish`, A.admin2.token, {});
      if (p.status !== 200) throw new Error(`publish ${p.status} ${JSON.stringify(p.body)}`);
    }
    return id;
  }
  const apply = (p: P, id: string) => call("POST", `${S}/opportunities/${id}/applications`, p.token, consent);
  const appRows = async (opp: string) => (await q<{ id: string; status: string; closed_reason: string | null; decided_by_user_id: string | null; caregiver_user_id: string }>(
    `SELECT id, status, closed_reason, decided_by_user_id, caregiver_user_id FROM smartmatch_applications WHERE opportunity_id=$1 ORDER BY created_at`, [opp])).rows;
  const noticeCount = async (appId: string, type: string) =>
    Number((await q<{ n: string }>(`SELECT count(*) n FROM notifications WHERE related_entity_id=$1 AND notification_type=$2`, [appId, type])).rows[0].n);
  const oppStatus = async (id: string) => (await q<{ status: string; expired_at: string | null }>(`SELECT status, expired_at FROM smartmatch_opportunities WHERE id=$1`, [id])).rows[0];
  const reason = { reason: "NO_LONGER_NEEDED", note: "Nota interna: la familia canceló el servicio" };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  try {
    // ================================================================ cancel a PUBLISHED opportunity
    const o1 = await published();
    const a1 = await apply(A.cg1, o1); const a2 = await apply(A.cg2, o1); const a3 = await apply(A.cg3, o1);
    await call("POST", `${S}/applications/${a3.body.id ?? a3.body.application?.id}/withdraw`, A.cg3.token, {});
    const appIds = (await appRows(o1)).map((r) => r.id);
    if (a1.status !== 201 || a2.status !== 201 || appIds.length !== 3) throw new Error(`setup apply ${a1.status} ${a2.status} ${appIds.length}`);
    const bySup = await call("POST", `${S}/opportunities/${o1}/cancel`, A.supervisor.token, reason);
    const byCg = await call("POST", `${S}/opportunities/${o1}/cancel`, A.cg1.token, reason);
    const byB = await call("POST", `/organizations/${orgB}/smartmatch/opportunities/${o1}/cancel`, B.admin.token, reason);
    check("C1 only an administrator of the same agency can cancel (supervisor/caregiver 403, other agency 404)",
      bySup.status === 403 && byCg.status === 403 && byB.status === 404, `${bySup.status},${byCg.status},${byB.status}`);
    const noReason = await call("POST", `${S}/opportunities/${o1}/cancel`, A.admin.token, {});
    const badReason = await call("POST", `${S}/opportunities/${o1}/cancel`, A.admin.token, { reason: "PORQUE_SI" });
    check("C2 the reason category is mandatory (400) and nothing changes without it",
      noReason.status === 400 && badReason.status === 400 && (await oppStatus(o1)).status === "PUBLISHED", `${noReason.status},${badReason.status}`);
    const cancel = await call("POST", `${S}/opportunities/${o1}/cancel`, A.admin.token, reason);
    const rows1 = await appRows(o1);
    check("C3 PUBLISHED -> CANCELLED; the 2 pending applications are CLOSED (not REJECTED, no decider); the withdrawn one untouched",
      cancel.status === 200 && cancel.body.previousStatus === "PUBLISHED" && cancel.body.closedApplications === 2
      && rows1.filter((r) => r.status === "CLOSED" && r.closed_reason === "OPPORTUNITY_CANCELLED" && r.decided_by_user_id === null).length === 2
      && rows1.filter((r) => r.status === "WITHDRAWN").length === 1,
      `${cancel.status} ${cancel.body.closedApplications} ${rows1.map((r) => r.status).join(",")}`);
    const closedIds = rows1.filter((r) => r.status === "CLOSED").map((r) => r.id);
    const withdrawnId = rows1.find((r) => r.status === "WITHDRAWN")!.id;
    const n1 = await Promise.all(closedIds.map((id) => noticeCount(id, "SMARTMATCH_APPLICATION_OPPORTUNITY_CANCELLED")));
    const nW = await noticeCount(withdrawnId, "SMARTMATCH_APPLICATION_OPPORTUNITY_CANCELLED");
    const unreadAdmin = Number((await q<{ n: string }>(`SELECT count(*) n FROM notifications WHERE related_entity_id = ANY($1) AND notification_type='SMARTMATCH_APPLICATION_SUBMITTED' AND read_at IS NULL`, [closedIds])).rows[0].n);
    check("C4 each pending applicant gets exactly one notice; the withdrawn one none; the admins' «nueva solicitud» notices are resolved",
      n1.every((n) => n === 1) && nW === 0 && unreadAdmin === 0, `${n1.join(",")} w=${nW} unread=${unreadAdmin}`);
    const bell = (await call("GET", "/me/notifications?limit=50", A.cg1.token)).body.items ?? [];
    const mine = (await call("GET", `${S}/my-applications`, A.cg1.token)).body;
    const mineRow = (mine.applications ?? mine ?? []).find?.((r: Json) => r.opportunity_id === o1);
    check("C5 the caregiver sees «La agencia canceló una oportunidad a la que te postulaste» and CLOSED with the category only (no internal note)",
      bell.some((n: Json) => n.type === "SMARTMATCH_APPLICATION_OPPORTUNITY_CANCELLED" && /canceló una oportunidad a la que te postulaste/.test(n.summary ?? n.title ?? JSON.stringify(n)))
      && mineRow?.status === "CLOSED" && mineRow?.closed_reason === "OPPORTUNITY_CANCELLED" && mineRow?.opportunity_cancellation_reason === "NO_LONGER_NEEDED"
      && !JSON.stringify(mine).includes("Nota interna") && !JSON.stringify(bell).includes("Nota interna"),
      `${mineRow?.status} ${mineRow?.closed_reason} ${mineRow?.opportunity_cancellation_reason}`);
    const again = await call("POST", `${S}/opportunities/${o1}/cancel`, A.admin.token, reason);
    const late = await apply(A.cg4, o1);
    check("C6 cancelling twice is refused (409) and nobody can apply to a cancelled opportunity",
      again.status === 409 && [404, 409].includes(late.status) && (await appRows(o1)).length === 3, `${again.status},${late.status}`);
    const hist = await call("GET", `${S}/opportunities/${o1}/history`, A.admin2.token);
    const h = hist.body.history ?? [];
    const cEv = h.find((e: Json) => e.eventType === "CANCELLED");
    check("C7 auditable history: CREATED -> PUBLISHED -> CANCELLED with who, reason category and 2 closed applications",
      hist.status === 200 && h.map((e: Json) => e.eventType).join(",") === "CREATED,PUBLISHED,CANCELLED"
      && cEv?.actorName && cEv?.automatic === false && cEv?.reason === "NO_LONGER_NEEDED" && cEv?.closedApplications === 2 && !JSON.stringify(h).includes("Nota interna"),
      `${hist.status} ${h.map((e: Json) => e.eventType).join(",")} ${cEv?.closedApplications}`);
    const histCg = await call("GET", `${S}/opportunities/${o1}/history`, A.cg1.token);
    const histSup = await call("GET", `${S}/opportunities/${o1}/history`, A.supervisor.token);
    const histB = await call("GET", `/organizations/${orgB}/smartmatch/opportunities/${o1}/history`, B.admin.token);
    const histTower = await asRuntime(A.platform.userId, orgA, `SELECT id FROM smartmatch_opportunity_events`, [], true);
    check("C8 only administrators of the agency read the history (caregiver/supervisor 403, other agency 404, Tower nothing)",
      histCg.status === 403 && histSup.status === 403 && histB.status === 404 && histTower.length === 0, `${histCg.status},${histSup.status},${histB.status},${histTower.length}`);
    let evImmutable = false;
    try { await q(`UPDATE smartmatch_opportunity_events SET reason='OTHER' WHERE opportunity_id=$1`, [o1]); } catch { evImmutable = true; }
    let cancelImmutable = false;
    try { await q(`UPDATE smartmatch_opportunities SET cancellation_reason='OTHER' WHERE id=$1`, [o1]); } catch { cancelImmutable = true; }
    check("C9 history and cancellation data are immutable (even for the owner role)", evImmutable && cancelImmutable);

    // ================================================================ automatic expiry
    const o2 = await published();
    await apply(A.cg1, o2); await apply(A.cg2, o2);
    const draft = await published(false);
    await q(`UPDATE smartmatch_opportunities SET expires_at = now() WHERE id = ANY($1)`, [[o2, draft]]);
    let jobErr = "";
    try { await asRuntime(A.admin.userId, orgA, `SELECT app_smartmatch_expire_opportunities()`); } catch (e) { jobErr = (e as Error).message; }
    check("E1 the expiry job refuses a user session (background worker only)", jobErr === "BACKGROUND_JOB_ONLY", jobErr);
    const { expireSmartMatchOpportunities } = await import("../src/modules/verification/verification.arrival.js");
    const ran = await expireSmartMatchOpportunities();
    const s2 = await oppStatus(o2);
    const rows2 = await appRows(o2);
    check("E2 an opportunity past its time becomes EXPIRED and its pending applications CLOSED (OPPORTUNITY_EXPIRED); a draft is not touched",
      ran >= 1 && s2.status === "EXPIRED" && s2.expired_at !== null && rows2.every((r) => r.status === "CLOSED" && r.closed_reason === "OPPORTUNITY_EXPIRED")
      && (await oppStatus(draft)).status === "DRAFT", `ran=${ran} ${s2.status} ${rows2.map((r) => r.status).join(",")}`);
    const ran2 = await expireSmartMatchOpportunities();
    await expireSmartMatchOpportunities();
    const n2 = await Promise.all(rows2.map((r) => noticeCount(r.id, "SMARTMATCH_APPLICATION_OPPORTUNITY_EXPIRED")));
    const h2 = (await call("GET", `${S}/opportunities/${o2}/history`, A.admin.token)).body.history ?? [];
    const eEv = h2.filter((e: Json) => e.eventType === "EXPIRED");
    check("E3 running the job again changes nothing: one notice per applicant, one EXPIRED history row (automatic, no actor)",
      ran2 === 0 && n2.every((n) => n === 1) && eEv.length === 1 && eEv[0].automatic === true && eEv[0].actorName === null && eEv[0].closedApplications === 2,
      `ran2=${ran2} ${n2.join(",")} ${eEv.length}`);

    // ================================================================ races
    // R1: a submission holding its FK lock (not yet committed) while the admin cancels.
    const o3 = await published();
    const c1 = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c1.connect();
    await c1.query("BEGIN");
    await c1.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin','false',true)`, [A.cg5.userId, orgA]);
    await c1.query(`INSERT INTO smartmatch_applications (opportunity_id, organization_id, caregiver_user_id, consented_at, consent_version) VALUES ($1,$2,$3,now(),'smartmatch-consent-v1')`, [o3, orgA, A.cg5.userId]);
    let settled = false;
    const pending = call("POST", `${S}/opportunities/${o3}/cancel`, A.admin.token, reason).then((r) => { settled = true; return r; });
    await sleep(700);
    const blocked = !settled;
    await c1.query("COMMIT"); await c1.end();
    const r1 = await pending;
    const rows3 = await appRows(o3);
    check("R1 submission in flight + cancel: the cancel waits for it and closes it too (no PENDING left on a cancelled opportunity)",
      blocked && r1.status === 200 && r1.body.closedApplications === 1 && rows3.length === 1 && rows3[0].status === "CLOSED",
      `blocked=${blocked} ${r1.status} ${r1.body.closedApplications} ${rows3.map((r) => r.status).join(",")}`);
    // R2: the cancel holds the lock first; a submission arriving meanwhile is refused at commit.
    const o4 = await published();
    const c2 = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c2.connect();
    await c2.query("BEGIN");
    await c2.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin','false',true)`, [A.admin.userId, orgA]);
    await c2.query(`UPDATE smartmatch_opportunities SET status='CANCELLED', cancellation_reason='OTHER', cancelled_at=now(), cancelled_by_user_id=$2, updated_at=now() WHERE id=$1`, [o4, A.admin.userId]);
    let settled2 = false;
    const pending2 = apply(A.cg5, o4).then((r) => { settled2 = true; return r; });
    await sleep(700);
    const blocked2 = !settled2;
    await c2.query("COMMIT"); await c2.end();
    const r2 = await pending2;
    check("R2 cancel first + submission meanwhile: the submission waits and is refused; nothing PENDING remains",
      blocked2 && [404, 409].includes(r2.status) && (await appRows(o4)).every((r) => r.status !== "PENDING"), `blocked=${blocked2} ${r2.status}`);
    // R3: an administrator is deciding (opportunity locked) when the expiry job runs.
    const o5 = await published();
    await apply(A.cg1, o5);
    await q(`UPDATE smartmatch_opportunities SET expires_at = now() WHERE id=$1`, [o5]);
    const c3 = new pg.Client({ connectionString: adminUrl }); await c3.connect();
    await c3.query("BEGIN"); await c3.query(`SELECT 1 FROM smartmatch_opportunities WHERE id=$1 FOR UPDATE`, [o5]);
    const t0 = Date.now();
    const skipped = await expireSmartMatchOpportunities();
    const tookMs = Date.now() - t0;
    const stillPublished = (await oppStatus(o5)).status === "PUBLISHED";
    await c3.query("ROLLBACK"); await c3.end();
    const after = await expireSmartMatchOpportunities();
    check("R3 the job never waits on an opportunity being decided (skips it, retries next minute)",
      skipped === 0 && tookMs < 3000 && stillPublished && after === 1 && (await oppStatus(o5)).status === "EXPIRED", `skipped=${skipped} ${tookMs}ms after=${after}`);
    // R4: FILLED is never expired; cancelling a FILLED one keeps its 107 rule.
    const o6 = await published();
    const ap6 = await apply(A.cg2, o6);
    const appId6 = (await appRows(o6))[0].id;
    const dec = await call("POST", `${S}/applications/${appId6}/decision`, A.admin.token, { decision: "APPROVE", confirm: true });
    await q(`UPDATE smartmatch_opportunities SET expires_at = now() WHERE id=$1`, [o6]);
    await expireSmartMatchOpportunities();
    check("R4 an approved (FILLED) opportunity is never expired", ap6.status === 201 && dec.status === 200 && (await oppStatus(o6)).status === "FILLED", `${ap6.status},${dec.status},${(await oppStatus(o6)).status}`);
  } finally {
    await runtime.end();
    server.close();
    await pool.end();
    await db.end();
  }

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nSmartMatch cancel + expiry: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
