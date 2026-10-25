/**
 * Informe de Turno F1 (migration 124), end to end over HTTP as app_runtime.
 * A caregiver's real visit (Llegué, start, care, incident, observation, end) becomes a
 * draft built only from those records; agency managers refresh and approve it; an
 * approved report never changes; history is append-only. Caregivers, families, other
 * agencies and ETNARA central cannot read reports. Synthetic data only.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });
const logged: string[] = [];
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); if (level === "error") original(...args); };
}
const out = (line: string) => process.stdout.write(line + "\n");

const NOTE = "Comió bien la avena. Dijo: «I feel good».";
const INCIDENT = "Tropezó en el pasillo sin caer.";
const OBSERVATION = "Poco apetito al mediodía.";

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
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 40) }; }
    return { status: res.status, body: parsed };
  }
  const org = async (name: string, features: string[]) => {
    const id = (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
    for (const f of features) await q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,$2,true)`, [id, f]);
    await q(`INSERT INTO organization_care_event_types (organization_id,care_event_type_id) SELECT $1,id FROM care_event_types`, [id]);
    return id;
  };
  const orgA = await org(`SR A ${tag}`, ["EN_CAMINO", "SHIFT_REPORTS"]);
  const orgB = await org(`SR B ${tag}`, ["SHIFT_REPORTS"]);
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'SR') RETURNING id`, [orgA])).rows[0].id;
  await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  type P = { email: string; userId: string; token: string; membershipId?: string; orgMembershipId: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `sr-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let membershipId: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `María Sintética ${key}`])).rows[0].id;
      membershipId = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
    }
    return { email, userId, token: "", membershipId, orgMembershipId: m };
  }
  const A = {
    admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]), supervisor: await person("a-sup", orgA, ["SUPERVISOR"]),
    admin2: await person("a-admin2", orgA, ["ORGANIZATION_ADMIN"]), cg: await person("a-cg", orgA, ["WORKER"], true),
    family: await person("a-family", orgA, ["FAMILY"]),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]) };
  const rA = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,preferred_name) VALUES ($1,'Carmen',$2,'Doña Carmen') RETURNING id`, [orgA, `Sintética-${tag}`])).rows[0].id;
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [A.family.userId, orgA, rA]);
  for (const [p, o] of [...Object.values(A).map((p) => [p, orgA] as const), [B.admin, orgB] as const]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${r.status}`);
    p.token = r.body.token;
    await call("POST", "/me/active-organization", p.token, { organizationId: o });
  }
  const shift = async () => {
    const s = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '30 minutes',now()+interval '3 hours','confirmed') RETURNING id`, [orgA, rA])).rows[0].id;
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,response_status,responded_at) VALUES ($1,$2,$3,'accepted',now())`, [orgA, s, A.cg.membershipId]);
    return s;
  };
  const S = `/organizations/${orgA}`;
  const cg = A.cg.token;
  const fingerprint = async () => (await q<{ h: string }>(`SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
      SELECT 'ce'||ce::text AS x FROM care_events ce WHERE organization_id=$1
      UNION ALL SELECT 've'||ve::text FROM verification_events ve WHERE organization_id=$1
      UNION ALL SELECT 'sa'||sa::text FROM shift_arrivals sa WHERE organization_id=$1
      UNION ALL SELECT 'in'||i::text FROM incidents i WHERE organization_id=$1
      UNION ALL SELECT 'ob'||o::text FROM observations o WHERE organization_id=$1) t`, [orgA])).rows[0].h;
  async function asRuntime<T>(userId: string, orgId: string, superadmin: boolean, work: (c: pg.Client) => Promise<T>): Promise<T | string> {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`, [userId, orgId, superadmin ? "true" : "false"]);
      return await work(c);
    } catch (e) { return (e as { code?: string; message?: string }).code ?? "error"; } finally { await c.query("ROLLBACK").catch(() => undefined); await c.end(); }
  }
  /** Runs one statement as the owner and always rolls it back; returns "allowed" or the error message. */
  const ownerError = async (s: string, p: unknown[] = []) => {
    await q("BEGIN");
    try { await q(s, p); return "allowed"; }
    catch (e) { return (e as { message?: string }).message ?? "error"; }
    finally { await q("ROLLBACK"); }
  };

  try {
    // ------------------------------------------------------------ a real visit, recorded through the API
    const s1 = await shift();
    const arrive = await call("POST", `${S}/shifts/${s1}/arrival`, cg, {});
    const start = await call("POST", `${S}/shifts/${s1}/check-in`, cg, { verificationMethodCode: "CAREGIVER_SESSION" });
    const care = async (typeCode: string, payload?: Json, noteText?: string) =>
      (await call("POST", `${S}/shifts/${s1}/care-events`, cg, { typeCode, careRecipientId: rA, ...(payload ? { payload } : {}), ...(noteText ? { noteText } : {}) })).status;
    const careStatuses = [
      await care("MEAL", { mealType: "Desayuno", amountConsumed: "Todo" }),
      await care("HYDRATION", { amount: "Vaso completo" }),
      await care("TOILETING", { result: "Sin novedad" }),
      await care("ACTIVITY", { label: "Caminata", durationMinutes: 20 }),
      await care("NOTE", undefined, NOTE),
    ];
    const inc = await call("POST", `${S}/incidents`, cg, { careRecipientId: rA, severity: "Leve", description: INCIDENT });
    const obs = await call("POST", `${S}/observations`, cg, { careRecipientId: rA, category: "low_appetite", description: OBSERVATION });
    const end = await call("POST", `${S}/shifts/${s1}/check-out`, cg, {});
    check("setup: Llegué, start, 5 care records, incident, observation and end recorded through the API",
      [arrive.status, start.status, end.status].every((s) => s === 201 || s === 200) && careStatuses.every((s) => s === 201) && inc.status === 201 && obs.status === 201,
      `${arrive.status},${start.status},${careStatuses.join("/")},${inc.status},${obs.status},${end.status}`);
    const before = await fingerprint();

    // ------------------------------------------------------------ G: generation from existing records
    const g1 = await call("GET", `${S}/shifts/${s1}/shift-reports`, A.admin.token);
    const report = g1.body.reports?.[0] as Json | undefined;
    const c = (report?.content ?? {}) as Json;
    const dbTimes = (await q<Json>(`SELECT (SELECT occurred_at FROM shift_arrivals WHERE shift_id=$1) AS a,
      (SELECT occurred_at FROM verification_events WHERE shift_id=$1 AND event_type='check_in') AS i,
      (SELECT occurred_at FROM verification_events WHERE shift_id=$1 AND event_type='check_out') AS o`, [s1])).rows[0];
    check("G1 the agency gets one DRAFT for the finished visit", g1.status === 200 && g1.body.reports?.length === 1 && report?.status === "DRAFT", `${g1.status} ${g1.body.reports?.length}`);
    check("G2 identification: agency, resident, caregiver, scheduled hours",
      c.organization?.name === `SR A ${tag}` && c.recipient?.name === "Doña Carmen" && /María Sintética/.test(c.caregiver?.name ?? "")
      && typeof c.shift?.scheduledStart === "string" && typeof c.shift?.scheduledEnd === "string");
    check("G3 arrival, start and end are the real, separate times of the records",
      c.times?.arrival?.at === new Date(dbTimes.a).toISOString() && c.times?.start?.at === new Date(dbTimes.i).toISOString()
      && c.times?.end?.at === new Date(dbTimes.o).toISOString() && c.times?.arrival?.proximity === "NO_CONSENT");
    const sec = (c.sections ?? {}) as Json;
    check("G4 sections match the care records exactly (meal, hydration, hygiene, activity, note; none invented)",
      sec.meals?.length === 1 && sec.meals[0].mealType === "Desayuno" && sec.meals[0].amountConsumed === "Todo"
      && sec.hydration?.length === 1 && sec.hygiene?.length === 1 && sec.hygiene[0].result === "Sin novedad"
      && sec.activities?.length === 1 && sec.activities[0].label === "Caminata" && sec.activities[0].durationMinutes === 20
      && sec.mobility?.length === 0 && sec.mood?.length === 0 && sec.notes?.length === 1 && c.totals?.careEvents === 5,
      JSON.stringify(c.totals));
    check("G5 free text is kept verbatim (never translated or rewritten)", sec.notes?.[0]?.text === NOTE && c.incidents?.[0]?.description === INCIDENT
      && c.observations?.[0]?.description === OBSERVATION);
    check("G6 incident and observation filed during the visit are included", c.incidents?.length === 1 && c.observations?.length === 1);
    check("G7 no plan tasks or pending items are produced (F5 postponed)", !("tasks" in c) && !("pending" in c) && !JSON.stringify(c).includes("pending"));
    check("G8 GENERATED is in the history", report?.history?.length === 1 && report.history[0].type === "GENERATED" && report.history[0].actor?.userId === A.admin.userId);
    const g2 = await call("GET", `${S}/shifts/${s1}/shift-reports`, A.admin.token);
    const n = (await q<{ r: number; e: number }>(`SELECT (SELECT count(*)::int FROM shift_reports WHERE shift_id=$1) AS r,
      (SELECT count(*)::int FROM shift_report_events e JOIN shift_reports r ON r.id=e.shift_report_id WHERE r.shift_id=$1) AS e`, [s1])).rows[0];
    check("G9 opening it again creates nothing new (idempotent)", g2.status === 200 && n.r === 1 && n.e === 1, `${n.r}/${n.e}`);

    const s2 = await shift();
    await call("POST", `${S}/shifts/${s2}/check-in`, cg, { verificationMethodCode: "CAREGIVER_SESSION" });
    const open = await call("GET", `${S}/shifts/${s2}/shift-reports`, A.admin.token);
    check("G10 a visit still in progress gets no report", open.status === 200 && open.body.reports?.length === 0 && open.body.openVisits === 1, JSON.stringify(open.body).slice(0, 80));
    await call("POST", `${S}/shifts/${s2}/check-out`, cg, {});
    const empty = (await call("GET", `${S}/shifts/${s2}/shift-reports`, A.admin.token)).body.reports?.[0]?.content as Json | undefined;
    const allEmpty = empty && Object.values(empty.sections as Json).every((l) => Array.isArray(l) && l.length === 0);
    check("G11 a visit without records gives empty sections and no arrival (nothing invented)",
      Boolean(allEmpty) && empty!.times?.arrival === null && empty!.incidents?.length === 0 && empty!.observations?.length === 0 && empty!.totals?.careEvents === 0);

    // ------------------------------------------------------------ P: who can read
    const sup = await call("GET", `${S}/shifts/${s1}/shift-reports`, A.supervisor.token);
    check("P1 a supervisor of the agency can review (manager)", sup.status === 200 && sup.body.reports?.length === 1);
    const cgApi = await call("GET", `${S}/shifts/${s1}/shift-reports`, cg);
    const cgList = await call("GET", `${S}/shift-reports`, cg);
    const cgDb = await asRuntime(A.cg.userId, orgA, false, async (cl) => (await cl.query("SELECT count(*)::int AS n FROM shift_reports")).rows[0].n);
    check("P2 the caregiver cannot read reports in F1 (API 403, database 0 rows)", cgApi.status === 403 && cgList.status === 403 && cgDb === 0, `${cgApi.status}/${cgList.status}/${cgDb}`);
    const famApi = await call("GET", `${S}/shifts/${s1}/shift-reports`, A.family.token);
    const famDb = await asRuntime(A.family.userId, orgA, false, async (cl) => (await cl.query("SELECT count(*)::int AS n FROM shift_reports")).rows[0].n);
    check("P3 the family cannot read drafts (API 403, database 0 rows)", famApi.status === 403 && famDb === 0, `${famApi.status}/${famDb}`);
    const bApi = await call("GET", `${S}/shifts/${s1}/shift-reports`, B.admin.token);
    const bApprove = await call("POST", `/organizations/${orgB}/shift-reports/${report?.id}/approve`, B.admin.token, { expectedGeneratedAt: report?.generatedAt });
    const bDb = await asRuntime(B.admin.userId, orgB, false, async (cl) => (await cl.query("SELECT count(*)::int AS n FROM shift_reports WHERE organization_id=$1", [orgA])).rows[0].n);
    check("P4 another agency neither reads nor approves (403/404, database 0 rows)", [403, 404].includes(bApi.status) && bApprove.status === 404 && bDb === 0, `${bApi.status}/${bApprove.status}/${bDb}`);
    const platformUser = (await q<{ id: string }>(`INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id`, [`sr-platform-${tag}@example.invalid`])).rows[0].id;
    await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [platformUser]);
    const plat = await asRuntime(platformUser, orgA, true, async (cl) => {
      const r = (await cl.query("SELECT count(*)::int AS n FROM shift_reports")).rows[0].n;
      const e = (await cl.query("SELECT count(*)::int AS n FROM shift_report_events")).rows[0].n;
      return `${r}/${e}`;
    });
    // Positive control for the same session shape: the agency admin (not superadmin) sees them.
    const adminDb = await asRuntime(A.admin.userId, orgA, false, async (cl) => (await cl.query("SELECT count(*)::int AS n FROM shift_reports")).rows[0].n);
    check("P5 ETNARA central reads no report or history (rows exist: the agency sees them)", plat === "0/0" && Number(adminDb) >= 2, `${plat} vs ${adminDb}`);
    await q(`UPDATE organization_memberships SET status='revoked' WHERE id=$1`, [A.admin2.orgMembershipId]);
    const revoked = await call("GET", `${S}/shifts/${s1}/shift-reports`, A.admin2.token);
    check("P6 a manager whose membership was revoked loses access", [401, 403].includes(revoked.status), String(revoked.status));

    // ------------------------------------------------------------ A: refresh and approval
    const stale = await call("POST", `${S}/shift-reports/${report?.id}/approve`, A.admin.token, { expectedGeneratedAt: "2020-01-01T00:00:00.000Z" });
    check("A1 approving a draft that changed since it was read is refused (409)", stale.status === 409 && stale.body.error === "SHIFT_REPORT_CHANGED", `${stale.status} ${stale.body.error}`);
    // An offline record that reached the server after the visit closed (owner insert, as the queue replay would).
    const mealType = (await q<{ id: string }>(`SELECT id FROM care_event_types WHERE code='MEAL'`)).rows[0].id;
    await q(`INSERT INTO care_events (organization_id,shift_id,care_recipient_id,organization_worker_membership_id,care_event_type_id,occurred_at,structured_data)
      VALUES ($1,$2,$3,$4,$5,$6::timestamptz - interval '5 minutes','{"mealType":"Snack","amountConsumed":"Mitad"}')`, [orgA, s1, rA, A.cg.membershipId, mealType, dbTimes.o]);
    const refreshed = await call("POST", `${S}/shift-reports/${report?.id}/refresh`, A.admin.token);
    const rc = refreshed.body.report?.content as Json | undefined;
    check("A2 «Actualizar borrador» picks up a record that arrived later; REGENERATED in history",
      refreshed.status === 200 && rc?.sections?.meals?.length === 2 && rc?.totals?.careEvents === 6
      && refreshed.body.report?.history?.map((h: Json) => h.type).join(",") === "GENERATED,REGENERATED", `${refreshed.status}`);
    const cgApprove = await call("POST", `${S}/shift-reports/${report?.id}/approve`, cg, { expectedGeneratedAt: refreshed.body.report?.generatedAt });
    check("A3 a caregiver cannot approve", cgApprove.status === 403, String(cgApprove.status));
    const approved = await call("POST", `${S}/shift-reports/${report?.id}/approve`, A.admin.token, {
      expectedGeneratedAt: refreshed.body.report?.generatedAt, agencySummary: "Turno tranquilo.", familySections: { observations: false } });
    const fs = approved.body.report?.familySections as Json | undefined;
    check("A4 approval: APPROVED, approver and time recorded, family sections stored",
      approved.status === 200 && approved.body.report?.status === "APPROVED" && approved.body.report?.approvedBy?.userId === A.admin.userId
      && approved.body.report?.agencySummary === "Turno tranquilo.", `${approved.status} ${approved.body.error ?? ""}`);
    check("A5 family defaults: schedule, meals, hydration, activities, mobility on; hygiene, mood, incidents, photos off; agency choice kept",
      fs?.schedule === true && fs?.meals === true && fs?.hydration === true && fs?.activities === true && fs?.mobility === true
      && fs?.hygiene === false && fs?.mood === false && fs?.incidents === false && fs?.photos === false && fs?.observations === false, JSON.stringify(fs));
    const again = await call("POST", `${S}/shift-reports/${report?.id}/approve`, A.admin.token, { expectedGeneratedAt: approved.body.report?.generatedAt });
    const refreshApproved = await call("POST", `${S}/shift-reports/${report?.id}/refresh`, A.admin.token);
    check("A6 an approved report cannot be approved again or refreshed (409)", again.status === 409 && refreshApproved.status === 409, `${again.status}/${refreshApproved.status}`);
    const ownerEdit = await ownerError(`UPDATE shift_reports SET content = '{"x":1}' WHERE id=$1`, [report?.id]);
    const ownerSummary = await ownerError(`UPDATE shift_reports SET agency_summary = 'otro' WHERE id=$1`, [report?.id]);
    const ownerDelete = await ownerError(`DELETE FROM shift_reports WHERE id=$1`, [report?.id]);
    check("A7 even the table owner cannot change or delete an approved report", /APPROVED_IMMUTABLE/.test(ownerEdit) && /APPROVED_IMMUTABLE/.test(ownerSummary) && /NOT_DELETABLE/.test(ownerDelete),
      `${ownerEdit.slice(0, 30)} | ${ownerDelete.slice(0, 30)}`);
    const histEdit = await ownerError(`UPDATE shift_report_events SET note = 'x' WHERE shift_report_id=$1`, [report?.id]);
    const histDelete = await ownerError(`DELETE FROM shift_report_events WHERE shift_report_id=$1`, [report?.id]);
    check("A8 history is append-only, owner included", /APPEND_ONLY/.test(histEdit) && /APPEND_ONLY/.test(histDelete));
    const rtDelete = await asRuntime(A.admin.userId, orgA, false, async (cl) => { await cl.query("DELETE FROM shift_reports WHERE organization_id=$1", [orgA]); return "allowed"; });
    const rtHist = await asRuntime(A.admin.userId, orgA, false, async (cl) => { await cl.query("UPDATE shift_report_events SET note='x' WHERE organization_id=$1", [orgA]); return "allowed"; });
    check("A9 the app role has no DELETE on reports nor UPDATE on history (42501)", rtDelete === "42501" && rtHist === "42501", `${rtDelete}/${rtHist}`);
    const history = (await q<Json>(`SELECT event_type, details FROM shift_report_events WHERE shift_report_id=$1 ORDER BY created_at`, [report?.id])).rows;
    check("A10 history holds steps and counts only, never report text",
      history.map((h) => h.event_type).join(",") === "GENERATED,REGENERATED,APPROVED" && !JSON.stringify(history).includes("avena") && !JSON.stringify(history).includes("Tropezó"));

    // ------------------------------------------------------------ L: list, automatic drafts
    const s3 = await shift();
    await call("POST", `${S}/shifts/${s3}/check-in`, cg, { verificationMethodCode: "CAREGIVER_SESSION" });
    await call("POST", `${S}/shifts/${s3}/check-out`, cg, {});
    const list = await call("GET", `${S}/shift-reports`, A.admin.token);
    const listed = (list.body.reports ?? []) as Json[];
    check("L1 a finished visit gets its draft on its own in the list (never opened before)", list.status === 200 && listed.some((r) => r.shiftId === s3 && r.status === "DRAFT"), String(listed.length));
    const approvedOnly = await call("GET", `${S}/shift-reports?status=APPROVED`, A.admin.token);
    check("L2 filter by status", approvedOnly.status === 200 && approvedOnly.body.reports?.length === 1 && approvedOnly.body.reports[0].id === report?.id);
    check("L3 the list carries names, times and counts only (no notes or descriptions)", !JSON.stringify(list.body).includes("avena") && !JSON.stringify(list.body).includes("Tropezó"));

    // ------------------------------------------------------------ F: switch
    await q(`UPDATE organization_features SET enabled=false WHERE organization_id=$1 AND feature_code='SHIFT_REPORTS'`, [orgA]);
    const off = await call("GET", `${S}/shifts/${s1}/shift-reports`, A.admin.token);
    const offList = await call("GET", `${S}/shift-reports`, A.admin.token);
    const offInsert = await ownerError(`INSERT INTO shift_reports (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,content,version) VALUES ($1,$2,$3,$4,'{}',1)`,
      [orgA, s1, A.cg.membershipId, rA]);
    check("F1 with SHIFT_REPORTS off: routes 404 and the database refuses new reports", off.status === 404 && offList.status === 404 && /FEATURE_NOT_ENABLED/.test(offInsert), `${off.status}/${offList.status}/${offInsert.slice(0, 24)}`);
    await q(`UPDATE organization_features SET enabled=true WHERE organization_id=$1 AND feature_code='SHIFT_REPORTS'`, [orgA]);

    // ------------------------------------------------------------ integrity and logs
    const careDelta = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM care_events WHERE organization_id=$1 AND shift_id=$2`, [orgA, s1])).rows[0].n;
    const expectedAfter = await (async () => { // the late owner-inserted meal is the only intended change
      const tmp = await q<{ h: string }>(`SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
        SELECT 'ce'||ce::text AS x FROM care_events ce WHERE organization_id=$1 AND (structured_data->>'mealType') IS DISTINCT FROM 'Snack'
        UNION ALL SELECT 've'||ve::text FROM verification_events ve WHERE organization_id=$1 AND shift_id = $2
        UNION ALL SELECT 'sa'||sa::text FROM shift_arrivals sa WHERE organization_id=$1
        UNION ALL SELECT 'in'||i::text FROM incidents i WHERE organization_id=$1
        UNION ALL SELECT 'ob'||o::text FROM observations o WHERE organization_id=$1) t`, [orgA, s1]);
      return tmp.rows[0].h;
    })();
    check("I1 source records of the visit are byte-identical after generation, refresh and approval", expectedAfter === before && careDelta === 6, `${before === expectedAfter} ${careDelta}`);
    const leaked = logged.filter((l) => /avena|I feel good|Tropezó|apetito|Doña Carmen|Turno tranquilo/.test(l));
    check("Z1 logs contain no report text or names", leaked.length === 0, `líneas=${leaked.length}`);
  } finally {
    server.close();
    await pool.end();
    await db.end();
  }

  const failed = results.filter((r) => !r.pass);
  for (const r of results) out(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
  out(`\nShift reports F1: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) { for (const r of failed) out(`::error title=verifyShiftReportsF1::${r.name} [${r.detail}]`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
