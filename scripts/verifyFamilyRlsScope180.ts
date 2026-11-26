/**
 * 180 · Seguridad: alcance de la familia en la RLS (agencias, independientes y hogares). Autorizado por Rafa el 26-nov.
 * Datos FICTICIOS, base PROPIA desechable, app conectada como app_runtime (como producción).
 * Comprueba, por modalidad:
 *  - RLS del usuario solo-familia: solo su usuario; del personal, solo quien atiende a su familiar o registró sus
 *    actividades (con sus credenciales); solo turnos y asignaciones de su familiar; nada de disponibilidad.
 *  - Lo que su portal usa sigue igual: turnos con el cuidador asignado y su credencial verificada, historial con
 *    autor, conversación con la administración y el cuidador en su ventana (agencia), incidentes de su familiar.
 *  - Ninguna ruta GET devuelve marcas del personal ajeno, la administración u otro residente.
 *  - Varios roles y organizaciones: familia y personal a la vez conserva lo del personal; familia en una organización y
 *    administración en otra conserva todo en la otra; administración y personal sin pérdida.
 *  - Funciones SECURITY DEFINER: solo dicen sí/no, no dan datos, falsas sin contexto y para quien no es familia.
 *  - Nunca un 500.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";
import { join } from "node:path";

const serverUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!serverUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(serverUrl)) throw new Error("Hosted database refused");
process.env.RESEND_API_KEY ??= "test-only-not-a-key";
process.env.EMAIL_SENDER_ADDRESS ??= "pruebas@example.invalid";
process.env.ACTIVATION_BASE_URL ??= "https://portal.example.invalid";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) return new Response(JSON.stringify({ id: randomUUID() }), { status: 200 });
  if (!/^https?:\/\/127\.0\.0\.1:/.test(url)) throw new Error(`Salida de red bloqueada: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;

async function main() {
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  const dbName = `etnara_f180_${randomBytes(4).toString("hex")}`;
  await srv.query(`CREATE DATABASE ${dbName}`);
  const su = new URL(serverUrl!); su.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: su.toString() }); await db.connect();
  { const log = console.log; console.log = () => undefined; try { await applyPendingMigrations(db, join(process.cwd(), "migrations")); } finally { console.log = log; } }
  const q = async (s: string, p: unknown[] = []) => (await db.query(s, p)).rows;
  const pw = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${pw}'`);
  const rt = new URL(su.toString()); rt.username = "app_runtime"; rt.password = pw;
  process.env.DATABASE_URL = rt.toString();
  const rtc = new pg.Client({ connectionString: rt.toString() }); await rtc.connect();
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  await q(`SELECT app_ops_authorize_modality_activation('INDEPENDENT_PROVIDER','Investigación de exposición','Prueba ficticia de exposición a la familia',5)`);
  await q(`UPDATE platform_modalities SET enabled=true WHERE code='INDEPENDENT_PROVIDER'`);
  const password = randomBytes(18).toString("hex"), hash = await hashPassword(password);
  const bls = (await q(`SELECT id FROM credential_types ORDER BY code LIMIT 1`))[0].id;
  const server = createApp().listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const routes: { method: string; path: string }[] = [];
  const walk = (stack: any[]) => { for (const l of stack ?? []) { if (l.route) for (const m of Object.keys(l.route.methods)) { if (typeof l.route.path === "string") routes.push({ method: m.toUpperCase(), path: l.route.path }); } else if (l.handle?.stack) walk(l.handle.stack); } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  walk((createApp() as any).router?.stack ?? (createApp() as any)._router?.stack); // eslint-disable-line @typescript-eslint/no-explicit-any
  const gets = routes.filter((r) => r.method === "GET" && (r.path.startsWith("/organizations/:organizationId") || r.path.startsWith("/me")));


  const results: { check: string; pass: boolean; detail: string }[] = [];
  const check = (c: string, pass: boolean, detail: unknown = "") => results.push({ check: c, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  const errors500: string[] = [];
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await realFetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json: any = {}; try { json = JSON.parse(text); } catch { /* */ } // eslint-disable-line @typescript-eslint/no-explicit-any
    if (res.status >= 500) errors500.push(`${method} ${path} ${res.status}`);
    return { status: res.status, body: json, text };
  };
  const loginAs = async (email: string, org: string) => {
    const t = (await (await realFetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })).json() as { token: string }).token;
    await call("POST", "/me/active-organization", t, { organizationId: org });
    return t;
  };
  const asUser = async (userId: string, org: string, s: string, args: unknown[] = []) => {
    await rtc.query("BEGIN");
    await rtc.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin','false',true)`, [userId, org]);
    try { return (await rtc.query(s, args)).rows; } catch (e) { return [{ error: (e as Error).message.slice(0, 80) }]; } finally { await rtc.query("ROLLBACK"); }
  };
  const count = async (u: string, o: string, t: string, where = "") => Number((await asUser(u, o, `SELECT count(*)::int AS n FROM ${t} ${where}`))[0]?.n ?? -1);

  const orgs: Record<string, string> = {};
  for (const type of ["HOME_CARE_AGENCY", "INDEPENDENT_PROVIDER", "RESIDENTIAL_CARE_HOME"]) {
    const tag = randomBytes(3).toString("hex");
    const d = type === "HOME_CARE_AGENCY" ? "1" : type === "INDEPENDENT_PROVIDER" ? "2" : "3";
    const label = type === "HOME_CARE_AGENCY" ? "Agencia" : type === "INDEPENDENT_PROVIDER" ? "Independiente" : "Hogar";
    const org = (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2,'active') RETURNING id`, [`Alcance ${label} ${tag}`, type]))[0].id as string;
    orgs[type] = org;
    const rs = (await q(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'Ficticia') RETURNING id`, [org]))[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
    await q(`INSERT INTO organization_care_event_types (organization_id,care_event_type_id,is_enabled) SELECT $1,id,true FROM care_event_types WHERE code='MOOD' ON CONFLICT DO NOTHING`, [org]);
    const mk = async (email: string, phone: string, roles: string[]) => {
      const id = (await q(`INSERT INTO users (email,password_hash,status,phone) VALUES ($1,$2,'active',$3) RETURNING id`, [email, hash, phone]))[0].id as string;
      const m = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [id, org]))[0].id;
      await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, org, roles]);
      return id;
    };
    const worker = async (email: string, phone: string, name: string, roles: string[]) => {
      const u = await mk(email, phone, roles);
      const w = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [u, name]))[0].id as string;
      const owm = (await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [w, org]))[0].id as string;
      const c = (await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active','2031-07-17') RETURNING id`, [w, bls]))[0].id;
      return { u, w, owm, c };
    };
    const independent = type === "INDEPENDENT_PROVIDER";
    const adminEmail = `admin180-${tag}@example.invalid`;
    const adminId = independent ? null : await mk(adminEmail, `+178755${d}0101`, ["ORGANIZATION_ADMIN"]);
    const w1 = await worker(`asignada180-${tag}@example.invalid`, `+178755${d}0111`, "Asignada Ficticia", independent ? ["ORGANIZATION_ADMIN", "WORKER"] : ["WORKER"]);
    const w2 = independent ? w1 : await worker(`ajena180-${tag}@example.invalid`, `+178755${d}0222`, "Ajena Centinela", ["WORKER"]);
    const resolver = adminId ?? w1.u;
    await q(`INSERT INTO organization_credential_reviews (credential_id,organization_id,reviewed_by_user_id,review_status,reviewed_at) VALUES ($1,$2,$3,'approved',now())`, [w1.c, org, resolver]);
    const famEmail = `familia180-${tag}@example.invalid`;
    const fam = await mk(famEmail, `+178755${d}0333`, ["FAMILY"]);
    const r1 = (await q(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Propia','Ficticia','active') RETURNING id`, [org]))[0].id as string;
    const r2 = (await q(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Otraresidente','Centinela','active') RETURNING id`, [org]))[0].id as string;
    await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [fam, org, r1]);
    const sh = async (r: string, owm: string, hours: number) => {
      const s = (await q(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()+make_interval(hours=>$3),now()+make_interval(hours=>$3)+interval '4 hours','confirmed') RETURNING id`, [org, r, hours]))[0].id as string;
      await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,role_in_shift,response_status) VALUES ($1,$2,$3,$4,'caregiver','accepted')`, [org, s, owm, r]);
      return s;
    };
    const s1 = await sh(r1, w1.owm, 2), s2 = await sh(r2, w2.owm, 30);
    await q(`INSERT INTO care_events (organization_id,shift_id,care_recipient_id,organization_worker_membership_id,care_event_type_id,occurred_at,structured_data)
      SELECT $1,$2,$3,$4,id,now(),'{"mood":"Tranquilo"}'::jsonb FROM care_event_types WHERE code='MOOD'`, [org, s1, r1, w1.owm]);
    await q(`INSERT INTO incidents (organization_id,care_recipient_id,organization_worker_membership_id,severity,description,status,resolution,assigned_to_user_id,resolved_by_user_id,resolved_at)
      VALUES ($1,$2,$3,'low','Incidente ficticio','resolved','Resuelto de forma ficticia',$4,$4,now())`, [org, r1, w1.owm, resolver]);
    await q(`INSERT INTO worker_unavailability_periods (organization_id, organization_worker_membership_id, starts_at, ends_at) VALUES ($1,$2, now()+interval '5 days', now()+interval '6 days')`, [org, w2.owm]).catch(() => undefined);

    // ---- RLS del usuario solo-familia -------------------------------------------------------------------------------
    const famOnly = (await asUser(fam, org, `SELECT app_family_only_member() AS f`))[0]?.f;
    const rls = {
      users: await count(fam, org, "users"), credentials: await count(fam, org, "credentials"), workers: await count(fam, org, "workers"),
      memberships: await count(fam, org, "organization_worker_memberships"), shifts: await count(fam, org, "shifts"), assignments: await count(fam, org, "assignments"),
      unavailability: await count(fam, org, "worker_unavailability_periods"), otherRecipients: await count(fam, org, "care_recipients", `WHERE id <> '${r1}'`),
      visibleWorker: (await asUser(fam, org, `SELECT array_agg(display_name ORDER BY display_name) AS v FROM workers`))[0]?.v,
    };
    check(`${label} R1. Solo familia por RLS: su usuario; del personal solo la asignada (con su credencial); solo turnos y asignaciones de su familiar; sin disponibilidad ni otros residentes`,
      famOnly === true && rls.users === 1 && rls.credentials === 1 && rls.workers === 1 && rls.memberships === 1 && rls.shifts === 1 && rls.assignments === 1
      && rls.unavailability === 0 && rls.otherRecipients === 0 && JSON.stringify(rls.visibleWorker) === JSON.stringify(["Asignada Ficticia"]), { famOnly, ...rls });

    // ---- Lo que su portal usa ----------------------------------------------------------------------------------------
    const tF = await loginAs(famEmail, org);
    const fsh = await call("GET", `/organizations/${org}/care-recipients/${r1}/family-shifts`, tF);
    const tl = await call("GET", `/organizations/${org}/care-recipients/${r1}/timeline`, tF);
    const inc = await call("GET", `/organizations/${org}/care-recipients/${r1}/family-incidents`, tF);
    const conv = await call("POST", `/organizations/${org}/care-recipients/${r1}/conversation`, tF, {});
    const parts = conv.body.conversation?.id ? (await q(`SELECT user_id FROM message_thread_participants WHERE message_thread_id=$1`, [conv.body.conversation.id])).map((r) => r.user_id as string) : [];
    const sent = conv.body.conversation?.id ? await call("POST", `/organizations/${org}/conversations/${conv.body.conversation.id}/messages`, tF, { body: "Mensaje ficticio" }) : { status: 0 };
    const shift0 = (fsh.body.shifts ?? [])[0];
    const cgName = shift0?.caregiver?.displayName ?? shift0?.caregiverDisplayName ?? JSON.stringify(shift0 ?? {});
    const portalOk = fsh.status === 200 && JSON.stringify(fsh.body).includes("Asignada Ficticia") && JSON.stringify(fsh.body).includes("expiresAt")
      && tl.status === 200 && JSON.stringify(tl.body).includes("Asignada Ficticia") && inc.status === 200 && JSON.stringify(inc.body).includes("Incidente ficticio")
      && conv.status === 200 && parts.includes(fam) && parts.includes(resolver) && (independent || parts.includes(w1.u)) && !parts.includes(w2.u === w1.u ? "x" : w2.u) && sent.status === 201;
    check(`${label} P1. El portal familiar sigue igual: turnos con la cuidadora asignada y su credencial verificada, historial con autor, incidentes y conversación con la administración (y la cuidadora en su ventana)`,
      portalOk, { fsh: fsh.status, cgName, tl: tl.status, inc: inc.status, conv: conv.status, parts: parts.length, sent: sent.status });

    // ---- Ninguna ruta GET devuelve marcas ajenas -----------------------------------------------------------------------
    const sentinels: Record<string, string> = {
      "correo de la administración": `admin180-${tag}`, "teléfono de la administración": `55${d}0101`, "correo de la asignada": `asignada180-${tag}`, "teléfono de la asignada": `55${d}0111`,
      ...(independent ? {} : { "correo de la ajena": `ajena180-${tag}`, "teléfono de la ajena": `55${d}0222`, "nombre de la ajena": "Ajena Centinela" }),
      "otro residente": "Otraresidente", "turno de otro residente": s2,
    };
    const leaks: string[] = [];
    for (const variant of [r1, r2]) {
      const ids: Record<string, string> = { organizationId: org, recipientId: variant, careRecipientId: variant, shiftId: variant === r1 ? s1 : s2, membershipId: w2.owm, workerId: w2.owm, userId: w2.u };
      for (const r of gets) {
        const res = await call("GET", r.path.replace(/:([A-Za-z]+)/g, (_, n) => ids[n] ?? randomUUID()), tF);
        if (res.status >= 200 && res.status < 300) for (const [k, s] of Object.entries(sentinels)) if (res.text.includes(s)) leaks.push(`GET ${r.path} → ${k}`);
      }
    }
    check(`${label} A1. Ninguna de las ${gets.length} rutas GET (con su familiar y con otro residente) devuelve contactos, credenciales o datos del personal ajeno, la administración u otro residente`, leaks.length === 0, leaks);

    // ---- Varios roles y organizaciones; administración y personal sin pérdida ------------------------------------------------
    if (!independent) {
      const both = await worker(`familia-y-personal-${tag}@example.invalid`, `+178755${d}0444`, "Familiar Empleada", ["FAMILY", "WORKER"]);
      await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'nieta','active')`, [both.u, org, r2]);
      const bothF = (await asUser(both.u, org, `SELECT app_family_only_member() AS f`))[0]?.f;
      const bothOwn = await count(both.u, org, "credentials", `WHERE worker_id = '${both.w}'`);
      const bothWorkers = await count(both.u, org, "workers");
      const adminSees = { users: await count(adminId!, org, "users"), credentials: await count(adminId!, org, "credentials"), workers: await count(adminId!, org, "workers"), assignments: await count(adminId!, org, "assignments") };
      const w2Own = { cred: await count(w2.u, org, "credentials", `WHERE worker_id='${w2.w}'`), asg: await count(w2.u, org, "assignments", `WHERE organization_worker_membership_id='${w2.owm}'`) };
      check(`${label} M1. Familia y personal a la vez: no se le trata como solo familia y conserva lo del personal; la administración ve a todo el personal; cada empleada ve lo suyo`,
        bothF === false && bothOwn === 1 && bothWorkers >= 3 && adminSees.users >= 5 && adminSees.credentials >= 3 && adminSees.workers >= 3 && adminSees.assignments >= 2 && w2Own.cred === 1 && w2Own.asg === 1,
        { bothF, bothOwn, bothWorkers, adminSees, w2Own });
    }
    // Funciones SECURITY DEFINER: sí/no, sin datos; falsas sin contexto o para quien no es solo familia.
    const fn = (await asUser(fam, org, `SELECT app_family_visible_worker($1) AS w1, app_family_visible_worker($2) AS w2, app_family_has_recipient($3) AS r1, app_family_has_recipient($4) AS r2,
      app_family_recipient_shift($5) AS s1, app_family_recipient_shift($6) AS s2`, [w1.w, w2.w, r1, r2, s1, s2]))[0];
    const noCtx = (await rtc.query(`SELECT app_family_only_member() AS f, app_family_has_recipient($1) AS r`, [r1])).rows[0];
    const types = (await q(`SELECT string_agg(DISTINCT pg_get_function_result(p.oid), ',') AS t, bool_and(p.prosecdef) AS sd FROM pg_proc p WHERE p.proname IN ('app_family_only_member','app_family_has_recipient','app_family_recipient_shift','app_family_visible_membership','app_family_visible_worker')`))[0];
    const publicExec = (await q(`SELECT count(*)::int AS n FROM pg_proc p WHERE p.proname LIKE 'app_family_%' AND p.proname IN ('app_family_only_member','app_family_has_recipient','app_family_recipient_shift','app_family_visible_membership','app_family_visible_worker') AND has_function_privilege('public', p.oid, 'EXECUTE')`))[0].n;
    check(`${label} F1. Funciones SECURITY DEFINER: solo devuelven sí/no, aciertan para su familiar y fallan para lo ajeno; falsas sin contexto; PUBLIC no puede ejecutarlas`,
      fn?.w1 === true && fn?.w2 === (independent) && fn?.r1 === true && fn?.r2 === false && fn?.s1 === true && fn?.s2 === false && noCtx.f === false && noCtx.r === false
      && types.t === "boolean" && types.sd === true && publicExec === 0, { fn, noCtx, types, publicExec });
  }
  // Familia en una organización y administración en otra: cerrado en la primera, intacto en la segunda.
  const tagX = randomBytes(3).toString("hex");
  const cross = (await q(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [`cruce180-${tagX}@example.invalid`, hash]))[0].id as string;
  for (const [o, role] of [[orgs.INDEPENDENT_PROVIDER, "FAMILY"], [orgs.HOME_CARE_AGENCY, "SUPERVISOR"]] as const) {
    const m = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [cross, o]))[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [m, o, role]);
  }
  const inFam = await count(cross, orgs.INDEPENDENT_PROVIDER, "credentials"), inAgency = await count(cross, orgs.HOME_CARE_AGENCY, "users");
  check("X1. Familia en una organización y supervisión en otra: sin credenciales ajenas en la primera (no tiene familiar allí) y sin pérdida en la segunda",
    inFam === 0 && inAgency >= 5, { inFam, inAgency });
  check("Z1. Nunca un 500", errors500.length === 0, errors500);

  server.close(); await pool.end(); await rtc.end(); await db.end();
  await srv.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await srv.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 1200)}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
