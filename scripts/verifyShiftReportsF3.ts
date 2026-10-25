/**
 * Informe de Turno F3 (migration 129), end to end over HTTP as app_runtime.
 * An authorized relative reads ONLY approved reports of her own resident, ONLY the
 * sections the agency allowed, and downloads a server-rendered PDF that shows the same
 * thing (never more). Revoked relatives, other residents, other agencies, staff on the
 * family route, ETNARA central and agencies with SHIFT_REPORTS off get nothing.
 * Every download is recorded; nothing is cached or public. Synthetic data only.
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
const FREE_NOTE = "Estuvo tranquila y conversadora en el patio.";
const MEAL_NOTE = "Avena con canela.";
const HYGIENE = "Baño asistido completo";
const MOOD = "Algo ansiosa al inicio";
const INCIDENT = "Tropezó levemente sin caerse.";
const FINAL = "Pidió que la llamen el domingo.";
const SUMMARY = "Turno tranquilo, sin novedades.";

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
  const { generatePendingShiftReports } = await import("../src/modules/shiftReports/shiftReportsCaregiver.service.js");
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
    const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'SR3') RETURNING id`, [id])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
    return id;
  };
  const orgA = await org(`SR3 A ${tag}`, ["SHIFT_REPORTS"]);
  const orgB = await org(`SR3 B ${tag}`, ["SHIFT_REPORTS"]);
  const orgC = await org(`SR3 C ${tag}`, []); // SHIFT_REPORTS off
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  type P = { email: string; userId: string; token: string; membershipId?: string; orgMembershipId: string; orgId: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `sr3-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let membershipId: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Cuidadora ${key}`])).rows[0].id;
      membershipId = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
    }
    return { email, userId, token: "", membershipId, orgMembershipId: m, orgId };
  }
  const A = { admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]), cg: await person("a-cg", orgA, ["WORKER"], true),
    family: await person("a-fam", orgA, ["FAMILY"]), otherFamily: await person("a-fam2", orgA, ["FAMILY"]),
    revokedFamily: await person("a-fam3", orgA, ["FAMILY"]), roleLessFamily: await person("a-fam4", orgA, ["FAMILY"]) };
  const B = { family: await person("b-fam", orgB, ["FAMILY"]) };
  const C = { cg: await person("c-cg", orgC, ["WORKER"], true), admin: await person("c-admin", orgC, ["ORGANIZATION_ADMIN"]), family: await person("c-fam", orgC, ["FAMILY"]) };
  const recipient = async (o: string, first = "Carmen", pref = "Doña Carmen") => (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,preferred_name) VALUES ($1,$2,$3,$4) RETURNING id`, [o, first, `F3-${tag}`, pref])).rows[0].id;
  const rA = await recipient(orgA), rA2 = await recipient(orgA, "Rosa", "Doña Rosa"), rB = await recipient(orgB), rC = await recipient(orgC);
  const rel = (p: P, r: string) => q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [p.userId, p.orgId, r]);
  await rel(A.family, rA); await rel(A.otherFamily, rA2); await rel(A.revokedFamily, rA); await rel(A.roleLessFamily, rA); await rel(B.family, rB); await rel(C.family, rC);
  for (const p of [...Object.values(A), B.family, ...Object.values(C)]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${r.status}`);
    p.token = r.body.token;
    await call("POST", "/me/active-organization", p.token, { organizationId: p.orgId });
  }
  const visit = async (o: string, r: string, p: P, care: Array<[string, Json | undefined, string | undefined]>, incident?: string) => {
    const s = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '30 minutes',now()+interval '3 hours','confirmed') RETURNING id`, [o, r])).rows[0].id;
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,response_status,responded_at) VALUES ($1,$2,$3,'accepted',now())`, [o, s, p.membershipId]);
    const S = `/organizations/${o}/shifts/${s}`;
    await call("POST", `${S}/check-in`, p.token, { verificationMethodCode: "CAREGIVER_SESSION" });
    for (const [typeCode, payload, noteText] of care) await call("POST", `${S}/care-events`, p.token, { typeCode, careRecipientId: r, ...(payload ? { payload } : {}), ...(noteText ? { noteText } : {}) });
    if (incident) {
      const inc = await call("POST", `/organizations/${o}/incidents`, p.token, { careRecipientId: r, severity: "Leve", description: incident });
      if (inc.status !== 201 && inc.status !== 200) throw new Error(`incident ${inc.status}`);
    }
    const out = await call("POST", `${S}/check-out`, p.token, {});
    if (out.status !== 200 && out.status !== 201) throw new Error(`checkout ${out.status}`);
    return s;
  };
  const SA = `/organizations/${orgA}`;
  const FR = (r: string) => `${SA}/care-recipients/${r}/shift-reports`;
  const fingerprint = async () => (await q<{ h: string }>(`SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
      SELECT 'ce'||ce::text AS x FROM care_events ce WHERE organization_id=$1
      UNION ALL SELECT 've'||ve::text FROM verification_events ve WHERE organization_id=$1
      UNION ALL SELECT 'in'||i::text FROM incidents i WHERE organization_id=$1
      UNION ALL SELECT 'sr'||r.id||r.status||r.content::text||coalesce(r.family_sections::text,'') FROM shift_reports r WHERE organization_id=$1) t`, [orgA])).rows[0].h;
  async function asRuntime<T>(userId: string, orgId: string, superadmin: boolean, work: (c: pg.Client) => Promise<T>): Promise<T | string> {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`, [userId, orgId, superadmin ? "true" : "false"]);
      return await work(c);
    } catch (e) { return (e as { code?: string; message?: string }).message ?? "error"; } finally { await c.query("ROLLBACK").catch(() => undefined); await c.end(); }
  }
  async function pdf(path: string, token: string) {
    const res = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, type: res.headers.get("content-type") ?? "", disposition: res.headers.get("content-disposition") ?? "",
      cache: res.headers.get("cache-control") ?? "", buf };
  }
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "sr3-"));
  const pdfText = (buf: Buffer) => { const f = join(dir, `${randomUUID()}.pdf`); writeFileSync(f, buf); return execFileSync("pdftotext", ["-layout", f, "-"]).toString("utf8"); };

  try {
    // Four visits by the same caregiver for Doña Carmen; one for Doña Rosa.
    const s1 = await visit(orgA, rA, A.cg, [["MEAL", { mealType: "Desayuno", amountConsumed: "Casi todo" }, MEAL_NOTE], ["HYDRATION", { amount: "Vaso completo" }, undefined],
      ["TOILETING", { result: HYGIENE }, undefined], ["MOOD", { mood: MOOD }, undefined], ["ACTIVITY", { label: "Caminata en el patio", durationMinutes: 20 }, undefined], ["NOTE", undefined, FREE_NOTE]], INCIDENT);
    const s2 = await visit(orgA, rA, A.cg, [["MEAL", { mealType: "Almuerzo", amountConsumed: "Mitad" }, undefined], ["TOILETING", { result: HYGIENE }, undefined]]);
    const s3 = await visit(orgA, rA, A.cg, [["HYDRATION", { amount: "Medio vaso" }, undefined]]);
    const s4 = await visit(orgA, rA, A.cg, [["HYDRATION", { amount: "Un vaso" }, undefined]]);
    const s5 = await visit(orgA, rA2, A.cg, [["HYDRATION", { amount: "Un vaso" }, undefined]]);
    const sC = await visit(orgC, rC, C.cg, [["HYDRATION", { amount: "Un vaso" }, undefined]]);
    await generatePendingShiftReports();
    const rid = async (s: string) => (await q<{ id: string; generated_at: string }>(`SELECT id, generated_at FROM shift_reports WHERE shift_id=$1`, [s])).rows[0];
    const [r1, r2, r3, r4, r5] = [await rid(s1), await rid(s2), await rid(s3), await rid(s4), await rid(s5)];
    // r1: caregiver observation + send; agency approves with ETNARA defaults + incidents expressly + summary.
    const MY = `${SA}/me/shift-reports/${r1.id}`;
    await call("POST", `${MY}/observation`, A.cg.token, { text: FINAL });
    await call("POST", `${MY}/submit`, A.cg.token);
    const gen = async (id: string) => (await q<{ g: string }>(`SELECT to_char(generated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS g FROM shift_reports WHERE id=$1`, [id])).rows[0].g;
    const view1 = await call("GET", `${SA}/shifts/${s1}/shift-reports`, A.admin.token);
    const a1 = await call("POST", `${SA}/shift-reports/${r1.id}/approve`, A.admin.token, { expectedGeneratedAt: view1.body.reports?.[0]?.generatedAt,
      familySections: { schedule: true, meals: true, hydration: true, activities: true, mobility: true, observations: true, hygiene: false, mood: false, incidents: true, photos: false },
      agencySummary: SUMMARY });
    const view2 = await call("GET", `${SA}/shifts/${s2}/shift-reports`, A.admin.token);
    const a2 = await call("POST", `${SA}/shift-reports/${r2.id}/approve`, A.admin.token, { expectedGeneratedAt: view2.body.reports?.[0]?.generatedAt,
      familySections: { schedule: false, meals: true, hydration: false, activities: false, mobility: false, observations: false, hygiene: false, mood: false, incidents: false, photos: false } });
    await call("POST", `${SA}/me/shift-reports/${r4.id}/submit`, A.cg.token); // r3 stays DRAFT, r4 SUBMITTED
    const view5 = await call("GET", `${SA}/shifts/${s5}/shift-reports`, A.admin.token);
    await call("POST", `${SA}/shift-reports/${r5.id}/approve`, A.admin.token, { expectedGeneratedAt: view5.body.reports?.[0]?.generatedAt });
    void gen;
    if (a1.status !== 200 || a2.status !== 200) throw new Error(`approve ${a1.status}/${a2.status} ${a1.body.error ?? ""}`);
    const before = await fingerprint();

    // ------------------------------------------------------------ L: list
    const list = await call("GET", FR(rA), A.family.token);
    const ids = (list.body.reports ?? []).map((x: Json) => x.id);
    check("L1 the family lists ONLY approved reports of her resident (no draft, no sent, no other resident)",
      list.status === 200 && ids.length === 2 && ids.includes(r1.id) && ids.includes(r2.id) && !ids.includes(r3.id) && !ids.includes(r4.id) && !ids.includes(r5.id), `${list.status} ${ids.length}`);
    const item2 = (list.body.reports ?? []).find((x: Json) => x.id === r2.id);
    check("L2 list hides the schedule when the agency did not share it", item2 && item2.scheduledStart === null && typeof item2.serviceDate === "string", JSON.stringify(item2 ?? {}));

    // ------------------------------------------------------------ V: view
    const v1 = await call("GET", `${FR(rA)}/${r1.id}`, A.family.token);
    const rep = v1.body.report ?? {};
    const keys = Object.keys(rep.sections ?? {}).sort().join(",");
    check("V1 only the sections the agency allowed (hygiene and mood withheld, incidents expressly shared)",
      v1.status === 200 && keys === "activities,hydration,incidents,meals,mobility,observations,schedule", keys);
    const raw = JSON.stringify(rep);
    check("V2 identification: report id, agency, resident, caregiver, date, status, approval date",
      rep.id === r1.id && rep.organization?.name === `SR3 A ${tag}` && rep.recipient?.name === "Doña Carmen" && rep.caregiver?.name === "Cuidadora a-cg"
      && rep.status === "APPROVED" && typeof rep.approvedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rep.serviceDate ?? ""));
    check("V3 the content is the approved version: records verbatim, caregiver's final note, agency summary",
      raw.includes(MEAL_NOTE) && raw.includes(FREE_NOTE) && raw.includes(INCIDENT) && rep.sections?.observations?.caregiverNote?.text === FINAL && rep.agencySummary === SUMMARY);
    check("V4 nothing beyond the family view: no withheld text, internal ids, location, offline flags, photos, totals, history or approver",
      !raw.includes(HYGIENE) && !raw.includes(MOOD) && !/careEventId|incidentId|observationId|membershipId|proximity|recordedOffline|photos|totals|familySections|approvedBy|history|email/.test(raw), raw.slice(0, 120));
    const v2 = await call("GET", `${FR(rA)}/${r2.id}`, A.family.token);
    check("V5 a report shared with meals only shows meals only", v2.status === 200 && Object.keys(v2.body.report?.sections ?? {}).join(",") === "meals"
      && !JSON.stringify(v2.body).includes(HYGIENE));
    const vDraft = await call("GET", `${FR(rA)}/${r3.id}`, A.family.token), vSent = await call("GET", `${FR(rA)}/${r4.id}`, A.family.token);
    check("V6 a draft or a report waiting for approval is not found for the family", vDraft.status === 404 && vSent.status === 404, `${vDraft.status}/${vSent.status}`);

    // ------------------------------------------------------------ D: PDF
    const p1 = await pdf(`${FR(rA)}/${r1.id}/pdf`, A.family.token);
    const text = p1.status === 200 ? pdfText(p1.buf) : "";
    check("D1 server PDF: application/pdf, download only, never cached, file name without personal names",
      p1.status === 200 && p1.type === "application/pdf" && /^attachment; filename="informe-de-turno-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.pdf"$/.test(p1.disposition)
      && /no-store/.test(p1.cache) && p1.buf.subarray(0, 5).toString() === "%PDF-" && !/Carmen|Cuidadora/.test(p1.disposition), `${p1.status} ${p1.type} ${p1.disposition} ${p1.cache}`);
    check("D2 PDF identifies the report: id, agency, resident, caregiver, date, schedules, status, approval date",
      text.includes(r1.id) && text.includes(`SR3 A ${tag}`) && text.includes("Doña Carmen") && text.includes("Cuidadora a-cg") && /APROBADO/.test(text)
      && /Fecha de aprobación/i.test(text) && /Programado/i.test(text) && /Inicio/i.test(text), text.slice(0, 200).replace(/\s+/g, " "));
    check("D3 PDF shows exactly the shared sections and texts", text.includes("Desayuno · Casi todo") && text.includes(MEAL_NOTE) && text.includes("Caminata en el patio · 20 min")
      && text.includes(FREE_NOTE) && text.includes(FINAL) && text.includes(SUMMARY) && text.includes(INCIDENT));
    check("D4 PDF never shows withheld sections (hygiene, mood) nor location data", !text.includes(HYGIENE) && !text.includes(MOOD) && !/Higiene|Ánimo|ubicación|proximidad/i.test(text));
    const p2 = await pdf(`${FR(rA)}/${r2.id}/pdf`, A.family.token);
    const text2 = p2.status === 200 ? pdfText(p2.buf) : "";
    check("D5 PDF of the meals-only report: meals only, no schedule box", p2.status === 200 && text2.includes("Almuerzo · Mitad") && !text2.includes(HYGIENE) && !/Programado/.test(text2) && !/Hidratación/.test(text2), text2.replace(/\s+/g, " ").slice(0, 400));
    const events = (await q<{ event_type: string; actor_user_id: string }>(`SELECT event_type, actor_user_id FROM shift_report_events WHERE shift_report_id=$1 AND event_type='PDF_DOWNLOADED'`, [r1.id])).rows;
    const agencyHist = await call("GET", `${SA}/shifts/${s1}/shift-reports`, A.admin.token);
    check("D6 each download is recorded in the report history (who, when) and the agency sees it",
      events.length === 1 && events[0].actor_user_id === A.family.userId && JSON.stringify(agencyHist.body).includes("PDF_DOWNLOADED"), String(events.length));
    const noAuth = await pdf(`${FR(rA)}/${r1.id}/pdf`, "");
    const pDraft = await pdf(`${FR(rA)}/${r3.id}/pdf`, A.family.token);
    check("D7 no public link: without a session 401; a draft's PDF does not exist", noAuth.status === 401 && pDraft.status === 404, `${noAuth.status}/${pDraft.status}`);
    const sample = process.env.SR3_PDF_SAMPLE; if (sample && p1.status === 200) writeFileSync(sample, p1.buf);

    // ------------------------------------------------------------ P: permissions
    const other = [await call("GET", FR(rA), A.otherFamily.token), await call("GET", `${FR(rA)}/${r1.id}`, A.otherFamily.token), await pdf(`${FR(rA)}/${r1.id}/pdf`, A.otherFamily.token)];
    check("P1 a relative of another resident gets nothing (list, view, PDF)", other.every((x) => x.status === 404), other.map((x) => x.status).join("/"));
    const cross = [await call("GET", FR(rA), B.family.token), await call("GET", `/organizations/${orgB}/care-recipients/${rA}/shift-reports/${r1.id}`, B.family.token),
      await pdf(`/organizations/${orgB}/care-recipients/${rA}/shift-reports/${r1.id}/pdf`, B.family.token)];
    check("P2 another agency's relative gets nothing, through either agency's path", cross.every((x) => [403, 404].includes(x.status)), cross.map((x) => x.status).join("/"));
    const staff = [await call("GET", FR(rA), A.admin.token), await call("GET", `${FR(rA)}/${r1.id}`, A.cg.token), await pdf(`${FR(rA)}/${r1.id}/pdf`, A.admin.token)];
    check("P3 staff (admin, caregiver) cannot use the family route", staff.every((x) => x.status === 404), staff.map((x) => x.status).join("/"));
    const beforeRevoke = await call("GET", `${FR(rA)}/${r1.id}`, A.revokedFamily.token);
    await q(`UPDATE family_relationships SET status='revoked', revoked_at=now() WHERE user_id=$1`, [A.revokedFamily.userId]);
    const afterRevoke = [await call("GET", FR(rA), A.revokedFamily.token), await call("GET", `${FR(rA)}/${r1.id}`, A.revokedFamily.token), await pdf(`${FR(rA)}/${r1.id}/pdf`, A.revokedFamily.token)];
    check("P4 a revoked relative can no longer list, view or download earlier reports", beforeRevoke.status === 200 && afterRevoke.every((x) => x.status === 404),
      `${beforeRevoke.status} → ${afterRevoke.map((x) => x.status).join("/")}`);
    await q(`DELETE FROM user_roles WHERE organization_membership_id=$1`, [A.roleLessFamily.orgMembershipId]);
    const roleLess = await pdf(`${FR(rA)}/${r1.id}/pdf`, A.roleLessFamily.token);
    await q(`UPDATE organization_memberships SET status='revoked' WHERE id=$1`, [A.family.orgMembershipId]);
    const memberRevoked = await call("GET", FR(rA), A.family.token);
    await q(`UPDATE organization_memberships SET status='active' WHERE id=$1`, [A.family.orgMembershipId]);
    check("P5 without the FAMILY role or with the agency membership revoked: nothing", roleLess.status === 404 && [403, 404].includes(memberRevoked.status), `${roleLess.status}/${memberRevoked.status}`);
    const rCid = (await q<{ id: string }>(`SELECT id FROM shift_reports WHERE shift_id=$1`, [sC])).rows[0]?.id;
    const off = await call("GET", `/organizations/${orgC}/care-recipients/${rC}/shift-reports`, C.family.token);
    check("P6 SHIFT_REPORTS off: the family route does not exist for that agency", off.status === 404 && off.body.error === "FEATURE_NOT_ENABLED" && !rCid, `${off.status} ${off.body.error}`);
    const famDb = await asRuntime(A.family.userId, orgA, false, async (c) => ({
      r: (await c.query("SELECT count(*)::int AS n FROM shift_reports")).rows[0].n, e: (await c.query("SELECT count(*)::int AS n FROM shift_report_events")).rows[0].n }));
    check("P7 at the database level the family reads no report row and no history row directly", typeof famDb === "object" && famDb.r === 0 && famDb.e === 0, JSON.stringify(famDb));
    const internals = await asRuntime(A.family.userId, orgA, false, async (c) => (await c.query("SELECT app_shift_report_family_project($1)", [r1.id])).rows.length);
    const isMine = await asRuntime(A.family.userId, orgA, false, async (c) => (await c.query("SELECT app_is_my_family_recipient($1)", [rA])).rows.length);
    check("P8 the projection and the authorization helper are not callable directly", /permission denied/.test(String(internals)) && /permission denied/.test(String(isMine)), `${internals}/${isMine}`);
    const plat = (await q<{ id: string }>(`INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id`, [`sr3-plat-${tag}@example.invalid`])).rows[0].id;
    await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [plat]);
    await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [plat, orgA, rA]);
    const platCall = await asRuntime(plat, orgA, true, async (c) => (await c.query("SELECT app_shift_report_family_list($1) AS v", [rA])).rows[0].v);
    const platRows = await asRuntime(plat, orgA, true, async (c) => (await c.query("SELECT count(*)::int AS n FROM shift_reports")).rows[0].n);
    check("P9 ETNARA central gets nothing, even with a family link planted", /SHIFT_REPORT_NOT_FOUND/.test(String(platCall)) && platRows === 0, `${String(platCall).slice(0, 40)}/${platRows}`);

    // ------------------------------------------------------------ Z: integrity and logs
    check("Z1 reading and downloading changed no care record and no report (approved version identical)", (await fingerprint()) === before);
    const pdfEvents = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM shift_report_events WHERE event_type='PDF_DOWNLOADED' AND organization_id=$1`, [orgA])).rows[0].n;
    check("Z2 only successful downloads are recorded (refused ones leave no trace)", pdfEvents === 2, String(pdfEvents));
    const leaked = logged.filter((l) => /Doña Carmen|Avena|domingo|Tropezó|Cuidadora a-cg|Turno tranquilo/.test(l));
    check("Z3 logs contain no names, notes or report text", leaked.length === 0, `líneas=${leaked.length}`);
  } finally {
    server.close();
    await pool.end();
    await db.end();
  }

  const failed = results.filter((r) => !r.pass);
  for (const r of results) out(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
  out(`\nShift reports F3: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) { for (const r of failed) out(`::error title=verifyShiftReportsF3::${r.name} [${r.detail}]`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
