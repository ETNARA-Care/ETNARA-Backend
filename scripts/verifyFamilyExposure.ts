/**
 * Exposición de datos del personal y de otros residentes a la familia (agencias e independientes).
 * Investigación autorizada por Rafa el 26-nov-2026, separada de hogares (F5).
 *
 * Datos FICTICIOS, base PROPIA desechable, app conectada como app_runtime (como producción desde el 31-oct).
 * Dos capas, por organización (agencia e independiente):
 *  1. RLS: con app_runtime directo y el contexto del familiar, ¿qué filas ajenas puede leer? (credenciales, turnos,
 *     asignaciones, empleados, membresías, contactos de usuarios, otros residentes, ubicaciones de servicio).
 *  2. API: todas las rutas GET registradas (organización y /me) llamadas como el familiar, con ids reales de su
 *     familiar y de otro residente; se buscan en las respuestas marcas centinela del personal NO asignado (correo,
 *     teléfono, credencial), de la administración, de otro residente y de su dirección.
 * Informa; falla (exit 1) solo si la API devuelve alguna marca prohibida.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superusuario>@<local>/<db> npx tsx scripts/verifyFamilyExposure.ts
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
  const dbName = `etnara_famexp_${randomBytes(4).toString("hex")}`;
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

  const report: string[] = []; const apiLeaks: string[] = [];
  for (const type of ["HOME_CARE_AGENCY", "INDEPENDENT_PROVIDER"]) {
    const tag = randomBytes(3).toString("hex");
    const d = type === "HOME_CARE_AGENCY" ? "1" : "2";
    const org = (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2,'active') RETURNING id`, [`Exposicion ${type} ${tag}`, type]))[0].id;
    const user = async (email: string, phone: string | null, roles: string[]) => {
      const id = (await q(`INSERT INTO users (email,password_hash,status,phone) VALUES ($1,$2,'active',$3) RETURNING id`, [email, hash, phone]))[0].id;
      const m = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [id, org]))[0].id;
      await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, org, roles]);
      return id as string;
    };
    const worker = async (email: string, phone: string, name: string, credNumber: string, roles = ["WORKER"]) => {
      const u = await user(email, phone, roles);
      const w = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [u, name]))[0].id;
      const owm = (await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [w, org]))[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at,credential_number) VALUES ($1,$2,'external_provider','active','2031-07-17',$3)`, [w, bls, credNumber])
        .catch(async () => q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active','2031-07-17')`, [w, bls]));
      return { u, owm: owm as string };
    };
    // Independiente: un solo operador (administración y cuidado); en la agencia, administración y dos empleadas.
    const independent = type === "INDEPENDENT_PROVIDER";
    const adminId = independent ? null : await user(`centinela-admin-${tag}@example.invalid`, `+178755${d}0101`, ["ORGANIZATION_ADMIN"]);
    const w1 = await worker(`centinela-asignada-${tag}@example.invalid`, `+178755${d}0111`, "Asignada Ficticia", "LIC-ASIG-111", independent ? ["ORGANIZATION_ADMIN", "WORKER"] : ["WORKER"]);
    const w2 = independent ? w1 : await worker(`centinela-ajena-${tag}@example.invalid`, `+178755${d}0222`, "Ajena Centinela", "LIC-AJENA-222");
    const fam = await user(`familia-${tag}@example.invalid`, `+178755${d}0333`, ["FAMILY"]);
    const r1 = (await q(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Propia','Ficticia','active') RETURNING id`, [org]))[0].id;
    const r2 = (await q(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Otraresidente','Centinela','active') RETURNING id`, [org]))[0].id;
    await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [fam, org, r1]);
    const sh = async (r: string, owm: string, days: number) => {
      const s = (await q(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()+make_interval(days=>$3),now()+make_interval(days=>$3)+interval '4 hours','confirmed') RETURNING id`, [org, r, days]))[0].id;
      await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,role_in_shift,response_status) VALUES ($1,$2,$3,$4,'caregiver','accepted')`, [org, s, owm, r]);
      return s as string;
    };
    const s1 = await sh(r1, w1.owm, 1), s2 = await sh(r2, w2.owm, 2);
    const resolver = adminId ?? w1.u;
    // Objetos que la familia sí ve de su familiar (incidente resuelto, actividad, conversación) y los de otro residente.
    for (const [r, owm] of [[r1, w1.owm], [r2, w2.owm]] as const) {
      await q(`INSERT INTO incidents (organization_id,care_recipient_id,organization_worker_membership_id,severity,description,status,resolution,assigned_to_user_id,resolved_by_user_id,resolved_at)
        VALUES ($1,$2,$3,'low','Incidente ficticio','resolved','Resuelto de forma ficticia',$4,$4,now())`, [org, r, owm, resolver]).catch((e) => report.push(`(incidente no creado: ${(e as Error).message.slice(0, 60)})`));
      await q(`INSERT INTO care_events (organization_id,shift_id,care_recipient_id,organization_worker_membership_id,care_event_type_id,occurred_at,structured_data)
        SELECT $1,$2,$3,$4,id,now(),'{"mood":"Tranquilo"}'::jsonb FROM care_event_types WHERE code='MOOD'`, [org, r === r1 ? s1 : s2, r, owm]).catch((e) => report.push(`(actividad no creada: ${(e as Error).message.slice(0, 60)})`));
    }
    const th = (await q(`INSERT INTO message_threads (organization_id,care_recipient_id,thread_type) VALUES ($1,$2,'family_agency') RETURNING id`, [org, r1]))[0].id;
    for (const u of [resolver, fam]) await q(`INSERT INTO message_thread_participants (organization_id,message_thread_id,user_id,can_write) VALUES ($1,$2,$3,true)`, [org, th, u]);
    await q(`INSERT INTO messages (organization_id,message_thread_id,sender_user_id,body) VALUES ($1,$2,$3,'Mensaje ficticio de la administración')`, [org, th, resolver]);
    await q(`INSERT INTO service_locations (organization_id,care_recipient_id,label,address_line1,city,latitude,longitude,is_primary) VALUES ($1,$2,'Casa','Calle Centinela 999','Ponce',18.0111,-66.6141,true)`, [org, r2]).catch(() => undefined);
    // 1. RLS
    await rtc.query("BEGIN");
    await rtc.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin','false',true)`, [fam, org]);
    const tables = (await rtc.query(`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity ORDER BY 1`)).rows.map((r) => r.t as string);
    const readable: string[] = [];
    for (const t of tables) {
      await rtc.query("SAVEPOINT p");
      try { const n = (await rtc.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n; if (n > 0) readable.push(`${t}=${n}`); await rtc.query("RELEASE SAVEPOINT p"); }
      catch { await rtc.query("ROLLBACK TO SAVEPOINT p"); }
    }
    const probe = async (s: string) => { await rtc.query("SAVEPOINT p"); try { const v = (await rtc.query(s)).rows; await rtc.query("RELEASE SAVEPOINT p"); return v; } catch (e) { await rtc.query("ROLLBACK TO SAVEPOINT p"); return [{ error: (e as Error).message.slice(0, 60) }]; } };
    const emails = await probe(`SELECT email, phone FROM users WHERE email LIKE '%${tag}%'`);
    const creds = await probe(`SELECT count(*)::int AS n FROM credentials`);
    const otherRes = await probe(`SELECT count(*)::int AS n FROM care_recipients WHERE id <> '${r1}'`);
    const otherAsg = await probe(`SELECT count(*)::int AS n FROM assignments WHERE care_recipient_id <> '${r1}'`);
    const locs = await probe(`SELECT count(*)::int AS n FROM service_locations WHERE care_recipient_id <> '${r1}'`);
    await rtc.query("ROLLBACK");
    report.push(`\n== ${type} · RLS con app_runtime (contexto del familiar) ==`);
    report.push(`tablas con filas legibles: ${readable.join(" ")}`);
    report.push(`usuarios (correo/teléfono) visibles: ${JSON.stringify(emails)}`);
    report.push(`credenciales visibles: ${JSON.stringify(creds)} · otros residentes: ${JSON.stringify(otherRes)} · asignaciones de otros residentes: ${JSON.stringify(otherAsg)} · direcciones de otros residentes: ${JSON.stringify(locs)}`);
    // 2. API
    const login = await realFetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `familia-${tag}@example.invalid`, password }) });
    const token = (await login.json() as { token: string }).token;
    await realFetch(`${base}/me/active-organization`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ organizationId: org }) });
    const sentinels: Record<string, string> = {
      "correo de la empleada ajena": `centinela-ajena-${tag}`, "teléfono de la empleada ajena": `55${d}0222`, "nombre de la empleada ajena": "Ajena Centinela", "licencia de la ajena": "LIC-AJENA-222",
      "correo de la empleada asignada": `centinela-asignada-${tag}`, "teléfono de la empleada asignada": `55${d}0111`, "licencia de la asignada": "LIC-ASIG-111",
      "correo de la administración": `centinela-admin-${tag}`, "teléfono de la administración": `55${d}0101`,
      "otro residente": "Otraresidente", "dirección de otro residente": "Calle Centinela 999", "turno de otro residente": s2,
    };
    let ok200 = 0;
    for (const variant of [r1, r2]) {
      const ids: Record<string, string> = { organizationId: org, recipientId: variant, careRecipientId: variant, shiftId: variant === r1 ? s1 : s2, membershipId: w2.owm, workerId: w2.owm, userId: w2.u };
      for (const r of gets) {
        const path = r.path.replace(/:([A-Za-z]+)/g, (_, n) => ids[n] ?? randomUUID());
        const res = await realFetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
        const text = await res.text();
        if (res.status >= 200 && res.status < 300) {
          ok200 += 1;
          for (const [label, s] of Object.entries(sentinels)) if (text.includes(s)) apiLeaks.push(`${type} GET ${r.path} (${variant === r1 ? "su familiar" : "otro residente"}) → ${label}`);
        }
      }
    }
    report.push(`API: ${gets.length} rutas GET × 2 variantes; respuestas 2xx: ${ok200}`);
  }
  console.log(report.join("\n"));
  console.log(`\n== API: marcas centinela en respuestas al familiar ==\n${apiLeaks.length ? apiLeaks.join("\n") : "ninguna"}`);
  server.close(); await pool.end(); await rtc.end(); await db.end();
  await srv.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await srv.end();
  process.exit(apiLeaks.some((l) => !/asignada/.test(l)) ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
