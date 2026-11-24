/**
 * 163 · Interruptor de la modalidad «Cuidador independiente» en ETNARA Central. 24-nov-2026.
 * Datos FICTICIOS, base PROPIA desechable, ningún correo real (Resend interceptado). App real por HTTP como app_runtime.
 * Cubre: solo administración de plataforma; motivo obligatorio; auditoría (anterior, nuevo, persona, fecha, motivo)
 * en un registro solo de añadir; encender bloqueado sin INDEPENDENT_MODALITY_ACTIVATION_ALLOWED=on; apagar siempre;
 * el interruptor gobierna el registro de nuevos independientes y no corta a los ya registrados; agencias y hogares
 * sin cambios; protecciones en la base (sin escritura directa, bandera falsificada, administración revocada);
 * reversión y reaplicación.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
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

async function main() {
  const own = `etnara_m163_${randomBytes(4).toString("hex")}`;
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
  const rt = new pg.Client({ connectionString: u.toString() }); await rt.connect();
  const rtErr = async (s: string, p: unknown[] = []) => { try { await rt.query(s, p); return "OK"; } catch (e) { return (e as Error).message; } };
  const suErr = async (s: string, p: unknown[] = []) => { try { await q(s, p); return "OK"; } catch (e) { return (e as Error).message; } };

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
  const org = async (name: string, type: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2,'active') RETURNING id`, [name, type])).rows[0].id;
  const user = async (key: string) => { const email = `m163-${key}-${tag}@example.invalid`;
    return { email, id: (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id }; };
  const member = async (x: { id: string }, o: string, roles: string[]) => { const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [x.id, o])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, o, roles]); return m; };
  const login = async (x: { email: string }, o?: string) => { const t = (await call("POST", "/auth/login", "", { email: x.email, password })).body.token as string; if (o) await call("POST", "/me/active-organization", t, { organizationId: o }); return t; };
  const rolesOf = async (x: { id: string }, o: string) => (await q<{ c: string | null }>(`SELECT string_agg(r.code, ',' ORDER BY r.code) c FROM organization_memberships om JOIN user_roles ur ON ur.organization_membership_id=om.id JOIN roles r ON r.id=ur.role_id WHERE om.user_id=$1 AND om.organization_id=$2`, [x.id, o])).rows[0].c ?? "";
  const tokenFor = (email: string) => { const m = [...mails].reverse().find((x) => x.to === email); return /token=([a-f0-9]{64})/i.exec(m?.html ?? "")?.[1] ?? ""; };
  const snapshot = async (o: string) => (await q<{ s: string }>(`SELECT md5(concat_ws('|',
      (SELECT string_agg(id::text||status::text||internal_role||worker_id::text, ',' ORDER BY id) FROM organization_worker_memberships WHERE organization_id=$1),
      (SELECT string_agg(om.id::text||om.status::text||ur.role_id::text, ',' ORDER BY om.id, ur.role_id) FROM organization_memberships om LEFT JOIN user_roles ur ON ur.organization_membership_id=om.id WHERE om.organization_id=$1),
      (SELECT organization_type::text||status::text FROM organizations WHERE id=$1))) s`, [o])).rows[0].s;

  const A = await org(`Agencia Ficticia ${tag}`, "HOME_CARE_AGENCY");
  const adminA = await user("admin-agencia"); await member(adminA, A, ["ORGANIZATION_ADMIN"]);
  const central = await user("central"); await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.id]);
  const revoked = await user("central-revocada"); await q(`INSERT INTO platform_admins (user_id, revoked_at) VALUES ($1, now())`, [revoked.id]);
  const tC = await login(central), tA = await login(adminA, A), tR = await login(revoked);
  const P = "/platform/modalities", PI = `${P}/INDEPENDENT_PROVIDER`;
  const reason = "Prueba ficticia del interruptor (163)";
  const state = async () => (await q<{ enabled: boolean }>(`SELECT enabled FROM platform_modalities WHERE code='INDEPENDENT_PROVIDER'`)).rows[0].enabled;
  const events = async () => (await q(`SELECT modality_code, previous_enabled, new_enabled, reason, actor_user_id, occurred_at FROM platform_modality_events ORDER BY occurred_at`)).rows as Json[];
  delete process.env.INDEPENDENT_MODALITY_ACTIVATION_ALLOWED;

  // ---- 1. Estado inicial: apagada, sin autorización para encender --------------------------------------------
  const g0 = await call("GET", P, tC);
  const m0 = (g0.body.modalities ?? [])[0] ?? {};
  check("M1. Central ve la modalidad apagada, sin autorización para encender y sin historial",
    g0.status === 200 && m0.code === "INDEPENDENT_PROVIDER" && m0.enabled === false && m0.activationAllowed === false && m0.canEnable === false && m0.history?.length === 0, g0.body);
  const gA = await call("GET", P, tA), pA = await call("PATCH", PI, tA, { enabled: false, reason }), gR = await call("GET", P, tR), pR = await call("PATCH", PI, tR, { enabled: false, reason }), gN = await call("GET", P, "");
  check("M2. Solo administración de plataforma: una administradora de agencia y una de plataforma revocada reciben 403; sin sesión, 401",
    gA.status === 403 && pA.status === 403 && gR.status === 403 && pR.status === 403 && gN.status === 401, [gA.status, pA.status, gR.status, pR.status, gN.status]);
  const on0 = await call("PATCH", PI, tC, { enabled: true, reason });
  check("M3. Encender sin la autorización del servidor: 409 MODALITY_ACTIVATION_NOT_AUTHORIZED; sigue apagada y sin evento",
    on0.status === 409 && on0.body.error === "MODALITY_ACTIVATION_NOT_AUTHORIZED" && (await state()) === false && (await events()).length === 0, on0);
  const reg0 = await call("POST", "/platform/organizations", tC, { name: `Independiente ${tag}`, organizationType: "INDEPENDENT_PROVIDER" });
  const agency0 = await call("POST", "/platform/organizations", tC, { name: `Agencia Nueva ${tag}`, organizationType: "HOME_CARE_AGENCY" });
  const home0 = await call("POST", "/platform/organizations", tC, { name: `Hogar Nuevo ${tag}`, organizationType: "RESIDENTIAL_CARE_HOME" });
  check("M4. Apagada: no se registran independientes; agencias y hogares se crean como siempre",
    reg0.status === 409 && reg0.body.error === "INDEPENDENT_MODALITY_DISABLED" && agency0.status === 201 && home0.status === 201, [reg0.status, agency0.status, home0.status]);

  // ---- 2. Con la autorización del servidor: motivo obligatorio, auditoría --------------------------------------
  process.env.INDEPENDENT_MODALITY_ACTIVATION_ALLOWED = "on";
  const noReason = await call("PATCH", PI, tC, { enabled: true }), shortReason = await call("PATCH", PI, tC, { enabled: true, reason: "corto" });
  check("M5. Sin motivo (o con menos de 10 caracteres) no se cambia nada (400)", noReason.status === 400 && shortReason.status === 400 && (await state()) === false && (await events()).length === 0, [noReason.status, shortReason.status]);
  const on1 = await call("PATCH", PI, tC, { enabled: true, reason });
  const ev1 = await events();
  check("M6. Encender (autorizado): queda encendida y auditada con valor anterior, nuevo, motivo, persona y fecha",
    on1.status === 200 && on1.body.changed === true && on1.body.modality?.enabled === true && (await state()) === true && ev1.length === 1
    && ev1[0].previous_enabled === false && ev1[0].new_enabled === true && ev1[0].reason === reason && ev1[0].actor_user_id === central.id
    && Math.abs(new Date(ev1[0].occurred_at).getTime() - Date.now()) < 120_000, [on1, ev1]);
  const again = await call("PATCH", PI, tC, { enabled: true, reason });
  check("M7. Repetir el mismo estado no cambia nada ni crea eventos (changed=false)", again.status === 200 && again.body.changed === false && (await events()).length === 1, again.body);
  const g1 = await call("GET", P, tC);
  check("M8. Central muestra el historial (persona, motivo) y que se puede apagar",
    g1.body.modalities?.[0]?.history?.[0]?.actorEmail === central.email && g1.body.modalities?.[0]?.history?.[0]?.reason === reason && g1.body.modalities?.[0]?.canDisable === true, g1.body);

  // Registro de un independiente mientras está encendida.
  const I = (await call("POST", "/platform/organizations", tC, { name: `Práctica ${tag}`, organizationType: "INDEPENDENT_PROVIDER" })).body.organization?.id as string;
  const indEmail = `m163-independiente-${tag}@example.invalid`;
  const inv = await call("POST", `/platform/organizations/${I}/admin-invitations`, tC, { email: indEmail });
  const act = await call("POST", "/platform/admin-invitations/activate", "", { token: tokenFor(indEmail), password });
  const tI = await login({ email: indEmail }, I);
  const rec1 = await call("POST", `/organizations/${I}/care-recipients`, tI, { firstName: "Persona", lastName: "Ficticia" });
  check("M9. Encendida: se registra un proveedor independiente y opera", Boolean(I) && inv.status === 201 && act.status === 201 && [200, 201].includes(rec1.status), [I, inv.status, act.status, rec1.status]);
  // Una segunda invitación pendiente, para comprobar qué pasa con un registro a medias al apagar.
  const I2 = (await call("POST", "/platform/organizations", tC, { name: `Práctica 2 ${tag}`, organizationType: "INDEPENDENT_PROVIDER" })).body.organization?.id as string;

  // ---- 3. Apagar: siempre permitido; solo afecta a nuevos registros ----------------------------------------------
  delete process.env.INDEPENDENT_MODALITY_ACTIVATION_ALLOWED;
  const off = await call("PATCH", PI, tC, { enabled: false, reason: "Prueba ficticia: apagar sin autorización del servidor" });
  const ev2 = await events();
  check("M10. Apagar está siempre permitido (aun sin la autorización del servidor) y queda auditado",
    off.status === 200 && off.body.modality?.enabled === false && (await state()) === false && ev2.length === 2 && ev2[1].previous_enabled === true && ev2[1].new_enabled === false, [off, ev2]);
  const reg1 = await call("POST", "/platform/organizations", tC, { name: `Independiente 3 ${tag}`, organizationType: "INDEPENDENT_PROVIDER" });
  const rtIns = await (async () => { try { await rt.query("BEGIN"); await rt.query(`INSERT INTO organizations (name,organization_type,status) VALUES ('x','INDEPENDENT_PROVIDER','active')`); return "OK"; } catch (e) { return (e as Error).message; } finally { await rt.query("ROLLBACK"); } })();
  check("M11. Apagada: no hay nuevos registros independientes ni por Central ni directamente en la base", reg1.status === 409 && rtIns.includes("INDEPENDENT_MODALITY_DISABLED"), [reg1.status, rtIns]);
  const tI2 = await login({ email: indEmail }, I);
  const list = await call("GET", `/organizations/${I}/care-recipients`, tI2);
  const rec2 = await call("POST", `/organizations/${I}/care-recipients`, tI2, { firstName: "Otra", lastName: "Ficticia" });
  const workers = await call("GET", `/organizations/${I}/workers`, tI2);
  const orgRow = (await q<{ status: string; organization_type: string }>(`SELECT status, organization_type FROM organizations WHERE id=$1`, [I])).rows[0];
  check("M12. Apagar NO interrumpe al proveedor ya registrado: inicia sesión, consulta, crea y su organización no cambia de estado",
    Boolean(tI2) && list.status === 200 && [200, 201].includes(rec2.status) && workers.status === 200 && ["trial", "active"].includes(orgRow.status) && orgRow.organization_type === "INDEPENDENT_PROVIDER",
    [list.status, rec2.status, workers.status, orgRow]);
  const i2Email = `m163-pendiente-${tag}@example.invalid`;
  const inv2 = await call("POST", `/platform/organizations/${I2}/admin-invitations`, tC, { email: i2Email });
  const act2 = await call("POST", "/platform/admin-invitations/activate", "", { token: tokenFor(i2Email), password });
  check("M13. Una organización independiente creada antes de apagar conserva su registro y puede completar la activación de su única persona operativa",
    inv2.status === 201 && act2.status === 201, [inv2.status, inv2.body, act2.status, act2.body]);

  // ---- 4. Protecciones en la base -------------------------------------------------------------------------------
  const ctx = async (userId: string, superFlag: boolean, stmt: string, params: unknown[] = []) => {
    try {
      await rt.query("BEGIN");
      await rt.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.is_superadmin',$2,true)`, [userId, superFlag ? "true" : "false"]);
      const r = await rt.query(stmt, params); return r.rows;
    } catch (e) { return (e as Error).message; } finally { await rt.query("ROLLBACK"); }
  };
  const directUpd = await ctx(central.id, true, `UPDATE platform_modalities SET enabled=true`);
  const directRead = await ctx(central.id, true, `SELECT * FROM platform_modalities`);
  const forged = await ctx(adminA.id, true, `SELECT * FROM app_platform_set_modality('INDEPENDENT_PROVIDER', true, $1)`, [reason]);
  const revokedFn = await ctx(revoked.id, true, `SELECT * FROM app_platform_set_modality('INDEPENDENT_PROVIDER', true, $1)`, [reason]);
  const noFlag = await ctx(central.id, false, `SELECT * FROM app_platform_set_modality('INDEPENDENT_PROVIDER', true, $1)`, [reason]);
  const listForged = await ctx(adminA.id, true, `SELECT * FROM app_platform_list_modalities()`);
  check("M14. Base de datos: la aplicación no escribe ni lee la tabla directamente; bandera falsificada, administración revocada o sin contexto de plataforma → PLATFORM_ADMIN_REQUIRED",
    /permission denied/.test(String(directUpd)) && /permission denied/.test(String(directRead))
    && [forged, revokedFn, noFlag, listForged].every((x) => String(x).includes("PLATFORM_ADMIN_REQUIRED")) && (await state()) === false,
    [directUpd, directRead, forged, revokedFn, noFlag, listForged]);
  const dbReason = await ctx(central.id, true, `SELECT * FROM app_platform_set_modality('INDEPENDENT_PROVIDER', false, '  corto ')`);
  const dbUnknown = await ctx(central.id, true, `SELECT * FROM app_platform_set_modality('OTRA', true, $1)`, [reason]);
  check("M15. Base de datos: motivo obligatorio y modalidad desconocida rechazados", String(dbReason).includes("MODALITY_REASON_REQUIRED") && String(dbUnknown).includes("MODALITY_NOT_FOUND"), [dbReason, dbUnknown]);
  const evRt = await ctx(central.id, true, `SELECT count(*)::int n FROM platform_modality_events`);
  const evAgency = await ctx(adminA.id, false, `SELECT count(*)::int n FROM platform_modality_events`);
  const evIns = await ctx(central.id, true, `INSERT INTO platform_modality_events (modality_code,previous_enabled,new_enabled,reason,actor_user_id) VALUES ('INDEPENDENT_PROVIDER',false,true,'falso evento',$1)`, [central.id]);
  const evUpd = await ctx(central.id, true, `UPDATE platform_modality_events SET reason='cambiado'`);
  const suUpd = await suErr(`UPDATE platform_modality_events SET reason='cambiado'`);
  const suDel = await suErr(`DELETE FROM platform_modality_events`);
  const suTr = await suErr(`TRUNCATE platform_modality_events`);
  check("M16. Registro de cambios solo de añadir: plataforma lo lee, una agencia no; nadie inserta a mano, cambia, borra ni vacía",
    Array.isArray(evRt) && evRt[0].n === 2 && Array.isArray(evAgency) && evAgency[0].n === 0 && /permission denied/.test(String(evIns)) && /permission denied/.test(String(evUpd))
    && [suUpd, suDel, suTr].every((x) => x.includes("MODALITY_AUDIT_APPEND_ONLY")) && (await events()).length === 2, [evRt, evAgency, evIns, evUpd, suUpd, suDel, suTr]);
  const unknown = await call("PATCH", `${P}/OTRA`, tC, { enabled: false, reason });
  const bad = await call("PATCH", PI, tC, { enabled: "si", reason });
  check("M17. Modalidad desconocida (404) y datos no válidos (400) por la API", unknown.status === 404 && bad.status === 400, [unknown.status, bad.status]);
  const def = (await q(`SELECT proname, prosecdef, proconfig::text cfg, has_function_privilege('pg_monitor', oid, 'EXECUTE') pub FROM pg_proc WHERE proname IN ('app_platform_set_modality','app_platform_list_modalities') ORDER BY 1`)).rows;
  check("M18. Funciones SECURITY DEFINER con search_path fijo y sin EXECUTE público", def.length === 2 && def.every((d: Json) => d.prosecdef && /search_path=pg_catalog, public/.test(d.cfg) && d.pub === false), def);
  check("M19. Nunca un 500 en todo el recorrido", errors500.length === 0, errors500);

  // ---- 5. Reversión y reaplicación --------------------------------------------------------------------------------
  server.close(); await pool.end();
  const { readFileSync } = await import("node:fs");
  const kept = (await events()).length, st = await state();
  await q(readFileSync(join(process.cwd(), "ops/163_platform_modality_switch_central.rollback.sql"), "utf8"));
  const fns = Number((await q(`SELECT count(*) n FROM pg_proc WHERE proname IN ('app_platform_set_modality','app_platform_list_modalities')`)).rows[0].n);
  check("M20. Reversión: retira las funciones, no cambia el estado de la modalidad y conserva el registro de cambios", fns === 0 && (await state()) === st && (await events()).length === kept, [fns, st, kept]);
  const mig = readFileSync(join(process.cwd(), "migrations/163_platform_modality_switch_central.sql"), "utf8");
  await q(mig); await q(mig);
  const fns2 = Number((await q(`SELECT count(*) n FROM pg_proc WHERE proname IN ('app_platform_set_modality','app_platform_list_modalities')`)).rows[0].n);
  check("M21. Reaplicar la 163 (dos veces) deja el mismo estado y no toca el registro (idempotente)", fns2 === 2 && (await state()) === st && (await events()).length === kept, [fns2]);

  await rt.end(); await db.end();
  await srv.query(`DROP DATABASE ${own} WITH (FORCE)`); await srv.end();
}

main().then(() => {
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 900)}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
