/**
 * SmartMatch fixes (migrations 110-111): H1 schedule conflicts at approval
 * (race-safe), H2 overnight availability, H3 malformed JSON -> 400, H4 opportunity
 * limits, and password_reset_tokens reachable by app_runtime only.
 * Real HTTP with the server connected as app_runtime. Synthetic data only.
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

/** Puerto Rico is UTC-4 all year (no DST). */
const pr = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-04:00`);
/** Next calendar date (YYYY-MM-DD, Puerto Rico) with the given weekday, at least `minDays` ahead. */
function nextWeekday(dow: number, minDays = 2): string {
  const now = new Date(Date.now() - 4 * 3600e3);
  for (let i = minDays; i < minDays + 8; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i));
    if (d.getUTCDay() === dow) return d.toISOString().slice(0, 10);
  }
  throw new Error("unreachable");
}
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const { hashPassword } = await import("../src/security/password.js");
  const { generateSessionToken } = await import("../src/security/sessionToken.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  const serverErrors: string[] = [];

  async function call(method: string, path: string, token: string, body?: unknown, raw?: string) {
    const res = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
    if (res.status >= 500) serverErrors.push(`${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")} ${res.status}`);
    return { status: res.status, body: parsed, text };
  }

  const org = async (name: string) =>
    (await q<{ id: string }>(`WITH o AS (INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id), f AS (INSERT INTO organization_features (organization_id,feature_code,enabled) SELECT o.id, c, true FROM o, unnest(ARRAY['SMARTMATCH','EN_CAMINO']) c) SELECT id FROM o`, [name])).rows[0].id;
  const orgA = await org(`SM Fix A ${tag}`);
  const orgB = await org(`SM Fix B ${tag}`);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  for (const o of [orgA, orgB]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'FIX') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  }
  type P = { key: string; email: string; userId: string; token: string; owm?: string; orgId: string };
  /** windows: [weekday, start, end][]; omitted = 00:00-23:59 every day. */
  async function person(key: string, orgId: string, roles: string[], worker = false, windows?: [number, string, string][]): Promise<P> {
    const email = `smfix-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let owm: string | undefined;
    if (worker) {
      const wid = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Synthetic ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [wid, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [wid, bls]);
      await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [owm, orgId]);
      const ws = windows ?? [0, 1, 2, 3, 4, 5, 6].map((d) => [d, "00:00", "23:59"] as [number, string, string]);
      for (const [d, a, b] of ws) await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,$4,$5)`, [owm, orgId, d, a, b]);
    }
    return { key, email, userId, token: "", owm, orgId };
  }
  const A = {
    admin1: await person("admin1", orgA, ["ORGANIZATION_ADMIN"]),
    admin2: await person("admin2", orgA, ["ORGANIZATION_ADMIN"]),
    sup: await person("sup", orgA, ["SUPERVISOR"]),
    cg: await Promise.all(Array.from({ length: 6 }, (_, i) => person(`cg${i}`, orgA, ["WORKER"], true))),
    other: await person("other", orgA, ["WORKER"], true),
    night: await person("night", orgA, ["WORKER"], true, [0, 1, 2, 3, 4, 5, 6].map((d) => [d, "22:00", "06:00"] as [number, string, string])),
    sat: await person("sat", orgA, ["WORKER"], true, [[6, "22:00", "06:00"]]),
    chain: await person("chain", orgA, ["WORKER"], true, [[1, "18:00", "23:59"], [2, "00:00", "08:00"]]),
    morning: await person("morning", orgA, ["WORKER"], true, [0, 1, 2, 3, 4, 5, 6].map((d) => [d, "08:00", "12:00"] as [number, string, string])),
    api: await person("api", orgA, ["WORKER"], true, []),
  };
  const B = { admin: await person("badmin", orgB, ["ORGANIZATION_ADMIN"]) };
  const everyone = [A.admin1, A.admin2, A.sup, ...A.cg, A.other, A.night, A.sat, A.chain, A.morning, A.api, B.admin];
  for (const p of everyone) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${p.email} ${r.status}`);
    p.token = r.body.token;
    await call("POST", "/me/active-organization", p.token, { organizationId: p.orgId });
  }
  const S = `/organizations/${orgA}/smartmatch`;
  const consent = { consent: true, consentVersion: "smartmatch-consent-v1" };
  const rA = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Sintetico','Fix','active') RETURNING id`, [orgA])).rows[0].id;
  async function opportunity(start: Date, end: Date, token = A.admin1.token) {
    const d = await call("POST", `${S}/opportunities`, token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: start.toISOString(), endsAt: end.toISOString() });
    if (d.status !== 201) throw new Error(`create ${d.status} ${JSON.stringify(d.body)}`);
    const p = await call("POST", `${S}/opportunities/${d.body.opportunity.id}/publish`, token);
    if (p.status !== 200) throw new Error(`publish ${p.status}`);
    return d.body.opportunity.id as string;
  }
  const apply = async (oppId: string, cg: P) => {
    const r = await call("POST", `${S}/opportunities/${oppId}/applications`, cg.token, consent);
    if (r.status !== 201) throw new Error(`apply ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.application.id as string;
  };
  const approve = (appId: string, token = A.admin1.token) => call("POST", `${S}/applications/${appId}/decision`, token, { decision: "APPROVE", confirm: true });
  const appStatus = async (id: string) => (await q<{ status: string }>(`SELECT status FROM smartmatch_applications WHERE id=$1`, [id])).rows[0].status;
  const oppStatus = async (id: string) => (await q<{ status: string }>(`SELECT status FROM smartmatch_opportunities WHERE id=$1`, [id])).rows[0].status;
  async function regularShift(start: Date, end: Date) {
    const s = await call("POST", `/organizations/${orgA}/shifts`, A.admin1.token, { careRecipientId: rA, scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() });
    if (s.status !== 201) throw new Error(`shift ${s.status} ${JSON.stringify(s.body)}`);
    return s.body.shift.id as string;
  }
  const assign = (shiftId: string, cg: P, token = A.admin1.token) =>
    call("POST", `/organizations/${orgA}/shifts/${shiftId}/assignments`, token, { organizationWorkerMembershipId: cg.owm });

  try {
    // ================================================================ H1: schedule conflicts
    const d1 = nextWeekday(3, 3); // a Wednesday
    const cg0 = A.cg[0];
    const o1 = await opportunity(pr(d1, "09:00"), pr(d1, "13:00"));
    const o2 = await opportunity(pr(d1, "11:00"), pr(d1, "15:00"));
    const a1 = await apply(o1, cg0); const a2 = await apply(o2, cg0); const a2other = await apply(o2, A.other);
    const first = await approve(a1);
    const second = await approve(a2);
    check("H1.1 same caregiver: the second overlapping approval is blocked (noScheduleConflict=false)",
      first.status === 200 && second.status === 409 && second.body.error === "APPROVAL_BLOCKED" && second.body.checks?.noScheduleConflict === false,
      `first=${first.status} second=${second.status} ${second.body.error} noScheduleConflict=${second.body.checks?.noScheduleConflict}`);
    check("H1.2 nothing changed: opportunity still PUBLISHED, both applications on it still PENDING (other applicants not turned away)",
      (await oppStatus(o2)) === "PUBLISHED" && (await appStatus(a2)) === "PENDING" && (await appStatus(a2other)) === "PENDING");
    const rev = await call("GET", `${S}/applications/${a2}/review`, A.admin1.token);
    check("H1.3 review shows the conflict before the admin decides", rev.status === 200 && rev.body.checks?.noScheduleConflict === false && rev.body.checks?.approvable === false,
      `status=${rev.status} noScheduleConflict=${rev.body.checks?.noScheduleConflict}`);
    const alt = await approve(a2other);
    check("H1.4 another available caregiver can still be approved for that opportunity", alt.status === 200 && alt.body.outcome === "APPROVED", `status=${alt.status}`);

    const o3 = await opportunity(pr(d1, "13:00"), pr(d1, "17:00"));
    const a3 = await apply(o3, cg0);
    const adj = await approve(a3);
    check("H1.5 back-to-back visit (13:00 right after 09:00-13:00) is not a conflict", adj.status === 200, `status=${adj.status} ${adj.body.error ?? ""}`);

    // regular Turnos shift, pending assignment
    const d2 = addDays(d1, 1);
    const cg1 = A.cg[1];
    const sh = await regularShift(pr(d2, "09:00"), pr(d2, "13:00"));
    const as1 = await assign(sh, cg1);
    const o4 = await opportunity(pr(d2, "10:00"), pr(d2, "12:00"));
    const a4 = await apply(o4, cg1);
    const b4 = await approve(a4);
    check("H1.6 approval blocked while the caregiver has a regular shift (pending assignment) at that time",
      as1.status === 201 && b4.status === 409 && b4.body.checks?.noScheduleConflict === false, `assign=${as1.status} approve=${b4.status}`);
    // declined assignment does not block
    await q(`UPDATE assignments SET response_status='rejected', responded_at=now() WHERE shift_id=$1`, [sh]);
    const ok4 = await approve(a4);
    check("H1.7 a rejected (declined) assignment no longer blocks the approval", ok4.status === 200, `status=${ok4.status} ${ok4.body.error ?? ""}`);
    // cancelled shift does not block
    const cg2 = A.cg[2];
    const sh2 = await regularShift(pr(d2, "15:00"), pr(d2, "18:00"));
    await assign(sh2, cg2);
    await q(`UPDATE shifts SET status='cancelled' WHERE id=$1`, [sh2]);
    const o5 = await opportunity(pr(d2, "16:00"), pr(d2, "17:00"));
    const ok5 = await approve(await apply(o5, cg2));
    check("H1.8 a cancelled shift no longer blocks the approval", ok5.status === 200, `status=${ok5.status} ${ok5.body.error ?? ""}`);

    // approved SmartMatch commitment (no shift yet) blocks a Turnos assignment -- admin and supervisor
    const sh3 = await regularShift(pr(d1, "10:00"), pr(d1, "11:00")); // overlaps cg0's approved o1 (09-13)
    const byAdmin = await assign(sh3, cg0);
    const bySup = await assign(sh3, cg0, A.sup.token);
    check("H1.9 Turnos refuses to assign over an approved SmartMatch visit without shift (admin and supervisor)",
      byAdmin.status === 409 && byAdmin.body.error === "SCHEDULE_CONFLICT" && bySup.status === 409 && bySup.body.error === "SCHEDULE_CONFLICT",
      `admin=${byAdmin.status} ${byAdmin.body.error} supervisor=${bySup.status} ${bySup.body.error}`);
    const made = await call("POST", `${S}/opportunities/${o1}/shift`, A.admin1.token, { careRecipientId: rA });
    check("H1.10 creating the shift of that same approval still works (its own commitment is excluded)", made.status === 201, `status=${made.status} ${made.body.error ?? ""}`);
    const made3 = await call("POST", `${S}/opportunities/${o3}/shift`, A.admin1.token, { careRecipientId: rA });
    check("H1.11 the back-to-back visit also becomes a shift (no false conflict)", made3.status === 201, `status=${made3.status} ${made3.body.error ?? ""}`);

    // ---------------------------------------------------------------- H1 concurrency
    let approvalRace = 0; const approvalCodes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const day = addDays(d1, 7 + i);
      const cg = A.cg[3];
      const x = await opportunity(pr(day, "09:00"), pr(day, "13:00"));
      const y = await opportunity(pr(day, "12:00"), pr(day, "16:00"));
      const ax = await apply(x, cg); const ay = await apply(y, cg);
      const [rx, ry] = await Promise.all([approve(ax, A.admin1.token), approve(ay, A.admin2.token)]);
      approvalCodes.push(`${rx.status}/${ry.status}`);
      const approved = Number((await q<{ n: string }>(`SELECT count(*) n FROM smartmatch_applications WHERE id = ANY($1) AND status='APPROVED'`, [[ax, ay]])).rows[0].n);
      if (approved === 1 && [rx.status, ry.status].sort().join() === "200,409") approvalRace++;
    }
    check("H1.12 6 rounds: two admins approve the same caregiver for overlapping visits at the same instant -> exactly one approved each time",
      approvalRace === 6, approvalCodes.join(" "));

    let mixedRace = 0; const mixedCodes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const day = addDays(d1, 14 + i);
      const cg = A.cg[4];
      const s = await regularShift(pr(day, "09:00"), pr(day, "13:00"));
      const x = await opportunity(pr(day, "10:00"), pr(day, "14:00"));
      const ax = await apply(x, cg);
      const [ra, rb] = await Promise.all([approve(ax, A.admin1.token), assign(s, cg, A.admin2.token)]);
      mixedCodes.push(`${ra.status}/${rb.status}`);
      const approved = (await appStatus(ax)) === "APPROVED";
      const assigned = Number((await q<{ n: string }>(`SELECT count(*) n FROM assignments WHERE shift_id=$1 AND response_status IN ('pending','accepted')`, [s])).rows[0].n) === 1;
      if (approved !== assigned) mixedRace++;
    }
    check("H1.13 6 rounds: SmartMatch approval and Turnos assignment of the same caregiver at the same instant -> exactly one wins",
      mixedRace === 6, mixedCodes.join(" "));

    // ---------------------------------------------------------------- H1 isolation of the helper
    const fromB = await (async () => {
      const rt = new pg.Client({ connectionString: process.env.DATABASE_URL }); await rt.connect();
      try {
        await rt.query("BEGIN");
        await rt.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [B.admin.userId, orgB]);
        const r = await rt.query<{ busy: boolean }>(`SELECT app_smartmatch_worker_has_commitment($1, $2, $3, NULL) busy`, [cg0.owm, pr(d1, "00:00"), pr(d1, "23:00")]);
        await rt.query("ROLLBACK");
        return r.rows[0].busy;
      } finally { await rt.end(); }
    })();
    const publicExec = (await q<{ p: boolean; c: boolean }>(`SELECT has_function_privilege('public', 'app_smartmatch_worker_has_commitment(uuid,timestamptz,timestamptz,uuid)', 'EXECUTE') p,
      has_function_privilege('public', 'app_availability_covers(uuid,timestamptz,timestamptz)', 'EXECUTE') c`)).rows[0];
    check("H1.14 the commitment helper answers false for another agency's caregiver and is not executable by PUBLIC",
      fromB === false && !publicExec.p && !publicExec.c, `agencyB=${fromB} publicExec=${publicExec.p},${publicExec.c}`);

    // ================================================================ H2: overnight availability
    const sat = nextWeekday(6, 3);           // Saturday
    const sun = addDays(sat, 1);
    const night = async (start: Date, end: Date, cg: P) => {
      const o = await opportunity(start, end);
      const a = await apply(o, cg);
      const r = await call("GET", `${S}/applications/${a}/review`, A.admin1.token);
      return { o, a, covers: r.body.checks?.availabilityCovers as boolean };
    };
    const n1 = await night(pr(sat, "23:00"), pr(sun, "05:00"), A.night);
    const n1d = await approve(n1.a);
    check("H2.1 overnight window 22:00->06:00 covers a 23:00->05:00 visit and it can be approved", n1.covers === true && n1d.status === 200, `covers=${n1.covers} approve=${n1d.status}`);
    const n2 = await night(pr(addDays(sat, 7), "21:00"), pr(addDays(sun, 7), "05:00"), A.night);
    check("H2.2 visit starting before the window (21:00) is not covered", n2.covers === false, `covers=${n2.covers}`);
    const n3 = await night(pr(addDays(sat, 14), "23:00"), pr(addDays(sun, 14), "07:00"), A.night);
    check("H2.3 visit ending after the window (07:00) is not covered", n3.covers === false, `covers=${n3.covers}`);
    const n4 = await night(pr(addDays(sun, 21), "02:00"), pr(addDays(sun, 21), "05:00"), A.night);
    check("H2.4 early-morning visit (02:00-05:00) is covered by the previous day's overnight window", n4.covers === true, `covers=${n4.covers}`);
    const n5 = await night(pr(sun, "01:00"), pr(sun, "04:00"), A.sat);
    const n6 = await night(pr(sat, "01:00"), pr(sat, "04:00"), A.sat);
    check("H2.5 day change: a Saturday-only 22:00->06:00 window covers Sunday 01:00-04:00 but not Saturday 01:00-04:00",
      n5.covers === true && n6.covers === false, `sunday=${n5.covers} saturday=${n6.covers}`);
    const mon = nextWeekday(1, 3); const tue = addDays(mon, 1);
    const n7 = await night(pr(mon, "20:00"), pr(tue, "04:00"), A.chain);
    const n7b = await night(pr(addDays(mon, 7), "17:00"), pr(addDays(tue, 7), "04:00"), A.chain);
    check("H2.6 consecutive windows Mon 18:00-23:59 + Tue 00:00-08:00 cover Mon 20:00 -> Tue 04:00 (not from 17:00)",
      n7.covers === true && n7b.covers === false, `20:00=${n7.covers} 17:00=${n7b.covers}`);
    const n8 = await night(pr(addDays(sat, 28), "20:00"), pr(addDays(sun, 28), "04:00"), A.cg[5]);
    const n8d = await approve(n8.a);
    check("H2.7 the audit case: caregiver available 00:00-23:59 every day can be approved for 20:00 -> 04:00", n8.covers === true && n8d.status === 200, `covers=${n8.covers} approve=${n8d.status}`);
    // time zone: the window is local (UTC-4); a visit given in UTC must be converted
    const tzDay = nextWeekday(4, 3);
    const inUtc = await night(new Date(`${tzDay}T12:00:00Z`), new Date(`${tzDay}T16:00:00Z`), A.morning); // 08:00-12:00 local
    const early = await night(new Date(`${tzDay}T08:00:00Z`), new Date(`${tzDay}T12:00:00Z`), A.morning); // 04:00-08:00 local
    check("H2.8 time zone: 12:00Z-16:00Z (= 08:00-12:00 Puerto Rico) is covered; 08:00Z-12:00Z (= 04:00-08:00) is not",
      inUtc.covers === true && early.covers === false, `local08-12=${inUtc.covers} local04-08=${early.covers}`);
    // unavailability still applies to overnight visits
    await q(`INSERT INTO worker_unavailability_periods (organization_worker_membership_id,organization_id,starts_at,ends_at,reason) VALUES ($1,$2,$3,$4,'cita')`,
      [A.night.owm, orgA, pr(addDays(sun, 35), "02:00"), pr(addDays(sun, 35), "03:00")]);
    const n9 = await night(pr(addDays(sat, 35), "23:00"), pr(addDays(sun, 35), "05:00"), A.night);
    const n9d = await approve(n9.a);
    check("H2.9 time off inside an overnight visit still blocks it", n9d.status === 409 && n9d.body.checks?.noUnavailabilityConflict === false, `approve=${n9d.status}`);

    // availability API: save overnight, refuse start == end, keep normal windows
    const put = (windows: unknown[]) => call("PUT", `/organizations/${orgA}/me/availability`, A.api.token, { timezone: "America/Puerto_Rico", weeklyWindows: windows, unavailablePeriods: [] });
    const saveNight = await put([{ weekday: 5, startTime: "22:00", endTime: "06:00" }, { weekday: 1, startTime: "08:00", endTime: "17:00" }]);
    const readBack = await call("GET", `/organizations/${orgA}/me/availability`, A.api.token);
    const zero = await put([{ weekday: 2, startTime: "09:00", endTime: "09:00" }]);
    const wins = JSON.stringify(readBack.body);
    check("H2.10 the caregiver saves an overnight window (22:00->06:00) and a normal one; 09:00->09:00 is refused (400)",
      saveNight.status === 200 && wins.includes("22:00") && wins.includes("06:00") && wins.includes("08:00") && zero.status === 400,
      `save=${saveNight.status} read=${readBack.status} zero=${zero.status}`);
    const dbZero = await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,3,'09:00','09:00')`, [A.api.owm, orgA]).then(() => "inserted", (e: Error) => e.message);
    check("H2.11 the database refuses a zero-length window", /worker_weekly_availability_nonzero/.test(dbZero), dbZero.slice(0, 80));

    // workforce forecast: an overnight window counts its 8 hours (it used to count 0)
    const orgN = await org(`SM Fix N ${tag}`);
    const rsN = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'FIX') RETURNING id`, [orgN])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rsN, bls]);
    const nAdmin = await person("nadmin", orgN, ["ORGANIZATION_ADMIN"]);
    await person("nworker", orgN, ["WORKER"], true, [[sat ? new Date(`${sat}T12:00:00Z`).getUTCDay() : 6, "22:00", "06:00"]]);
    const lg = await call("POST", "/auth/login", "", { email: nAdmin.email, password }); nAdmin.token = lg.body.token;
    await call("POST", "/me/active-organization", nAdmin.token, { organizationId: orgN });
    const fc = await call("GET", `/organizations/${orgN}/workforce/forecast?startDate=${sat}&days=7`, nAdmin.token);
    const satDay = ((fc.body.forecast?.days ?? fc.body.days ?? []) as Json[]).find((d) => d.date === sat);
    check("H2.12 workforce forecast counts an overnight window as 480 available minutes", fc.status === 200 && satDay?.knownAvailableMinutes === 480,
      `status=${fc.status} minutes=${satDay?.knownAvailableMinutes}`);

    // ================================================================ H3: malformed JSON
    const badJson = await call("POST", `${S}/opportunities`, A.admin1.token, undefined, "{not json");
    const badJson2 = await call("POST", "/auth/login", "", undefined, '{"email":');
    const huge = await call("POST", `${S}/opportunities`, A.admin1.token, undefined, JSON.stringify({ roleLabel: "x".repeat(200_000) }));
    const leak = /SyntaxError|Unexpected token|at JSON|stack|body-parser/i.test(badJson.text + badJson2.text + huge.text);
    check("H3.1 malformed JSON -> 400 INVALID_JSON (authenticated and anonymous), oversized body -> 413, no internal details",
      badJson.status === 400 && badJson.body.error === "INVALID_JSON" && badJson2.status === 400 && huge.status === 413 && huge.body.error === "PAYLOAD_TOO_LARGE" && !leak,
      `${badJson.status} ${badJson.body.error}, ${badJson2.status}, ${huge.status} ${huge.body.error}, leak=${leak}`);

    // ================================================================ H4: opportunity limits
    const t0 = new Date(Date.now() + 3 * 864e5);
    const body = (start: Date, end: Date) => ({ visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: start.toISOString(), endsAt: end.toISOString() });
    const tooLong = await call("POST", `${S}/opportunities`, A.admin1.token, body(t0, new Date(t0.getTime() + 25 * 3600e3)));
    const maxOk = await call("POST", `${S}/opportunities`, A.admin1.token, body(t0, new Date(t0.getTime() + 24 * 3600e3)));
    const past = await call("POST", `${S}/opportunities`, A.admin1.token, body(new Date(Date.now() - 864e5), new Date(Date.now() - 864e5 + 3600e3)));
    const inverted = await call("POST", `${S}/opportunities`, A.admin1.token, body(new Date(t0.getTime() + 3600e3), t0));
    check("H4.1 25 h refused (OPPORTUNITY_TOO_LONG), 24 h accepted, past start refused (OPPORTUNITY_IN_PAST), end before start still INVALID_REQUEST",
      tooLong.status === 400 && tooLong.body.error === "OPPORTUNITY_TOO_LONG" && maxOk.status === 201
      && past.status === 400 && past.body.error === "OPPORTUNITY_IN_PAST" && inverted.status === 400 && inverted.body.error === "INVALID_REQUEST",
      `${tooLong.status} ${tooLong.body.error}, ${maxOk.status}, ${past.status} ${past.body.error}, ${inverted.status} ${inverted.body.error}`);

    // ================================================================ password_reset_tokens
    const acl = (await q<{ pub: boolean; sel: boolean; ins: boolean; upd: boolean; del: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid='password_reset_tokens'::regclass AND a.grantee=0) pub,
             has_table_privilege('app_runtime','password_reset_tokens','SELECT') sel, has_table_privilege('app_runtime','password_reset_tokens','INSERT') ins,
             has_table_privilege('app_runtime','password_reset_tokens','UPDATE') upd, has_table_privilege('app_runtime','password_reset_tokens','DELETE') del`)).rows[0];
    check("R1 PUBLIC has no privilege; app_runtime keeps SELECT/INSERT/UPDATE and has no DELETE",
      !acl.pub && acl.sel && acl.ins && acl.upd && !acl.del, JSON.stringify(acl));
    const probeRole = `smfix_probe_${tag}`;
    const probePw = randomBytes(12).toString("hex");
    await q(`CREATE ROLE ${probeRole} LOGIN PASSWORD '${probePw}' NOINHERIT`);
    const pu = new URL(adminUrl!); pu.username = probeRole; pu.password = probePw;
    const probe = new pg.Client({ connectionString: pu.toString() });
    let probeResult = "";
    try {
      await probe.connect();
      await probe.query(`SELECT set_config('app.current_user_id',$1,false)`, [A.admin1.userId]);
      probeResult = await probe.query(`SELECT count(*) FROM password_reset_tokens`).then(() => "readable", (e: Error) => e.message);
    } finally { await probe.end().catch(() => undefined); await q(`DROP ROLE ${probeRole}`); }
    check("R2 any other database login (even impersonating a user id) is denied on password_reset_tokens", /permission denied/.test(probeResult), probeResult.slice(0, 60));
    const req = await call("POST", "/auth/password-reset/request", "", { email: A.other.email });
    // The request answers at once (no timing difference) and issues the token right after.
    let issued = 0;
    for (let i = 0; i < 30 && issued === 0; i++) {
      issued = Number((await q<{ n: string }>(`SELECT count(*) n FROM password_reset_tokens WHERE user_id=$1`, [A.other.userId])).rows[0].n);
      if (issued === 0) await new Promise((r) => setTimeout(r, 100));
    }
    const { rawToken, tokenHash } = generateSessionToken();
    await q(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`, [A.other.userId, tokenHash]);
    const newPassword = randomBytes(16).toString("hex");
    const conf = await call("POST", "/auth/password-reset/confirm", "", { token: rawToken, password: newPassword });
    const loginNew = await call("POST", "/auth/login", "", { email: A.other.email, password: newPassword });
    const loginOld = await call("POST", "/auth/login", "", { email: A.other.email, password });
    const reuse = await call("POST", "/auth/password-reset/confirm", "", { token: rawToken, password: randomBytes(16).toString("hex") });
    check("R3 password recovery still works end to end as app_runtime (request stores a token, confirm changes the password once)",
      req.status === 200 && issued >= 1 && conf.status === 200 && loginNew.status === 200 && loginOld.status === 401 && reuse.status >= 400 && reuse.status < 500,
      `request=${req.status} tokens=${issued} confirm=${conf.status} new=${loginNew.status} old=${loginOld.status} reuse=${reuse.status}`);

    // ================================================================ M: caregiver in two agencies (layer 1, migration 112)
    // When SHE accepts a shift, her confirmed commitments in every agency she
    // works for are checked; only she gets the answer. Agencies learn nothing.
    const multi = await person("multi", orgA, ["WORKER"], true);
    const multiWorker = (await q<{ id: string }>(`SELECT worker_id AS id FROM organization_worker_memberships WHERE id=$1`, [multi.owm])).rows[0].id;
    const mB = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [multi.userId, orgB])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='WORKER'`, [mB, orgB]);
    const multiOwmB = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [multiWorker, orgB])).rows[0].id;
    await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [multiOwmB, orgB]);
    for (let d = 0; d < 7; d++) await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,'00:00','23:59')`, [multiOwmB, orgB, d]);
    const loginMulti = async (orgId: string) => {
      const r = await call("POST", "/auth/login", "", { email: multi.email, password });
      await call("POST", "/me/active-organization", r.body.token, { organizationId: orgId });
      return r.body.token as string;
    };
    const multiA = await loginMulti(orgA); const multiB = await loginMulti(orgB);
    const rB = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Sintetico','AgenciaB','active') RETURNING id`, [orgB])).rows[0].id;
    /** A shift at agency A or B assigned to the caregiver (pending until she answers). */
    async function offered(orgId: string, start: Date, end: Date) {
      const adminToken = orgId === orgA ? A.admin1.token : B.admin.token;
      const s = await call("POST", `/organizations/${orgId}/shifts`, adminToken, { careRecipientId: orgId === orgA ? rA : rB, scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() });
      if (s.status !== 201) throw new Error(`shift ${s.status} ${JSON.stringify(s.body)}`);
      const id = s.body.shift.id as string;
      const a = await call("POST", `/organizations/${orgId}/shifts/${id}/assignments`, adminToken, { organizationWorkerMembershipId: orgId === orgA ? multi.owm : multiOwmB });
      if (a.status !== 201) throw new Error(`assign ${a.status} ${JSON.stringify(a.body)}`);
      return id;
    }
    const respond = (orgId: string, shiftId: string, decision: "accepted" | "rejected") =>
      call("POST", `/organizations/${orgId}/me/shifts/${shiftId}/respond`, orgId === orgA ? multiA : multiB, { decision });
    const status = async (shiftId: string) => (await q<{ s: string }>(`SELECT a.response_status::text s FROM assignments a WHERE a.shift_id=$1 ORDER BY created_at DESC LIMIT 1`, [shiftId])).rows[0]?.s;
    const MSG = "MY_SCHEDULE_CONFLICT";
    const dm = nextWeekday(4, 4);              // a Thursday

    const shA = await offered(orgA, pr(dm, "10:00"), pr(dm, "14:00"));
    const accA = await respond(orgA, shA, "accepted");
    const shB = await offered(orgB, pr(dm, "11:00"), pr(dm, "13:00"));
    const accB = await respond(orgB, shB, "accepted");
    check("M1 she cannot accept at agency B a shift that overlaps the one she accepted at agency A (409, still pending)",
      accA.status === 200 && accB.status === 409 && accB.body.error === MSG && (await status(shB)) === "pending", `A=${accA.status} B=${accB.status} ${accB.body.error}`);
    const bText = JSON.stringify(accB.body);
    const bNotices = await call("GET", "/me/notifications?limit=100", B.admin.token);
    const bAssign = await call("GET", `/organizations/${orgB}/shifts/${shB}/assignments`, B.admin.token);
    const bProbe = await (async () => {
      const rt = new pg.Client({ connectionString: process.env.DATABASE_URL }); await rt.connect();
      try {
        await rt.query("BEGIN");
        await rt.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [B.admin.userId, orgB]);
        const shifts = (await rt.query(`SELECT 1 FROM shifts WHERE id=$1`, [shA])).rowCount;
        const asg = (await rt.query(`SELECT 1 FROM assignments WHERE organization_worker_membership_id=$1`, [multi.owm])).rowCount;
        const rec = (await rt.query(`SELECT 1 FROM care_recipients WHERE id=$1`, [rA])).rowCount;
        // The helper has no person argument: from agency B it can only speak about the caller.
        const fn = (await rt.query<{ busy: boolean }>(`SELECT app_my_confirmed_commitment_overlaps($1,$2,NULL) busy`, [pr(dm, "00:00"), pr(dm, "23:00")])).rows[0].busy;
        await rt.query("ROLLBACK");
        return { shifts, asg, rec, fn };
      } finally { await rt.end(); }
    })();
    const publicExec112 = (await q<{ p: boolean }>(`SELECT has_function_privilege('public','app_my_confirmed_commitment_overlaps(timestamptz,timestamptz,uuid)','EXECUTE') p`)).rows[0].p;
    check("M2 isolation: the answer reaches only her; agency B learns nothing about agency A (API, notices, RLS, helper)",
      !bText.includes(shA) && !bText.includes(rA) && !/10:00|14:00|Fix/.test(bText)
        && !JSON.stringify(bNotices.body).includes(shA) && !JSON.stringify(bAssign.body).includes(shA)
        && bProbe.shifts === 0 && bProbe.asg === 0 && bProbe.rec === 0 && bProbe.fn === false && !publicExec112,
      JSON.stringify({ ...bProbe, publicExec112 }));
    const rejB = await respond(orgB, shB, "rejected");
    check("M3 she can still decline that shift (rejection is never blocked)", rejB.status === 200 && (await status(shB)) === "rejected", `${rejB.status}`);

    // Pending offers never block; rejected and cancelled shifts free the time.
    const pA = await offered(orgA, pr(dm, "16:00"), pr(dm, "18:00"));
    const pB = await offered(orgB, pr(dm, "16:30"), pr(dm, "17:30"));
    const accPA = await respond(orgA, pA, "accepted");
    check("M4 an overlapping PENDING offer at another agency does not block accepting (offers are not commitments)", accPA.status === 200, `${accPA.status} ${accPA.body.error ?? ""}`);
    const accPB = await respond(orgB, pB, "accepted");
    check("M5 …but once she accepted one, the other agency's overlapping offer can no longer be accepted", accPB.status === 409 && accPB.body.error === MSG, `${accPB.status}`);
    const cancel = await call("POST", `/organizations/${orgA}/shifts/${pA}/cancel`, A.admin1.token, {});
    const accAfterCancel = await respond(orgB, pB, "accepted");
    check("M6 when agency A cancels its shift, she can accept agency B's overlapping one", cancel.status === 200 && accAfterCancel.status === 200, `cancel=${cancel.status} accept=${accAfterCancel.status} ${accAfterCancel.body.error ?? ""}`);
    await call("POST", `/organizations/${orgA}/shifts/${shA}/cancel`, A.admin1.token, {});
    const rjA = await offered(orgA, pr(dm, "19:00"), pr(dm, "20:00"));
    const rejA = await respond(orgA, rjA, "rejected");
    const rjB = await offered(orgB, pr(dm, "19:15"), pr(dm, "19:45"));
    const accRjB = await respond(orgB, rjB, "accepted");
    check("M7 a shift she declined at agency A is not a commitment: she can accept an overlapping one at agency B",
      rejA.status === 200 && accRjB.status === 200, `reject=${rejA.status} accept=${accRjB.status} ${accRjB.body.error ?? ""}`);

    // Overnight shifts.
    const dn = addDays(dm, 2);
    const nightA = await offered(orgA, pr(dn, "22:00"), pr(addDays(dn, 1), "06:00"));
    await respond(orgA, nightA, "accepted");
    const earlyB = await offered(orgB, pr(addDays(dn, 1), "03:00"), pr(addDays(dn, 1), "05:00"));
    const afterB = await offered(orgB, pr(addDays(dn, 1), "06:00"), pr(addDays(dn, 1), "08:00"));
    const accEarly = await respond(orgB, earlyB, "accepted");
    const accAfter = await respond(orgB, afterB, "accepted");
    check("M8 overnight: a 22:00->06:00 shift at A blocks 03:00-05:00 at B; 06:00-08:00 right after is fine",
      accEarly.status === 409 && accEarly.body.error === MSG && accAfter.status === 200, `03-05=${accEarly.status} 06-08=${accAfter.status}`);

    // An approved SmartMatch visit (no shift yet) is a confirmed commitment.
    const SB = `/organizations/${orgB}/smartmatch`;
    const dv = addDays(dm, 5);
    const oppB = await call("POST", `${SB}/opportunities`, B.admin.token, { visibility: "INTERNAL", regionLabel: "Caguas", roleLabel: "Cuidador/a", startsAt: pr(dv, "14:00").toISOString(), endsAt: pr(dv, "18:00").toISOString() });
    await call("POST", `${SB}/opportunities/${oppB.body.opportunity?.id}/publish`, B.admin.token);
    const appB = await call("POST", `${SB}/opportunities/${oppB.body.opportunity?.id}/applications`, multiB, consent);
    const apprB = await call("POST", `${SB}/applications/${appB.body.application?.id}/decision`, B.admin.token, { decision: "APPROVE", confirm: true });
    const smA = await offered(orgA, pr(dv, "15:00"), pr(dv, "17:00"));
    const accSmA = await respond(orgA, smA, "accepted");
    check("M9 SmartMatch: a visit approved for her at agency B blocks accepting an overlapping shift at agency A",
      apprB.status === 200 && accSmA.status === 409 && accSmA.body.error === MSG, `approve=${apprB.status} ${apprB.body.error ?? ""} accept=${accSmA.status}`);
    const mkB = await call("POST", `${SB}/opportunities/${oppB.body.opportunity?.id}/shift`, B.admin.token, { careRecipientId: rB });
    const smShiftB = (await q<{ id: string | null }>(`SELECT shift_id AS id FROM smartmatch_opportunities WHERE id=$1`, [oppB.body.opportunity?.id])).rows[0]?.id;
    const accSmB = smShiftB ? await respond(orgB, smShiftB, "accepted") : { status: 0, body: {} as Json };
    check("M10 SmartMatch: once agency B creates the shift of that visit she accepts it normally (its own visit does not block it)",
      mkB.status === 201 && accSmB.status === 200, `shift=${mkB.status} ${mkB.body.error ?? ""} accept=${accSmB.status} ${accSmB.body.error ?? ""}`);

    // Concurrency: the same person accepts two overlapping shifts at two agencies at the same instant.
    const dc = addDays(dm, 7);
    let exactlyOne = 0; const roundsDetail: string[] = [];
    for (let i = 0; i < 6; i++) {
      const start = pr(dc, `${String(6 + i * 2).padStart(2, "0")}:00`); const end = new Date(start.getTime() + 90 * 60e3);
      const cA = await offered(orgA, start, end); const cB = await offered(orgB, new Date(start.getTime() + 30 * 60e3), new Date(end.getTime() + 30 * 60e3));
      const [ra, rb] = await Promise.all([respond(orgA, cA, "accepted"), respond(orgB, cB, "accepted")]);
      const accepted = [ra, rb].filter((r) => r.status === 200).length;
      const conflicts = [ra, rb].filter((r) => r.status === 409 && r.body.error === MSG).length;
      if (accepted === 1 && conflicts === 1) exactlyOne++;
      roundsDetail.push(`${ra.status}/${rb.status}`);
    }
    check("M11 6 rounds: accepting at agency A and agency B at the same instant -> exactly one accepted, the other told only to her",
      exactlyOne === 6, roundsDetail.join(" "));

    check("Z1 no server error (5xx) in the whole run", serverErrors.length === 0, serverErrors.join(" | "));
  } finally {
    for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(120)} ${r.detail}`);
    const passed = results.filter((r) => r.pass).length;
    console.log(`SmartMatch fixes: ${passed}/${results.length} PASS`);
    server.close(); await pool.end(); await db.end();
    if (passed !== results.length) process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
