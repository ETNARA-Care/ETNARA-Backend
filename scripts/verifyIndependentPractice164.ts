/**
 * 164 · Cuidador independiente, Fase 1. 25-nov-2026.
 * Datos FICTICIOS, base PROPIA desechable, ningún correo real (Resend interceptado). App real por HTTP como app_runtime.
 * Cubre: «De camino» e Informe del proveedor encendidos al crear una práctica (agencias y hogares no); la invitación
 * dice si es de una práctica; nombre profesional obligatorio al activar una cuenta nueva de práctica (la agencia no);
 * sin avisos a sí misma en una práctica (la familia sigue recibiendo los suyos; la agencia, igual que antes); la llegada
 * «sin ubicación» en una práctica queda cerrada con nota (en la agencia sigue pendiente de revisión); reversión.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import pg from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const serverUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!serverUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(serverUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });

const mails: Array<{ to: string; html: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) {
    const b = JSON.parse(String(init?.body ?? "{}"));
    mails.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, html: String(b.html ?? "") });
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (!/^https?:\/\/127\.0\.0\.1:/.test(url)) throw new Error(`Salida de red bloqueada en la prueba: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";
process.env.EMAIL_SENDER_ADDRESS ??= "pruebas@example.invalid";
process.env.ACTIVATION_BASE_URL ??= "https://portal.example.invalid";

const SELF_TYPES = ["SHIFT_ASSIGNMENT_PENDING", "SHIFT_ASSIGNMENT_ACCEPTED", "SHIFT_ASSIGNMENT_REJECTED", "SHIFT_STARTED", "SHIFT_COMPLETED", "SHIFT_CANCELLED",
  "SHIFT_UNASSIGNED", "SHIFT_RESCHEDULED", "SHIFT_LOCATION_CHANGED", "SHIFT_NOT_EN_ROUTE", "SHIFT_DELAY_REPORTED", "SHIFT_LATE_ARRIVAL", "SHIFT_ARRIVAL_NEEDS_REVIEW",
  "TIMESHEET_NEEDS_REVIEW", "NEW_INCIDENT", "NEW_CARE_EVENT", "CREDENTIAL_REVIEW_PENDING", "SHIFT_REPORT_READY", "OPEN_SHIFT_OFFER"];

async function main() {
  const own = `etnara_m164_${randomBytes(4).toString("hex")}`;
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  await srv.query(`CREATE DATABASE ${own}`);
  const ownUrl = new URL(serverUrl!); ownUrl.pathname = `/${own}`; const adminUrl = ownUrl.toString();
  { const m = new pg.Client({ connectionString: adminUrl }); await m.connect(); const log = console.log; console.log = () => undefined;
    try { await applyPendingMigrations(m, join(process.cwd(), "migrations")); } finally { console.log = log; await m.end(); } }
  const db = new pg.Client({ connectionString: adminUrl }); await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toLowerCase();
  const errors500: string[] = [];
  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await realFetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    let json: Json = {}; try { json = JSON.parse(await res.text()); } catch { /* vacío */ }
    if (res.status >= 500) errors500.push(`${method} ${path} ${res.status}`);
    return { status: res.status, body: json };
  }
  const user = async (key: string) => { const email = `m164-${key}-${tag}@example.invalid`;
    return { email, id: (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id }; };
  const login = async (email: string, o?: string) => { const t = (await call("POST", "/auth/login", "", { email, password })).body.token as string;
    if (o) await call("POST", "/me/active-organization", t, { organizationId: o }); return t; };
  const tokenFor = (email: string) => { const m = [...mails].reverse().find((x) => x.to === email); return /token=([a-f0-9]{64})/i.exec(m?.html ?? "")?.[1] ?? ""; };
  const at = (min: number) => { const d = new Date(Date.now() + min * 60_000); d.setUTCSeconds(0, 0); return d.toISOString(); };
  const notes = async (userId: string, org: string) => (await q<{ t: string }>(`SELECT notification_type t FROM notifications WHERE user_id=$1 AND organization_id=$2`, [userId, org])).rows.map((r) => r.t);
  const features = async (org: string) => (await q<{ c: string; e: boolean }>(`SELECT feature_code c, enabled e FROM organization_features WHERE organization_id=$1 ORDER BY 1`, [org])).rows;

  try {
    const central = await user("central"); await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.id]);
    const tC = await login(central.email);
    // Modalidad encendida SOLO en esta base desechable (autorización de operación + bandera), como en la 163.
    await q(`SELECT app_ops_authorize_modality_activation('INDEPENDENT_PROVIDER','Prueba 164','Prueba ficticia de la Fase 1 (164)',5)`);
    await q(`UPDATE platform_modalities SET enabled=true WHERE code='INDEPENDENT_PROVIDER'`);

    // ---------------------------------------------------------------- 1. Valores por defecto al crear
    const P = (await call("POST", "/platform/organizations", tC, { name: `Práctica Ficticia ${tag}`, organizationType: "INDEPENDENT_PROVIDER" })).body.organization.id as string;
    const A = (await call("POST", "/platform/organizations", tC, { name: `Agencia Ficticia ${tag}`, organizationType: "HOME_CARE_AGENCY" })).body.organization.id as string;
    const H = (await call("POST", "/platform/organizations", tC, { name: `Hogar Ficticio ${tag}`, organizationType: "RESIDENTIAL_CARE_HOME" })).body.organization.id as string;
    const fP = await features(P), fA = await features(A), fH = await features(H);
    const evP = (await q<{ c: string; r: string; a: string }>(`SELECT feature_code c, reason r, actor_user_id a FROM organization_feature_events WHERE organization_id=$1 ORDER BY 1`, [P])).rows;
    check("F1. Una práctica nace con «De camino» (EN_CAMINO) e Informe del proveedor (SHIFT_REPORTS) encendidos, con motivo y autor en el historial",
      JSON.stringify(fP) === JSON.stringify([{ c: "EN_CAMINO", e: true }, { c: "SHIFT_REPORTS", e: true }]) && evP.length === 2 && evP.every((e) => /por defecto/.test(e.r) && e.a === central.id), { fP, evP });
    check("F2. Agencias y hogares nuevos siguen sin interruptores encendidos", fA.length === 0 && fH.length === 0, { fA, fH });
    const view = (await call("GET", `/platform/organizations/${P}/features`, tC)).body;
    check("F3. Central los ve encendidos y puede apagarlos como cualquier otro (motivo)",
      (view.features ?? []).filter((f: Json) => f.enabled).length === 2 && (await call("PUT", `/platform/organizations/${P}/features/EN_CAMINO`, tC, { enabled: false, reason: "Prueba de apagado" })).status === 200
      && (await call("PUT", `/platform/organizations/${P}/features/EN_CAMINO`, tC, { enabled: true, reason: "Prueba de encendido" })).status === 200, view);

    // ---------------------------------------------------------------- 2. Invitación y nombre profesional
    const pEmail = `m164-practica-${tag}@example.invalid`, aEmail = `m164-agencia-${tag}@example.invalid`;
    await call("POST", `/platform/organizations/${P}/admin-invitations`, tC, { email: pEmail });
    await call("POST", `/platform/organizations/${A}/admin-invitations`, tC, { email: aEmail });
    const insP = await call("GET", `/platform/admin-invitations/inspect?token=${tokenFor(pEmail)}`, "");
    const insA = await call("GET", `/platform/admin-invitations/inspect?token=${tokenFor(aEmail)}`, "");
    check("N1. La invitación dice si es de una práctica (y solo eso)", insP.body.invitation?.independent === true && insA.body.invitation?.independent === false, [insP.body, insA.body]);
    const noName = await call("POST", "/platform/admin-invitations/activate", "", { token: tokenFor(pEmail), password });
    const pending = (await q<{ s: string }>(`SELECT status::text s FROM access_invitations WHERE organization_id=$1`, [P])).rows[0]?.s;
    check("N2. Activar una práctica sin nombre profesional → 400 PROFESSIONAL_NAME_REQUIRED; la invitación sigue pendiente y no se crea la cuenta",
      noName.status === 400 && noName.body.error === "PROFESSIONAL_NAME_REQUIRED" && pending === "pending" && (await q(`SELECT 1 FROM users WHERE email=$1`, [pEmail])).rowCount === 0, [noName, pending]);
    const okP = await call("POST", "/platform/admin-invitations/activate", "", { token: tokenFor(pEmail), password, professionalName: "  Lucía Ficticia  " });
    const okA = await call("POST", "/platform/admin-invitations/activate", "", { token: tokenFor(aEmail), password });
    const pUser = (await q<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [pEmail])).rows[0]?.id;
    const dn = (await q<{ n: string | null }>(`SELECT w.display_name n FROM workers w WHERE w.user_id=$1`, [pUser])).rows[0]?.n;
    const aud = (await q(`SELECT 1 FROM audit_log WHERE actor_user_id=$1 AND action='PRACTICE_PROFESSIONAL_NAME_SET'`, [pUser])).rowCount;
    check("N3. Con nombre profesional se activa; queda como nombre de su perfil (sin espacios) y en la auditoría; la agencia activa como siempre, sin nombre",
      okP.status === 201 && okA.status === 201 && dn === "Lucía Ficticia" && aud === 1, [okP.status, okA.status, dn, aud]);

    // ---------------------------------------------------------------- 3. Sin avisos a sí misma (práctica) · agencia igual que antes
    const tP = await login(pEmail, P), tA = await login(aEmail, A);
    // Práctica: cliente, familia, turno con «Asignármelo», llegada sin ubicación, inicio, registro, incidente y fin.
    const cP = (await call("POST", `/organizations/${P}/care-recipients`, tP, { firstName: "Carmen", lastName: "Ficticia" })).body;
    const cPid = (cP.careRecipient ?? cP.recipient ?? cP).id as string;
    const fam = await call("POST", `/organizations/${P}/access-invitations`, tP, { type: "family", email: `m164-familia-${tag}@example.invalid`, careRecipientId: cPid, relationshipType: "hija" });
    await call("POST", "/access-invitations/activate", "", { token: fam.body.token, password });
    const famUser = (await q<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [`m164-familia-${tag}@example.invalid`])).rows[0].id;
    const sP = (await call("POST", `/organizations/${P}/shifts`, tP, { careRecipientId: cPid, scheduledStart: at(5), scheduledEnd: at(65) })).body.shift.id as string;
    const sa = await call("POST", `/organizations/${P}/me/shifts/${sP}/self-assign`, tP, {});
    const arrP = await call("POST", `/organizations/${P}/shifts/${sP}/arrival`, tP, { clientEventId: randomUUID() });
    const ciP = await call("POST", `/organizations/${P}/shifts/${sP}/check-in`, tP, { verificationMethodCode: "CAREGIVER_SESSION" });
    const evtP = await call("POST", `/organizations/${P}/shifts/${sP}/care-events`, tP, { typeCode: "MEAL", careRecipientId: cPid, payload: { mealType: "Almuerzo", amountConsumed: "Mitad" } });
    const coP = await call("POST", `/organizations/${P}/shifts/${sP}/check-out`, tP, {});
    const opNotes = await notes(pUser, P), famNotes = await notes(famUser, P);
    const selfP = opNotes.filter((t) => SELF_TYPES.includes(t));
    check("S1. Práctica: turno con «Asignármelo», llegada, inicio, registro y fin funcionan (sin errores)",
      [sa.status, arrP.status, ciP.status, evtP.status, coP.status].every((s) => s === 200 || s === 201), [sa.status, sa.body.error, arrP.status, arrP.body.error, ciP.status, evtP.status, coP.status]);
    check("S2. Práctica: la cuidadora no recibe ningún aviso de gestión ni de turno sobre sí misma", selfP.length === 0, opNotes);
    check("S3. Práctica: la familia sigue recibiendo sus avisos (llegó, actividad, servicio iniciado/finalizado)", famNotes.length >= 2 && famNotes.some((t) => t.startsWith("FAMILY_") || t === "NEW_CARE_EVENT" || t === "SHIFT_STARTED"), famNotes);

    // Agencia de control: mismo recorrido con una cuidadora; la administración recibe sus avisos como antes.
    await call("PUT", `/platform/organizations/${A}/features/EN_CAMINO`, tC, { enabled: true, reason: "Prueba de control" });
    const cg = await user("cuidadora-agencia");
    const mem = (await call("POST", `/organizations/${A}/workers`, tA, { displayName: "Ana Ficticia", internalRole: "CNA" })).body.membership.id as string;
    const inv = await call("POST", `/organizations/${A}/access-invitations`, tA, { type: "worker", email: `m164-cg2-${tag}@example.invalid`, workerMembershipId: mem });
    const actCg = await call("POST", "/access-invitations/activate", "", { token: inv.body.token, password });
    void cg;
    const tCg = await login(`m164-cg2-${tag}@example.invalid`, A);
    // Elegibilidad de agencia (igual que verifyGate7Journey): requisito BLS sin revisión, credencial vigente y disponibilidad.
    const bls = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code='BLS'`)).rows[0].id;
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'M164') RETURNING id`, [A])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
    const wId = (await q<{ w: string }>(`SELECT worker_id w FROM organization_worker_memberships WHERE id=$1`, [mem])).rows[0].w;
    await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [wId, bls]);
    await q(`INSERT INTO worker_availability_settings (organization_worker_membership_id,organization_id,timezone) VALUES ($1,$2,'America/Puerto_Rico')`, [mem, A]);
    for (let d = 0; d < 7; d++) await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,$3,'00:00','23:59')`, [mem, A, d]);
    const cA = (await call("POST", `/organizations/${A}/care-recipients`, tA, { firstName: "Pedro", lastName: "Ficticio" })).body;
    const cAid = (cA.careRecipient ?? cA.recipient ?? cA).id as string;
    const sA = (await call("POST", `/organizations/${A}/shifts`, tA, { careRecipientId: cAid, scheduledStart: at(5), scheduledEnd: at(65) })).body.shift.id as string;
    const asgA = await call("POST", `/organizations/${A}/shifts/${sA}/assignments`, tA, { organizationWorkerMembershipId: mem });
    const rspA = await call("POST", `/organizations/${A}/me/shifts/${sA}/respond`, tCg, { decision: "accepted" });
    const arrA = await call("POST", `/organizations/${A}/shifts/${sA}/arrival`, tCg, { clientEventId: randomUUID() });
    await call("POST", `/organizations/${A}/shifts/${sA}/check-in`, tCg, { verificationMethodCode: "CAREGIVER_SESSION" });
    const aUser = (await q<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [aEmail])).rows[0].id;
    const adminNotes = await notes(aUser, A);
    check("S4. Agencia (control): la administración sigue recibiendo «aceptó», «llegada en revisión» e «inició»",
      ["SHIFT_ASSIGNMENT_ACCEPTED", "SHIFT_ARRIVAL_NEEDS_REVIEW", "SHIFT_STARTED"].every((t) => adminNotes.includes(t)), { adminNotes, inv: [inv.status, inv.body.error], act: [actCg.status, actCg.body.error], asg: [asgA.status, asgA.body.error], rsp: [rspA.status, rspA.body.error], arr: [arrA.status, arrA.body.error], tCg: !!tCg });

    // Directo en la base: solo se filtra a la propia persona de una práctica y solo los tipos de la lista.
    const ins = async (uid: string, org: string, type: string) => (await q(`INSERT INTO notifications (user_id, organization_id, notification_type, channel, status) VALUES ($1,$2,$3,'in_app','sent') RETURNING id`, [uid, org, type])).rowCount;
    const d1 = await ins(pUser, P, "SHIFT_STARTED"), d2 = await ins(pUser, P, "NEW_MESSAGE"), d3 = await ins(pUser, P, "CREDENTIAL_EXPIRING"), d4 = await ins(famUser, P, "SHIFT_STARTED"), d5 = await ins(aUser, A, "SHIFT_STARTED");
    check("S5. En la base: se descarta solo el aviso de gestión a la propia persona de la práctica; mensajes, vencimientos, familia y agencia se guardan",
      d1 === 0 && d2 === 1 && d3 === 1 && d4 === 1 && d5 === 1, [d1, d2, d3, d4, d5]);

    // ---------------------------------------------------------------- 4. Llegada sin revisión de otra persona
    const arrRowP = (await q<Json>(`SELECT proximity, needs_review, reviewed_at IS NOT NULL AS closed, reviewed_by_user_id, review_note FROM shift_arrivals WHERE shift_id=$1`, [sP])).rows[0];
    const arrRowA = (await q<Json>(`SELECT proximity, needs_review, reviewed_at IS NOT NULL AS closed FROM shift_arrivals WHERE shift_id=$1`, [sA])).rows[0];
    check("L1. Práctica: la llegada sin ubicación conserva el dato real (needs_review) y queda cerrada con su nota; nadie más debe revisarla",
      arrP.status === 201 && arrRowP?.needs_review === true && arrRowP?.closed === true && arrRowP?.reviewed_by_user_id === pUser && /no requiere revisión/.test(arrRowP?.review_note ?? ""), arrRowP);
    check("L2. Agencia (control): la misma llegada sigue pendiente de revisión de la administración", arrA.status === 201 && arrRowA?.needs_review === true && arrRowA?.closed === false, arrRowA);
    const reviewA = await call("POST", `/organizations/${A}/shifts/${sA}/arrival/review`, tA, { membershipId: mem, note: "Revisada por la administración (prueba)" });
    check("L3. Agencia: la administración la revisa como siempre", reviewA.status === 200, reviewA);

    // ---------------------------------------------------------------- 5. Sin errores 500
    check("E1. Ninguna respuesta 500", errors500.length === 0, errors500);

    // ---------------------------------------------------------------- 6. Reversión y reaplicación
    const rollback = readFileSync(join(process.cwd(), "ops/164_independent_practice_phase1.rollback.sql"), "utf8");
    await q(rollback);
    const gone = (await q(`SELECT 1 FROM pg_proc WHERE proname IN ('app_notification_independent_self_filter','app_shift_arrival_independent_close','app_org_admin_invitation_is_independent')`)).rowCount;
    const unreg = (await q(`SELECT 1 FROM schema_migrations WHERE filename='164_independent_practice_phase1.sql'`)).rowCount;
    const d6 = await ins(pUser, P, "SHIFT_STARTED");
    check("R1. La reversión retira las tres funciones y sus disparadores y desregistra la 164 (sin el filtro, el aviso vuelve a crearse)", gone === 0 && unreg === 0 && d6 === 1, [gone, unreg, d6]);
    { const log = console.log; console.log = () => undefined; try { await applyPendingMigrations(db, join(process.cwd(), "migrations")); } finally { console.log = log; } }
    const back = (await q(`SELECT 1 FROM pg_proc WHERE proname IN ('app_notification_independent_self_filter','app_shift_arrival_independent_close','app_org_admin_invitation_is_independent')`)).rowCount;
    check("R2. Se vuelve a aplicar limpia", back === 3 && (await ins(pUser, P, "SHIFT_STARTED")) === 0, back);
  } finally {
    server.close(); await pool.end(); await db.end(); await srv.query(`DROP DATABASE ${own} WITH (FORCE)`); await srv.end();
  }
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 600)}`}`);
  console.log(`\n164: ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
