/**
 * SmartMatch Gate 3: complete flow for TWO independent agencies, run
 * concurrently, over real HTTP with the server connected as app_runtime.
 *
 * Each agency: admin 1 creates a draft -> admin 2 publishes it -> caregivers
 * discover it -> apply / withdraw / re-apply -> admin reviews live checks ->
 * approves one (opportunity FILLED, others closed) and rejects on a second
 * opportunity. Every step is also attacked from the other agency, and by
 * family / supervisor / platform users. No real assignment may be created.
 *
 * Synthetic data only, unique per run. Disposable databases only:
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

type Json = Record<string, unknown>;
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

  type Person = { email: string; userId: string; token: string };
  async function person(key: string, orgId: string, roles: string[], worker: boolean): Promise<Person> {
    const email = `sm3-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId]);
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m.rows[0].id, orgId, roles]);
    if (worker) {
      const w = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Synthetic ${key}`])).rows[0].id;
      const owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [w, orgId])).rows[0].id;
      const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date + 365)`, [w, bls]);
      await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [owm, orgId]);
      for (let d = 0; d < 7; d++) {
        await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,'06:00','22:00')`, [owm, orgId, d]);
      }
    }
    return { email, userId, token: "" };
  }

  async function agency(letter: string) {
    const orgId = (await q<{ id: string }>(`WITH o AS (INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id), f AS (INSERT INTO organization_features (organization_id,feature_code,enabled) SELECT o.id, c, true FROM o, unnest(ARRAY['SMARTMATCH','EN_CAMINO']) c) SELECT id FROM o`, [`SM Gate3 ${letter} ${tag}`])).rows[0].id;
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,$2) RETURNING id`, [orgId, `SM Gate3 ${letter} ${tag}`])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) SELECT $1,id,true,false FROM credential_types WHERE code='BLS'`, [rs]);
    return {
      letter, orgId,
      admin1: await person(`${letter}-admin1`, orgId, ["ORGANIZATION_ADMIN"], false),
      admin2: await person(`${letter}-admin2`, orgId, ["ORGANIZATION_ADMIN"], false),
      supervisor: await person(`${letter}-supervisor`, orgId, ["SUPERVISOR"], false),
      family: await person(`${letter}-family`, orgId, ["FAMILY"], false),
      cg1: await person(`${letter}-cg1`, orgId, ["WORKER"], true),
      cg2: await person(`${letter}-cg2`, orgId, ["WORKER"], true),
    };
  }
  const A = await agency("A");
  const B = await agency("B");
  const platformUser = await person("platform", A.orgId, [], false);
  await q(`DELETE FROM user_roles WHERE organization_membership_id IN (SELECT id FROM organization_memberships WHERE user_id=$1)`, [platformUser.userId]);
  await q(`DELETE FROM organization_memberships WHERE user_id=$1`, [platformUser.userId]);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [platformUser.userId]);

  for (const ag of [A, B]) {
    for (const p of [ag.admin1, ag.admin2, ag.supervisor, ag.family, ag.cg1, ag.cg2]) {
      const r = await call("POST", "/auth/login", "", { email: p.email, password });
      if (r.status !== 200) throw new Error(`login ${p.email} failed ${r.status}`);
      p.token = r.body.token as string;
      await call("POST", "/me/active-organization", p.token, { organizationId: ag.orgId });
    }
  }
  const pl = await call("POST", "/auth/login", "", { email: platformUser.email, password });
  platformUser.token = (pl.body.token as string) ?? "";

  const assignmentsBefore = Number((await q<{ n: string }>(`SELECT count(*) n FROM assignments`)).rows[0].n);
  const consent = { consent: true, consentVersion: "smartmatch-consent-v1" };
  const day = (offset: number) => {
    // 10:00-14:00 Puerto Rico (UTC-4, no DST) on day +offset.
    const now = new Date(); const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset, 14, 0, 0));
    return { startsAt: d.toISOString(), endsAt: new Date(d.getTime() + 4 * 3600e3).toISOString() };
  };

  async function flow(X: typeof A, Y: typeof A) {
    const L = X.letter; const S = `/organizations/${X.orgId}/smartmatch`;
    // Draft by admin1, published by admin2 (any agency admin may publish).
    const draft = await call("POST", `${S}/opportunities`, X.admin1.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador", ...day(3) });
    check(`${L}1 admin creates draft`, draft.status === 201, `status=${draft.status}`);
    const oppId = (draft.body.opportunity as { id: string } | undefined)?.id;
    if (!oppId) return;
    const otherPublish = await call("POST", `/organizations/${Y.orgId}/smartmatch/opportunities/${oppId}/publish`, Y.admin1.token);
    check(`${L}2 other agency's admin cannot publish this draft`, otherPublish.status === 404 && (await q(`SELECT status FROM smartmatch_opportunities WHERE id=$1`, [oppId])).rows[0].status === "DRAFT", `status=${otherPublish.status}`);
    const forgedPublish = await call("POST", `${S}/opportunities/${oppId}/publish`, Y.admin1.token);
    check(`${L}3 other agency's admin with this agency in the URL denied`, forgedPublish.status === 403, `status=${forgedPublish.status}`);
    const cgPublish = await call("POST", `${S}/opportunities/${oppId}/publish`, X.cg1.token);
    check(`${L}4 caregiver cannot publish`, cgPublish.status === 403, `status=${cgPublish.status}`);
    const pub = await call("POST", `${S}/opportunities/${oppId}/publish`, X.admin2.token);
    check(`${L}5 a second admin (not the creator) publishes the draft`, pub.status === 200, `status=${pub.status}`);
    const pubAgain = await call("POST", `${S}/opportunities/${oppId}/publish`, X.admin1.token);
    check(`${L}6 publishing twice is rejected`, pubAgain.status === 404, `status=${pubAgain.status}`);

    // Discovery is per agency.
    const disc = await call("GET", `${S}/available-opportunities`, X.cg1.token);
    const ids = ((disc.body.opportunities ?? []) as { id: string }[]).map(o => o.id);
    check(`${L}7 caregiver discovers own agency's opportunity`, disc.status === 200 && ids.includes(oppId), `count=${ids.length}`);
    const discOther = await call("GET", `/organizations/${Y.orgId}/smartmatch/available-opportunities`, Y.cg1.token);
    check(`${L}8 other agency's caregivers never see it`, !((discOther.body.opportunities ?? []) as { id: string }[]).some(o => o.id === oppId), `status=${discOther.status}`);
    for (const [who, p] of [["family", X.family], ["supervisor", X.supervisor]] as const) {
      const r = await call("GET", `${S}/available-opportunities`, p.token);
      check(`${L}9 ${who} cannot browse opportunities`, r.status === 403, `status=${r.status}`);
    }

    // Applications, withdrawal, re-application.
    const a1 = await call("POST", `${S}/opportunities/${oppId}/applications`, X.cg1.token, consent);
    const app1 = (a1.body.application as { id: string })?.id;
    const wd = await call("POST", `${S}/applications/${app1}/withdraw`, X.cg1.token);
    const a1b = await call("POST", `${S}/opportunities/${oppId}/applications`, X.cg1.token, consent);
    const app1b = (a1b.body.application as { id: string })?.id;
    check(`${L}10 apply -> withdraw -> re-apply`, a1.status === 201 && wd.status === 200 && a1b.status === 201, `${a1.status},${wd.status},${a1b.status}`);
    const a2 = await call("POST", `${S}/opportunities/${oppId}/applications`, X.cg2.token, consent);
    const app2 = (a2.body.application as { id: string })?.id;
    check(`${L}11 second caregiver applies`, a2.status === 201, `status=${a2.status}`);
    const cross = await call("POST", `/organizations/${Y.orgId}/smartmatch/opportunities/${oppId}/applications`, Y.cg1.token, consent);
    check(`${L}12 other agency's caregiver cannot apply`, cross.status === 404, `status=${cross.status}`);
    const familyApply = await call("POST", `${S}/opportunities/${oppId}/applications`, X.family.token, consent);
    check(`${L}13 family member cannot apply`, familyApply.status === 403, `status=${familyApply.status}`);

    // Review: own agency only.
    const queue = await call("GET", `${S}/opportunities/${oppId}/review-queue`, X.admin1.token);
    const qStatuses = ((queue.body.applications ?? []) as { status: string }[]).map(a => a.status).sort().join(",");
    check(`${L}14 review queue shows full history of this opportunity`, queue.status === 200 && qStatuses === "PENDING,PENDING,WITHDRAWN", qStatuses);
    const review = await call("GET", `${S}/applications/${app1b}/review`, X.admin1.token);
    check(`${L}15 review shows approvable with live checks`, review.status === 200 && (review.body.checks as Json)?.approvable === true, `status=${review.status}`);
    for (const path of [`/applications/${app1b}/review`, `/applications/${app1b}/events`, `/opportunities/${oppId}/review-queue`]) {
      const r = await call("GET", `/organizations/${Y.orgId}/smartmatch${path}`, Y.admin1.token);
      const rows = (r.body.applications ?? []) as unknown[];
      check(`${L}16 other agency's admin gets nothing from ${path.split("/")[1]}/${path.split("/").pop()}`, r.status === 404 || (r.status === 200 && rows.length === 0), `status=${r.status} rows=${rows.length}`);
    }
    const crossDecide = await call("POST", `/organizations/${Y.orgId}/smartmatch/applications/${app1b}/decision`, Y.admin1.token, { decision: "REJECT" });
    check(`${L}17 other agency's admin cannot decide`, crossDecide.status === 404, `status=${crossDecide.status}`);
    const platformDecide = await call("POST", `${S}/applications/${app1b}/decision`, platformUser.token, { decision: "REJECT" });
    check(`${L}18 ETNARA platform admin cannot decide`, platformDecide.status === 403, `status=${platformDecide.status}`);

    // Approve.
    const ok = await call("POST", `${S}/applications/${app1b}/decision`, X.admin2.token, { decision: "APPROVE", confirm: true });
    const opp = (await q<{ status: string }>(`SELECT status FROM smartmatch_opportunities WHERE id=$1`, [oppId])).rows[0].status;
    check(`${L}19 approval -> opportunity FILLED`, ok.status === 200 && opp === "FILLED", `status=${ok.status} opp=${opp}`);
    const mine1 = await call("GET", `${S}/my-applications`, X.cg1.token);
    const mine2 = await call("GET", `${S}/my-applications`, X.cg2.token);
    const s1 = ((mine1.body.applications ?? []) as { id: string; status: string }[]).filter(a => [app1, app1b].includes(a.id)).map(a => a.status).sort().join(",");
    const s2 = ((mine2.body.applications ?? []) as { id: string; status: string; decision_reason: string }[]).find(a => a.id === app2);
    check(`${L}20 caregiver 1 sees APPROVED + WITHDRAWN history`, s1 === "APPROVED,WITHDRAWN", s1);
    check(`${L}21 caregiver 2 sees REJECTED (OPPORTUNITY_FILLED)`, s2?.status === "REJECTED" && s2?.decision_reason === "OPPORTUNITY_FILLED", JSON.stringify(s2 ?? null));

    // History privacy.
    const ev = await call("GET", `${S}/applications/${app1b}/events`, X.admin1.token);
    const evs = (ev.body.events ?? []) as Json[];
    check(`${L}22 history has SUBMITTED + APPROVED signed by the approving admin`,
      evs.map(e => e.event_type).join(",") === "SUBMITTED,APPROVED" && evs[1]?.actor_user_id === X.admin2.userId, evs.map(e => e.event_type).join(","));
    for (const [who, p] of [["caregiver", X.cg1], ["family", X.family], ["supervisor", X.supervisor]] as const) {
      const r = await call("GET", `${S}/applications/${app1b}/events`, p.token);
      check(`${L}23 ${who} cannot read the agency decision history`, r.status === 403, `status=${r.status}`);
    }
    const leaks = JSON.stringify(evs).match(/patient|diagnos|address|first_name|last_name|email/i);
    check(`${L}24 history carries no patient or contact data`, !leaks, leaks?.[0] ?? "");

    // Reject path on a second opportunity.
    const d2 = await call("POST", `${S}/opportunities`, X.admin2.token, { visibility: "INTERNAL", regionLabel: "Cayey", roleLabel: "Cuidador", ...day(4) });
    const opp2 = (d2.body.opportunity as { id: string } | undefined)?.id;
    if (!opp2) { check(`${L}25 second draft created`, false, `status=${d2.status}`); return; }
    await call("POST", `${S}/opportunities/${opp2}/publish`, X.admin1.token);
    const r1 = await call("POST", `${S}/opportunities/${opp2}/applications`, X.cg2.token, consent);
    const rApp = (r1.body.application as { id: string } | undefined)?.id;
    check(`${L}25a second opportunity published by the other admin and applied to`, r1.status === 201, `status=${r1.status}`);
    if (!rApp) return;
    const rej = await call("POST", `${S}/applications/${rApp}/decision`, X.admin1.token, { decision: "REJECT" });
    const opp2Status = (await q<{ status: string }>(`SELECT status FROM smartmatch_opportunities WHERE id=$1`, [opp2])).rows[0].status;
    check(`${L}25b rejection keeps the opportunity PUBLISHED`, rej.status === 200 && opp2Status === "PUBLISHED", `status=${rej.status} opp=${opp2Status}`);
  }

  try {
    // Both agencies run their complete flows at the same time.
    // A crash inside one flow is recorded as a failure, never hidden.
    const guarded = (X: typeof A, Y: typeof A) => flow(X, Y).catch((e: Error) =>
      check(`${X.letter}! flow aborted`, false, e.message));
    await Promise.all([guarded(A, B), guarded(B, A)]);
    const assignmentsAfter = Number((await q<{ n: string }>(`SELECT count(*) n FROM assignments`)).rows[0].n);
    check("Z1 no real assignment created by any SmartMatch operation", assignmentsAfter === assignmentsBefore, `before=${assignmentsBefore} after=${assignmentsAfter}`);
    const crossRows = await q(`SELECT 1 FROM smartmatch_applications a JOIN smartmatch_opportunities o ON o.id=a.opportunity_id WHERE a.organization_id <> o.organization_id`);
    check("Z2 no application ever crosses agencies", crossRows.rowCount === 0, `rows=${crossRows.rowCount}`);
    const crossEvents = await q(`SELECT 1 FROM smartmatch_application_events e JOIN smartmatch_applications a ON a.id=e.application_id WHERE e.organization_id <> a.organization_id`);
    check("Z3 no history row ever crosses agencies", crossEvents.rowCount === 0, `rows=${crossEvents.rowCount}`);
    const network = await q(`SELECT 1 FROM smartmatch_opportunities WHERE visibility <> 'INTERNAL'`);
    check("Z4 no NETWORK opportunity exists", network.rowCount === 0, `rows=${network.rowCount}`);
  } finally {
    server.close();
    await pool.end();
    await db.end();
  }

  const width = Math.max(...results.map(r => r.name.length));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter(r => !r.pass).length;
  console.log(`\nSmartMatch two-agency flow: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
