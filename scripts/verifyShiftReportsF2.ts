/**
 * Informe de Turno F2 (migration 128), end to end over HTTP as app_runtime.
 * The draft appears on its own when the visit ends and the caregiver is notified; she
 * reviews ONLY her own reports, adds a final observation and sends it for review within
 * 24 h; the agency sends it back or approves it. Original records never change. Expired
 * windows keep the draft intact for the agency. Synthetic data only.
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
const NOTE1 = "Doña Carmen pidió que la llamen por la tarde.";
const NOTE2 = "Corrijo: pidió que la llamen por la mañana.";

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
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'SR2') RETURNING id`, [id])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
    return id;
  };
  const orgA = await org(`SR2 A ${tag}`, ["SHIFT_REPORTS"]);
  const orgB = await org(`SR2 B ${tag}`, ["SHIFT_REPORTS"]);
  const orgC = await org(`SR2 C ${tag}`, []); // SHIFT_REPORTS off
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
  type P = { email: string; userId: string; token: string; membershipId?: string; orgMembershipId: string; orgId: string };
  async function person(key: string, orgId: string, roles: string[], worker = false): Promise<P> {
    const email = `sr2-${key}-${tag}@example.invalid`;
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
    cg2: await person("a-cg2", orgA, ["WORKER"], true), family: await person("a-fam", orgA, ["FAMILY"]) };
  const B = { cg: await person("b-cg", orgB, ["WORKER"], true) };
  const C = { cg: await person("c-cg", orgC, ["WORKER"], true) };
  const recipient = async (o: string) => (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,preferred_name) VALUES ($1,'Carmen',$2,'Doña Carmen') RETURNING id`, [o, `F2-${tag}`])).rows[0].id;
  const rA = await recipient(orgA), rC = await recipient(orgC);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [A.family.userId, orgA, rA]);
  for (const p of [...Object.values(A), B.cg, C.cg]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${r.status}`);
    p.token = r.body.token;
    await call("POST", "/me/active-organization", p.token, { organizationId: p.orgId });
  }
  const visit = async (o: string, r: string, p: P, care: Array<[string, Json | undefined, string | undefined]>) => {
    const s = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '30 minutes',now()+interval '3 hours','confirmed') RETURNING id`, [o, r])).rows[0].id;
    await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,response_status,responded_at) VALUES ($1,$2,$3,'accepted',now())`, [o, s, p.membershipId]);
    const S = `/organizations/${o}/shifts/${s}`;
    await call("POST", `${S}/check-in`, p.token, { verificationMethodCode: "CAREGIVER_SESSION" });
    for (const [typeCode, payload, noteText] of care) await call("POST", `${S}/care-events`, p.token, { typeCode, careRecipientId: r, ...(payload ? { payload } : {}), ...(noteText ? { noteText } : {}) });
    const out = await call("POST", `${S}/check-out`, p.token, {});
    if (out.status !== 200 && out.status !== 201) throw new Error(`checkout ${out.status}`);
    return s;
  };
  const SA = `/organizations/${orgA}`;
  const fingerprint = async () => (await q<{ h: string }>(`SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
      SELECT 'ce'||ce::text AS x FROM care_events ce WHERE organization_id=$1
      UNION ALL SELECT 've'||ve::text FROM verification_events ve WHERE organization_id=$1
      UNION ALL SELECT 'in'||i::text FROM incidents i WHERE organization_id=$1) t`, [orgA])).rows[0].h;
  async function asRuntime<T>(userId: string, orgId: string, superadmin: boolean, work: (c: pg.Client) => Promise<T>): Promise<T | string> {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`, [userId, orgId, superadmin ? "true" : "false"]);
      return await work(c);
    } catch (e) { return (e as { code?: string }).code ?? "error"; } finally { await c.query("ROLLBACK").catch(() => undefined); await c.end(); }
  }
  const ownerError = async (s: string, p: unknown[] = []) => {
    await q("BEGIN");
    try { await q(s, p); return "allowed"; } catch (e) { return (e as { message?: string }).message ?? "error"; } finally { await q("ROLLBACK"); }
  };

  try {
    // ------------------------------------------------------------ W: automatic draft and notice
    const s1 = await visit(orgA, rA, A.cg, [["MEAL", { mealType: "Desayuno", amountConsumed: "Todo" }, undefined], ["NOTE", undefined, "Estuvo tranquila."]]);
    const s2 = await visit(orgA, rA, A.cg2, [["HYDRATION", { amount: "Poco" }, undefined]]);
    const sC = await visit(orgC, rC, C.cg, [["MEAL", { mealType: "Cena", amountConsumed: "Mitad" }, undefined]]);
    const before = await fingerprint();
    const created = await generatePendingShiftReports();
    const again = await generatePendingShiftReports();
    const r1 = (await q<Json>(`SELECT id, status, review_deadline_at, content FROM shift_reports WHERE shift_id=$1`, [s1])).rows[0];
    const ev1 = (await q<Json>(`SELECT event_type, actor_user_id, details FROM shift_report_events WHERE shift_report_id=$1`, [r1?.id])).rows;
    check("W1 the draft appears on its own when the visit ends (no one opened it); system actor, «automatic»",
      created >= 2 && r1?.status === "DRAFT" && ev1.length === 1 && ev1[0].event_type === "GENERATED" && ev1[0].actor_user_id === null && ev1[0].details.automatic === true,
      `created=${created}`);
    check("W2 running the tick again creates nothing (idempotent)", again === 0, String(again));
    const cDraft = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM shift_reports WHERE shift_id=$1`, [sC])).rows[0].n;
    check("W3 an agency with SHIFT_REPORTS off gets no draft", cDraft === 0, String(cDraft));
    const endAt = (await q<Json>(`SELECT occurred_at FROM verification_events WHERE shift_id=$1 AND event_type='check_out'`, [s1])).rows[0].occurred_at;
    check("W4 the caregiver's window ends exactly 24 h after the real end", new Date(r1.review_deadline_at).getTime() - new Date(endAt).getTime() === 24 * 3600 * 1000);
    const notes = (await call("GET", "/me/notifications?limit=50", A.cg.token)).body.items ?? [];
    const ready = notes.find((n: Json) => n.type === "SHIFT_REPORT_READY" && n.relatedEntityId === r1.id);
    const cg2Notes = (await call("GET", "/me/notifications?limit=50", A.cg2.token)).body.items ?? [];
    check("W5 the caregiver gets an in-portal notice for HER report only", Boolean(ready) && !cg2Notes.some((n: Json) => n.relatedEntityId === r1.id)
      && /listo para revisar/.test(ready?.summary ?? ""), ready?.summary ?? "none");

    // ------------------------------------------------------------ C: caregiver reads only her own
    const mine = await call("GET", `${SA}/me/shift-reports`, A.cg.token);
    const r2id = (await q<Json>(`SELECT id FROM shift_reports WHERE shift_id=$1`, [s2])).rows[0].id;
    check("C1 «Mis informes» lists only her own reports", mine.status === 200 && mine.body.reports?.length === 1 && mine.body.reports[0].id === r1.id, JSON.stringify(mine.body).slice(0, 80));
    const own = await call("GET", `${SA}/me/shift-reports/${r1.id}`, A.cg.token);
    check("C2 she opens her report after the service ended: her records, editable, deadline shown",
      own.status === 200 && own.body.report?.canEdit === true && own.body.report?.content?.sections?.meals?.length === 1
      && own.body.report?.reviewDeadlineAt === new Date(r1.review_deadline_at).toISOString() && !("familySections" in own.body.report) && !("agencySummary" in own.body.report));
    const other = await call("GET", `${SA}/me/shift-reports/${r2id}`, A.cg.token);
    const otherAgency = await call("GET", `/organizations/${orgB}/me/shift-reports/${r1.id}`, B.cg.token);
    const family = await call("GET", `${SA}/me/shift-reports/${r1.id}`, A.family.token);
    const famList = await call("GET", `${SA}/me/shift-reports`, A.family.token);
    const dbOther = await asRuntime(A.cg.userId, orgA, false, async (c) => (await c.query("SELECT count(*)::int AS n FROM shift_reports WHERE id=$1", [r2id])).rows[0].n);
    const dbB = await asRuntime(B.cg.userId, orgB, false, async (c) => (await c.query("SELECT count(*)::int AS n FROM shift_reports")).rows[0].n);
    check("C3 another caregiver's report, another agency and a relative: nothing (404 / empty / 0 rows)",
      other.status === 404 && otherAgency.status === 404 && family.status === 404 && famList.body.reports?.length === 0 && dbOther === 0 && dbB === 0,
      `${other.status}/${otherAgency.status}/${family.status}/${famList.body.reports?.length}/${dbOther}/${dbB}`);

    // ------------------------------------------------------------ O: observation and submission
    const o1 = await call("POST", `${SA}/me/shift-reports/${r1.id}/observation`, A.cg.token, { text: NOTE1 });
    const o2 = await call("POST", `${SA}/me/shift-reports/${r1.id}/observation`, A.cg.token, { text: NOTE2 });
    const hist = (await q<Json>(`SELECT note FROM shift_report_events WHERE shift_report_id=$1 AND event_type='OBSERVATION_ADDED' ORDER BY created_at`, [r1.id])).rows;
    const contentNow = (await q<Json>(`SELECT content FROM shift_reports WHERE id=$1`, [r1.id])).rows[0].content;
    check("O1 final observation: the latest is shown, every version kept in the history",
      o1.status === 200 && o2.status === 200 && o2.body.report?.caregiverNote === NOTE2 && hist.length === 2 && hist[0].note === NOTE1 && hist[1].note === NOTE2);
    check("O2 the observation never edits her records nor the snapshot", JSON.stringify(contentNow) === JSON.stringify(r1.content) && (await fingerprint()) === before);
    const empty = await call("POST", `${SA}/me/shift-reports/${r1.id}/observation`, A.cg.token, { text: "   " });
    const tooLong = await call("POST", `${SA}/me/shift-reports/${r1.id}/observation`, A.cg.token, { text: "x".repeat(1001) });
    const otherObs = await call("POST", `${SA}/me/shift-reports/${r2id}/observation`, A.cg.token, { text: "intrusa" });
    check("O3 empty / too long / someone else's report are refused", empty.status === 400 && tooLong.status === 400 && otherObs.status === 404, `${empty.status}/${tooLong.status}/${otherObs.status}`);
    const sub = await call("POST", `${SA}/me/shift-reports/${r1.id}/submit`, A.cg.token);
    const afterSub = await call("POST", `${SA}/me/shift-reports/${r1.id}/observation`, A.cg.token, { text: "otra" });
    check("O4 «Enviar a revisión»: SUBMITTED, no more edits", sub.status === 200 && sub.body.report?.status === "SUBMITTED" && sub.body.report?.canEdit === false
      && afterSub.status === 409, `${sub.status}/${afterSub.status}`);
    const pending = await call("GET", `${SA}/shift-reports?status=PENDING`, A.admin.token);
    const first = pending.body.reports?.[0];
    check("O5 the agency's «Por aprobar» shows it first, with the caregiver's observation", pending.status === 200 && first?.id === r1.id && first?.status === "SUBMITTED" && first?.hasCaregiverNote === true);
    const agencyView = (await call("GET", `${SA}/shifts/${s1}/shift-reports`, A.admin.token)).body.reports?.[0];
    check("O6 the agency sees the observation and the history (observations, submission)",
      agencyView?.caregiverNote === NOTE2 && agencyView?.history?.map((h: Json) => h.type).join(",") === "GENERATED,OBSERVATION_ADDED,OBSERVATION_ADDED,SUBMITTED");
    const refreshSubmitted = await call("POST", `${SA}/shift-reports/${r1.id}/refresh`, A.admin.token);
    check("O7 a submitted report is not rebuilt (it is what she reviewed)", refreshSubmitted.status === 409 && refreshSubmitted.body.error === "SHIFT_REPORT_NOT_DRAFT");

    // ------------------------------------------------------------ R: return and approval
    const noNote = await call("POST", `${SA}/shift-reports/${r1.id}/return`, A.admin.token, { note: " " });
    const cgReturn = await call("POST", `${SA}/shift-reports/${r1.id}/return`, A.cg.token, { note: "x" });
    const ret = await call("POST", `${SA}/shift-reports/${r1.id}/return`, A.admin.token, { note: "Falta indicar si tomó la merienda." });
    const retNotice = ((await call("GET", "/me/notifications?limit=50", A.cg.token)).body.items ?? []).find((n: Json) => n.type === "SHIFT_REPORT_RETURNED" && n.relatedEntityId === r1.id);
    const ownAfterReturn = await call("GET", `${SA}/me/shift-reports/${r1.id}`, A.cg.token);
    check("R1 «Devolver» needs a note and a reviewer; RETURNED; she is notified and reads the note; she can edit again",
      noNote.status === 400 && cgReturn.status === 403 && ret.status === 200 && ret.body.report?.status === "RETURNED" && Boolean(retNotice)
      && ownAfterReturn.body.report?.canEdit === true && ownAfterReturn.body.report?.history?.some((h: Json) => h.type === "RETURNED" && /merienda/.test(h.note ?? "")),
      `${noNote.status}/${cgReturn.status}/${ret.status}`);
    const resub = await call("POST", `${SA}/me/shift-reports/${r1.id}/submit`, A.cg.token);
    check("R2 she sends it again within her window", resub.status === 200 && resub.body.report?.status === "SUBMITTED");
    const cgApprove = await call("POST", `${SA}/shift-reports/${r1.id}/approve`, A.cg.token, { expectedGeneratedAt: agencyView?.generatedAt });
    const cgDbApprove = await asRuntime(A.cg.userId, orgA, false, async (c) => (await c.query(
      `UPDATE shift_reports SET status='APPROVED', approved_at=now(), approved_by_user_id=$1, family_sections='{}' WHERE id=$2`, [A.cg.userId, r1.id])).rowCount);
    const cgFn = await asRuntime(A.cg.userId, orgA, false, async (c) => { await c.query("SELECT app_shift_report_refresh($1::uuid)", [r1.id]); return "allowed"; });
    const builder = await asRuntime(A.cg.userId, orgA, false, async (c) => { await c.query("SELECT app_shift_report_build_content($1::uuid,$2::uuid,$3::uuid)", [orgA, s2, A.cg2.membershipId]); return "allowed"; });
    check("R3 she can never approve: API 403, database 0 rows updated, agency functions refused, builder not executable",
      cgApprove.status === 403 && (cgDbApprove === 0 || cgDbApprove === "42501") && cgFn === "42501" && builder === "42501",
      `${cgApprove.status}/${cgDbApprove}/${cgFn}/${builder}`);
    const approve = await call("POST", `${SA}/shift-reports/${r1.id}/approve`, A.admin.token, { expectedGeneratedAt: agencyView?.generatedAt });
    const ownApproved = await call("GET", `${SA}/me/shift-reports/${r1.id}`, A.cg.token);
    const obsApproved = await call("POST", `${SA}/me/shift-reports/${r1.id}/observation`, A.cg.token, { text: "tarde" });
    const ownerEdit = await ownerError(`UPDATE shift_reports SET caregiver_note='cambio' WHERE id=$1`, [r1.id]);
    check("R4 the agency approves the submitted report; she still reads it, cannot change it; immutable for the owner too",
      approve.status === 200 && approve.body.report?.status === "APPROVED" && ownApproved.body.report?.status === "APPROVED" && ownApproved.body.report?.canEdit === false
      && obsApproved.status === 409 && /APPROVED_IMMUTABLE/.test(ownerEdit), `${approve.status} ${approve.body.error ?? ""}/${obsApproved.status}`);

    // ------------------------------------------------------------ X: window expired without submission
    await q(`UPDATE shift_reports SET review_deadline_at = now() - interval '1 minute' WHERE id=$1`, [r2id]);
    const lateSubmit = await call("POST", `${SA}/me/shift-reports/${r2id}/submit`, A.cg2.token);
    const lateObs = await call("POST", `${SA}/me/shift-reports/${r2id}/observation`, A.cg2.token, { text: "tarde" });
    const expired = ((await call("GET", `${SA}/shift-reports?status=PENDING`, A.admin.token)).body.reports ?? []).find((r: Json) => r.id === r2id);
    const r2 = (await q<Json>(`SELECT status, content FROM shift_reports WHERE id=$1`, [r2id])).rows[0];
    check("X1 after 24 h: she can no longer send or annotate; the draft stays DRAFT and unchanged; the agency sees «plazo vencido»",
      lateSubmit.status === 409 && lateSubmit.body.error === "SHIFT_REPORT_WINDOW_CLOSED" && lateObs.status === 409 && r2.status === "DRAFT"
      && expired?.caregiverWindowExpired === true, `${lateSubmit.status}/${lateObs.status}/${r2.status}/${expired?.caregiverWindowExpired}`);
    const s2view = (await call("GET", `${SA}/shifts/${s2}/shift-reports`, A.admin.token)).body.reports?.[0];
    const approveExpired = await call("POST", `${SA}/shift-reports/${r2id}/approve`, A.admin.token, { expectedGeneratedAt: s2view?.generatedAt });
    check("X2 the agency can still review and approve an expired draft (nothing lost)", approveExpired.status === 200 && approveExpired.body.report?.content?.sections?.hydration?.length === 1);

    // ------------------------------------------------------------ V: revocation
    const s3 = await visit(orgA, rA, A.cg, [["MOOD", { mood: "Contenta" }, undefined]]);
    await generatePendingShiftReports();
    const r3id = (await q<Json>(`SELECT id FROM shift_reports WHERE shift_id=$1`, [s3])).rows[0].id;
    await q(`UPDATE shifts SET status='completed' WHERE id=$1`, [s3]);
    await q(`UPDATE organization_memberships SET status='revoked' WHERE id=$1`, [A.cg.orgMembershipId]);
    const revoked = await call("GET", `${SA}/me/shift-reports/${r3id}`, A.cg.token);
    const revokedDb = await asRuntime(A.cg.userId, orgA, false, async (c) => (await c.query("SELECT count(*)::int AS n FROM shift_reports WHERE organization_id=$1", [orgA])).rows[0].n);
    check("V1 a caregiver removed from the agency loses access to her past reports", [403, 404].includes(revoked.status) && revokedDb === 0, `${revoked.status}/${revokedDb}`);
    const plat = (await q<{ id: string }>(`INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id`, [`sr2-plat-${tag}@example.invalid`])).rows[0].id;
    await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [plat]);
    const platDb = await asRuntime(plat, orgA, true, async (c) => (await c.query("SELECT count(*)::int AS n FROM shift_reports")).rows[0].n);
    check("V2 ETNARA central reads no report", platDb === 0, String(platDb));

    // ------------------------------------------------------------ Z: integrity and logs
    const careNow = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM care_events WHERE shift_id = ANY($1)`, [[s1, s2]])).rows[0].n;
    check("Z1 original care records untouched by the whole flow", careNow === 3);
    const leaked = logged.filter((l) => /Doña Carmen|merienda|llamen por|Estuvo tranquila/.test(l));
    check("Z2 logs contain no observation, note or name", leaked.length === 0, `líneas=${leaked.length}`);
  } finally {
    server.close();
    await pool.end();
    await db.end();
  }

  const failed = results.filter((r) => !r.pass);
  for (const r of results) out(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
  out(`\nShift reports F2: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) { for (const r of failed) out(`::error title=verifyShiftReportsF2::${r.name} [${r.detail}]`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
