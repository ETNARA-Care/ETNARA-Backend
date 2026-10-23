/**
 * SmartMatch pilot switches (migration 108). Agency A starts with nothing
 * enabled, ETNARA central enables it over HTTP, agency B is never enabled.
 * Proves: routes answer 404 FEATURE_NOT_ENABLED while off, /me exposes the
 * codes, only ETNARA central can switch (reason required, audited), the DB
 * refuses new rows for a disabled agency and the jobs skip it. Synthetic data.
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
    (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgA = await org(`OF A ${tag}`);
  const orgB = await org(`OF B ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  for (const o of [orgA, orgB]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'OF') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  }
  type P = { email: string; userId: string; token: string; workerId?: string; membershipId?: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `of-${key}-${tag}@example.invalid`;
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
  const notices = async (p: P, type: string) => ((await call("GET", "/me/notifications?limit=100", p.token)).body.items ?? [] as Json[]).filter((n: Json) => n.type === type);
  const at = (minutesFromNow: number) => { const d = new Date(Date.now() + minutesFromNow * 60_000); d.setUTCSeconds(0, 0); return d.toISOString(); };
  /** Shift via the Turnos API, assigned to `p`; responds with `decision` unless "pending". */
  async function shift(p: P, startMin: number, durationMin: number, o = orgA, admin = A.admin, rec = rA) {
    const s = await call("POST", `/organizations/${o}/shifts`, admin.token, { careRecipientId: rec, scheduledStart: at(startMin), scheduledEnd: at(startMin + durationMin) });
    const id = s.body.shift?.id as string;
    if (!id) throw new Error(`shift create ${s.status} ${JSON.stringify(s.body)}`);
    const asg = await call("POST", `/organizations/${o}/shifts/${id}/assignments`, admin.token, { organizationWorkerMembershipId: p.membershipId });
    if (asg.status !== 201) throw new Error(`assign ${asg.status} ${JSON.stringify(asg.body)}`);
    await call("POST", `/organizations/${o}/me/shifts/${id}/respond`, p.token, { decision: "accepted" });
    return id;
  }

  const features = async (p: P, o: string) => ((await call("GET", "/me", p.token)).body.organizations ?? []).find((x: Json) => x.id === o)?.features;
  /** Every gated surface for agency `o`, as seen by its admin and caregiver. */
  const surfaces = async (o: string, admin: P, cg: P, s: string) => {
    const r = [
      await call("GET", `/organizations/${o}/smartmatch/opportunities`, admin.token),
      await call("GET", `/organizations/${o}/smartmatch/available-opportunities`, cg.token),
      await call("GET", `/organizations/${o}/shifts/${s}/private-instructions`, admin.token),
      await call("GET", `/organizations/${o}/shifts/${s}/journey`, cg.token),
      await call("POST", `/organizations/${o}/shifts/${s}/journey/en-route`, cg.token, {}),
      await call("GET", `/organizations/${o}/operations/journeys`, admin.token),
      await call("GET", `/organizations/${o}/me/location-consent`, cg.token),
      await call("POST", `/organizations/${o}/shifts/${s}/arrival`, cg.token, {}),
    ];
    return r;
  };
  const off = (rs: { status: number; body: Json }[]) => rs.every((r) => r.status === 404 && r.body.error === "FEATURE_NOT_ENABLED");
  const feat = (o: string, code: string, enabled: boolean, token: string, reason = "Piloto SmartMatch") =>
    call("PUT", `/platform/organizations/${o}/features/${code}`, token, { enabled, reason });
  const lateNotices = async (o: string) =>
    Number((await q<{ n: string }>(`SELECT count(*) n FROM notifications n JOIN shifts s ON s.id = n.related_entity_id WHERE s.organization_id=$1 AND n.notification_type IN ('SHIFT_LATE_ARRIVAL','SHIFT_NOT_EN_ROUTE')`, [o])).rows[0].n);

  try {
    // ================================================================ default: off
    const sA = await shift(A.cg1, 20, 120);
    const sB = await shift(B.cg, 20, 120, orgB, B.admin, rB);
    check("D1 by default every agency has no pilot feature in /me", JSON.stringify(await features(A.admin, orgA)) === "[]" && JSON.stringify(await features(B.cg, orgB)) === "[]");
    const beforeA = await surfaces(orgA, A.admin, A.cg1, sA);
    check("D2 while off, SmartMatch, «En camino», «Llegué» and private instructions answer 404 FEATURE_NOT_ENABLED", off(beforeA), beforeA.map((r) => r.status).join(","));
    const anon = await fetch(`${base}/organizations/${orgA}/smartmatch/opportunities`);
    check("D3 anonymous callers still get 401 (the pilot list is not revealed)", anon.status === 401, `${anon.status}`);
    const turnos = await call("GET", `/organizations/${orgA}/shifts`, A.admin.token);
    const famShifts = await call("GET", `/organizations/${orgA}/care-recipients/${rA}/family-shifts`, A.family.token);
    const famShift = (famShifts.body.shifts ?? []).find((s: Json) => s.id === sA);
    check("D4 core flows (Turnos, family view) keep working; the family view carries no journey while off",
      turnos.status === 200 && famShifts.status === 200 && famShift && famShift.journey === null, `${turnos.status},${famShifts.status},${famShift?.journey}`);

    // ================================================================ database barrier
    const dbErr = async (text: string, params: unknown[]) => { try { await q(text, params); return "inserted"; } catch (e) { return (e as Error).message; } };
    const oppErr = await dbErr(`INSERT INTO smartmatch_opportunities (organization_id) VALUES ($1)`, [orgB]);
    const jErr = await dbErr(`INSERT INTO shift_journey_events (shift_id, organization_id) VALUES ($1,$2)`, [sB, orgB]);
    const arrErr = await dbErr(`INSERT INTO shift_arrivals (shift_id, organization_id) VALUES ($1,$2)`, [sB, orgB]);
    check("B1 the database refuses SmartMatch opportunities, journey events and arrivals for a disabled agency (even as owner)",
      [oppErr, jErr, arrErr].every((m) => m === "FEATURE_NOT_ENABLED"), `${oppErr} | ${jErr} | ${arrErr}`);

    // ================================================================ who may switch
    const byAdmin = await feat(orgA, "SMARTMATCH", true, A.admin.token);
    const byRuntime = await (async () => { try { return (await asRuntime(A.admin.userId, orgA,
      `INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'SMARTMATCH',true) RETURNING 1`, [orgA])).length; } catch { return -1; } })();
    check("S1 agency admins cannot enable their own agency (HTTP 403, DB refused)", byAdmin.status === 403 && byRuntime === -1, `${byAdmin.status},${byRuntime}`);
    const noReason = await call("PUT", `/platform/organizations/${orgA}/features/SMARTMATCH`, A.platform.token, { enabled: true });
    const badCode = await feat(orgA, "TRACKING", true, A.platform.token);
    check("S2 a reason and a known feature code are required (400)", noReason.status === 400 && badCode.status === 400, `${noReason.status},${badCode.status}`);

    // ================================================================ pilot enabled by ETNARA central
    const on1 = await feat(orgA, "SMARTMATCH", true, A.platform.token);
    const on2 = await feat(orgA, "EN_CAMINO", true, A.platform.token);
    const again = await feat(orgA, "EN_CAMINO", true, A.platform.token);
    check("E1 ETNARA central enables the pilot agency", on1.status === 200 && on2.status === 200 && again.body.feature?.changed === false, `${on1.status},${on2.status},${again.body.feature?.changed}`);
    const fA = await features(A.cg1, orgA);
    check("E2 /me now lists SMARTMATCH and EN_CAMINO for the pilot only", JSON.stringify(fA) === JSON.stringify(["EN_CAMINO", "SMARTMATCH"]) && JSON.stringify(await features(B.admin, orgB)) === "[]", JSON.stringify(fA));
    const opps = await call("GET", `/organizations/${orgA}/smartmatch/opportunities`, A.admin.token);
    const journey = await call("GET", `/organizations/${orgA}/shifts/${sA}/journey`, A.cg1.token);
    const enRoute = await call("POST", `/organizations/${orgA}/shifts/${sA}/journey/en-route`, A.cg1.token, {});
    const famAfter = ((await call("GET", `/organizations/${orgA}/care-recipients/${rA}/family-shifts`, A.family.token)).body.shifts ?? []).find((s: Json) => s.id === sA);
    check("E3 pilot routes work and the family sees the journey", opps.status === 200 && journey.status === 200 && enRoute.status === 201 && famAfter?.journey?.state === "EN_ROUTE",
      `${opps.status},${journey.status},${enRoute.status},${famAfter?.journey?.state}`);
    const afterB = await surfaces(orgB, B.admin, B.cg, sB);
    check("E4 the other agency still gets 404 everywhere", off(afterB), afterB.map((r) => r.status).join(","));
    const hist = await call("GET", `/platform/organizations/${orgA}/features`, A.platform.token);
    const histAdmin = await call("GET", `/platform/organizations/${orgA}/features`, A.admin.token);
    check("E5 every change is in the history (actor, reason); only ETNARA central reads it",
      hist.status === 200 && hist.body.history?.length === 2 && hist.body.history.every((h: Json) => h.reason === "Piloto SmartMatch" && h.actorEmail === A.platform.email) && histAdmin.status === 403,
      `${hist.status},${hist.body.history?.length},${histAdmin.status}`);
    let appendOnly = false;
    try { await q(`UPDATE organization_feature_events SET reason='x' WHERE organization_id=$1`, [orgA]); } catch { appendOnly = true; }
    check("E6 the history is append-only (even as owner)", appendOnly);

    // ================================================================ jobs
    const lateA = await shift(A.cg2, 60, 120);
    const lateB = await shift(B.cg, 300, 120, orgB, B.admin, rB);
    await q(`UPDATE shifts SET scheduled_start = now() - interval '20 minutes' WHERE id = ANY($1)`, [[lateA, lateB]]);
    await q(`SELECT app_notify_late_shift_arrivals()`);
    const soonA = await shift(A.cg3, 20, 60);
    const soonB = await shift(B.cg, 20 + 600, 60, orgB, B.admin, rB);
    await q(`UPDATE shifts SET scheduled_start = now() + interval '20 minutes' WHERE id = $1`, [soonB]);
    await q(`SELECT app_notify_shifts_not_en_route()`);
    const nA = await lateNotices(orgA); const nB = await lateNotices(orgB);
    check("J1 late-arrival and «no ha salido» notices only for the pilot agency", nA >= 2 && nB === 0, `A=${nA} B=${nB} (${soonA.slice(0, 4)})`);

    // ================================================================ switching off again
    const offA = await feat(orgA, "EN_CAMINO", false, A.platform.token, "Fin de prueba");
    const after = await call("GET", `/organizations/${orgA}/operations/journeys`, A.admin.token);
    const famOff = ((await call("GET", `/organizations/${orgA}/care-recipients/${rA}/family-shifts`, A.family.token)).body.shifts ?? []).find((s: Json) => s.id === sA);
    const stillSm = await call("GET", `/organizations/${orgA}/smartmatch/opportunities`, A.admin.token);
    check("O1 switching one feature off hides it at once (and only it); history kept",
      offA.status === 200 && after.status === 404 && famOff?.journey === null && stillSm.status === 200, `${offA.status},${after.status},${famOff?.journey},${stillSm.status}`);
  } finally {
    await runtime.end();
    server.close();
    await pool.end();
    await db.end();
  }

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nSmartMatch pilot switches: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
