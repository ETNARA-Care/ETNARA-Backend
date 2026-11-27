/**
 * 172 · Hogares F2: concurrencia del calendario (auditoría 26-nov). Aplicación real por HTTP como app_runtime, datos
 * FICTICIOS, base PROPIA desechable.
 *   K1  dos administradores publican la misma semana a la vez: una sola publicación, sin turnos duplicados;
 *   K2  una entrada añadida mientras otro publica queda creada o pendiente (nunca se pierde);
 *   K3  cierre del establecimiento antes y a la vez que una publicación: nunca un establecimiento cerrado con turnos;
 *   K4  la misma cuidadora en dos establecimientos con turnos solapados publicados a la vez: nunca dos asignaciones solapadas;
 *   K5  los borradores nunca llegan al personal, tampoco durante publicaciones concurrentes.
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
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 1500) });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  if (!/^https?:\/\/127\.0\.0\.1:/.test(url)) throw new Error(`Salida de red bloqueada en la prueba: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";
process.env.EMAIL_SENDER_ADDRESS ??= "pruebas@example.invalid";
process.env.ACTIVATION_BASE_URL ??= "https://portal.example.invalid";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function futureMonday(weeksAhead: number): string {
  const now = new Date(Date.now() - 4 * 3_600_000);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const toMonday = (8 - d.getUTCDay()) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + toMonday + 7 * weeksAhead);
  return d.toISOString().slice(0, 10);
}
const plusDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function main() {
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  const dbName = `etnara_schedc_${randomBytes(4).toString("hex")}`;
  await srv.query(`CREATE DATABASE ${dbName}`);
  const su = new URL(serverUrl!); su.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: su.toString() }); await db.connect();
  { const log = console.log; console.log = () => undefined; try { await applyPendingMigrations(db, join(process.cwd(), "migrations")); } finally { console.log = log; } }
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const rt = new URL(su.toString()); rt.username = "app_runtime"; rt.password = runtimePassword;
  process.env.DATABASE_URL = rt.toString();
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const { resetFeatureWriteLimitForTests } = await import("../src/middleware/featureWriteLimit.js").catch(() => ({ resetFeatureWriteLimitForTests: () => undefined }));
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const errors500: string[] = [];
  const call = async (method: string, path: string, token: string, body?: Json) => {
    resetFeatureWriteLimitForTests();
    const res = await realFetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: Json = {}; try { json = JSON.parse(text); } catch { /* vacío */ }
    if (res.status >= 500) errors500.push(`${method} ${path} ${res.status} ${json.error ?? ""}`);
    return { status: res.status, body: json };
  };
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toLowerCase();
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types ORDER BY code LIMIT 1`)).rows[0].id;
  const H = (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'RESIDENTIAL_CARE_HOME','active') RETURNING id`, [`Hogar Concurrencia ${tag}`])).rows[0].id;
  const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'Ficticia') RETURNING id`, [H])).rows[0].id;
  await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  await q(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'HOGAR_CALENDARIO',true)`, [H]);
  type P = { userId: string; token: string; owm?: string };
  const person = async (key: string, roles: string[], worker = false): Promise<P> => {
    const email = `scc-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, H])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, H, roles]);
    let owm: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Ficticia ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, H])).rows[0].id;
      await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
    }
    const t = (await call("POST", "/auth/login", "", { email, password })).body.token as string;
    await call("POST", "/me/active-organization", t, { organizationId: H });
    return { userId, token: t, owm };
  };
  const admin1 = await person("admin1", ["ORGANIZATION_ADMIN"]), admin2 = await person("admin2", ["ORGANIZATION_ADMIN"]);
  const w1 = await person("w1", ["WORKER"], true);
  let n = 0;
  const establishment = async () => (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,$2) RETURNING id`, [H, `Casa ${++n}`])).rows[0].id;
  const S = `/organizations/${H}/residential/schedule`;
  const W = (l: string, w: string) => `${S}/establishments/${l}/weeks/${w}`;
  const shiftsOf = async (l: string) => (await q<{ n: number }>(`SELECT count(*)::int n FROM shifts s JOIN establishment_technical_rooms t ON t.room_id = s.room_id
    WHERE t.location_id = $1 AND s.status NOT IN ('cancelled','completed')`, [l])).rows[0].n;
  const week = futureMonday(1);

  // K1. Dos administradores publican la misma semana a la vez (3 repeticiones).
  {
    const out: Json[] = []; let ok = true;
    for (let i = 0; i < 3; i++) {
      const L = await establishment();
      for (const d of [0, 1, 2]) await call("POST", `${W(L, week)}/entries`, admin1.token, { startsAt: `${plusDays(week, d)}T07:00`, durationMinutes: 480 });
      const [a, b] = await Promise.all([call("POST", `${W(L, week)}/publish`, admin1.token), call("POST", `${W(L, week)}/publish`, admin2.token)]);
      const pubs = (await q<{ n: number }>(`SELECT count(*)::int n FROM schedule_week_publications p JOIN schedule_weeks w ON w.id = p.week_id WHERE w.location_id = $1`, [L])).rows[0].n;
      const shifts = await shiftsOf(L);
      const statuses = [a.status, b.status].sort();
      const pass = statuses[0] === 200 && statuses[1] === 409 && [a, b].some((r) => r.body.error === "RESIDENTIAL_SCHEDULE_NOTHING_TO_PUBLISH") && pubs === 1 && shifts === 3;
      ok &&= pass; out.push({ statuses, pubs, shifts });
    }
    check("K1. Dos administradores publican la misma semana a la vez: una sola publicación, la otra 409 «nada que publicar», 3 turnos sin duplicados (3 repeticiones)", ok, out);
  }

  // K2. Entrada añadida por un administrador mientras el otro publica (3 repeticiones): queda creada o pendiente.
  {
    const out: Json[] = []; let ok = true;
    for (let i = 0; i < 3; i++) {
      const L = await establishment();
      await call("POST", `${W(L, week)}/entries`, admin1.token, { startsAt: `${week}T07:00`, durationMinutes: 480 });
      const [pub, add] = await Promise.all([
        call("POST", `${W(L, week)}/publish`, admin1.token),
        call("POST", `${W(L, week)}/entries`, admin2.token, { startsAt: `${plusDays(week, 3)}T07:00`, durationMinutes: 480 }),
      ]);
      const s = (await call("GET", W(L, week), admin1.token)).body.schedule;
      const pending = s.entries.filter((e: Json) => !e.published && !e.removed).length;
      const published = s.entries.filter((e: Json) => e.published).length;
      const shifts = await shiftsOf(L);
      // Coherente: cada entrada está publicada (con su turno) o pendiente, y si hay pendientes la semana lo indica.
      const pass = pub.status === 200 && add.status === 201 && s.entries.length === 2 && published + pending === 2 && shifts === published
        && (pending === 0 || s.week.hasUnpublishedChanges === true);
      const again = pending > 0 ? await call("POST", `${W(L, week)}/publish`, admin2.token) : { status: 200 };
      const pass2 = (await shiftsOf(L)) === 2 && again.status === 200;
      ok &&= pass && pass2; out.push({ pub: pub.status, add: add.status, published, pending, flag: s.week.hasUnpublishedChanges, shifts, again: again.status });
    }
    check("K2. Entrada añadida mientras otro administrador publica: queda publicada o pendiente (con aviso), nunca se pierde; la siguiente publicación la crea (3 repeticiones)", ok, out);
  }

  // K3. Cierre del establecimiento frente a una publicación.
  {
    const rtc = new pg.Client({ connectionString: rt.toString() }); await rtc.connect();
    const ctx = async () => {
      await rtc.query("BEGIN");
      await rtc.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin','false',true)`, [admin1.userId, H]);
    };
    // Cierre primero (transacción abierta): la publicación espera y, al confirmarse el cierre, no crea nada.
    const L = await establishment();
    await call("POST", `${W(L, week)}/entries`, admin1.token, { startsAt: `${week}T07:00`, durationMinutes: 480 });
    await ctx();
    await rtc.query(`SELECT app_residential_close_establishment($1,'Cierre ficticio por prueba')`, [L]);
    const pubP = call("POST", `${W(L, week)}/publish`, admin2.token);
    await sleep(800);
    const waited = await Promise.race([pubP.then(() => false), sleep(10).then(() => true)]);
    await rtc.query("COMMIT");
    const pub = await pubP;
    const closed = (await q<{ c: boolean }>(`SELECT archived_at IS NOT NULL c FROM locations WHERE id=$1`, [L])).rows[0].c;
    const shifts = (await q<{ n: number }>(`SELECT count(*)::int n FROM shifts s JOIN rooms r ON r.id = s.room_id JOIN units u ON u.id = r.unit_id WHERE u.location_id=$1`, [L])).rows[0].n;
    check("K3a. Cierre en curso y publicación a la vez: la publicación espera al cierre y no crea ningún turno en el establecimiento cerrado (404)",
      waited && pub.status === 404 && closed && shifts === 0, { waited, pub, closed, shifts });
    // A la vez (5 repeticiones): nunca queda un establecimiento cerrado con turnos vigentes.
    const out: Json[] = []; let ok = true;
    for (let i = 0; i < 5; i++) {
      const L2 = await establishment();
      await call("POST", `${W(L2, week)}/entries`, admin1.token, { startsAt: `${week}T07:00`, durationMinutes: 480 });
      const closer = new pg.Client({ connectionString: rt.toString() }); await closer.connect();
      const closeP = (async () => {
        await closer.query("BEGIN");
        await closer.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin','false',true)`, [admin1.userId, H]);
        try { await closer.query(`SELECT app_residential_close_establishment($1,'Cierre ficticio por prueba')`, [L2]); await closer.query("COMMIT"); return "OK"; }
        catch (e) { await closer.query("ROLLBACK"); return (e as Error).message.slice(0, 40); }
      })();
      const [pubR, closeR] = await Promise.all([call("POST", `${W(L2, week)}/publish`, admin2.token), closeP]);
      await closer.end();
      const c2 = (await q<{ c: boolean }>(`SELECT archived_at IS NOT NULL c FROM locations WHERE id=$1`, [L2])).rows[0].c;
      const live = (await q<{ n: number }>(`SELECT count(*)::int n FROM shifts s JOIN rooms r ON r.id = s.room_id JOIN units u ON u.id = r.unit_id
        WHERE u.location_id=$1 AND s.status NOT IN ('cancelled','completed') AND s.scheduled_end > now()`, [L2])).rows[0].n;
      const pass = !(c2 && live > 0) && ((pubR.status === 200) !== (closeR === "OK"));
      ok &&= pass; out.push({ publicar: pubR.status, cerrar: closeR, cerrado: c2, turnos: live });
    }
    check("K3b. Publicación y cierre a la vez (5 repeticiones): gana uno de los dos y nunca queda un establecimiento cerrado con turnos", ok, out);
    await rtc.end();
  }

  // K4. La misma cuidadora en dos establecimientos, turnos solapados, publicados a la vez por dos administradores.
  {
    const out: Json[] = []; let ok = true;
    for (let i = 0; i < 3; i++) {
      const wk = plusDays(week, 7 * (i + 2));
      const A1 = await establishment(), A2 = await establishment();
      const e1 = await call("POST", `${W(A1, wk)}/entries`, admin1.token, { startsAt: `${wk}T07:00`, durationMinutes: 480, membershipId: w1.owm });
      const e2 = await call("POST", `${W(A2, wk)}/entries`, admin2.token, { startsAt: `${wk}T09:00`, durationMinutes: 480, membershipId: w1.owm });
      const [p1, p2] = await Promise.all([call("POST", `${W(A1, wk)}/publish`, admin1.token), call("POST", `${W(A2, wk)}/publish`, admin2.token)]);
      const overlaps = (await q<{ n: number }>(`SELECT count(*)::int n FROM assignments a1 JOIN shifts s1 ON s1.id = a1.shift_id
        JOIN assignments a2 ON a2.organization_worker_membership_id = a1.organization_worker_membership_id AND a2.id <> a1.id
        JOIN shifts s2 ON s2.id = a2.shift_id
        WHERE a1.organization_worker_membership_id = $1 AND a1.response_status IN ('pending','accepted') AND a2.response_status IN ('pending','accepted')
          AND s1.status NOT IN ('cancelled','completed') AND s2.status NOT IN ('cancelled','completed')
          AND s1.scheduled_start < s2.scheduled_end AND s2.scheduled_start < s1.scheduled_end`, [w1.owm])).rows[0].n;
      const statuses = [p1.status, p2.status].sort();
      const loser = [p1, p2].find((r) => r.status === 409);
      const pass = e1.status === 201 && e2.status === 201 && statuses[0] === 200 && statuses[1] === 409 && loser?.body.error === "RESIDENTIAL_SCHEDULE_STAFF_CONFLICT" && overlaps === 0;
      ok &&= pass; out.push({ statuses, error: loser?.body.error, overlaps });
    }
    check("K4. La misma cuidadora en dos establecimientos con turnos solapados publicados a la vez: una publicación gana y la otra se rechaza entera (409 STAFF_CONFLICT); nunca asignaciones solapadas (3 repeticiones)", ok, out);
  }

  // K5. Borradores nunca visibles para el personal, ni siquiera mientras se publica otra semana.
  {
    const L = await establishment();
    const wkD = plusDays(week, 49), wkP = plusDays(week, 56);
    await call("POST", `${W(L, wkD)}/entries`, admin1.token, { startsAt: `${wkD}T07:00`, durationMinutes: 480, membershipId: w1.owm });
    await call("POST", `${W(L, wkP)}/entries`, admin1.token, { startsAt: `${wkP}T07:00`, durationMinutes: 480, membershipId: w1.owm });
    const [, mineDuring] = await Promise.all([call("POST", `${W(L, wkP)}/publish`, admin2.token), call("GET", `/organizations/${H}/me/shifts`, w1.token)]);
    const mineAfter = await call("GET", `/organizations/${H}/me/shifts`, w1.token);
    const starts = (r: { body: Json }) => (r.body.shifts ?? []).map((s: Json) => String(s.scheduledStart ?? s.scheduled_start ?? ""));
    const draftSeen = [...starts(mineDuring), ...starts(mineAfter)].some((s) => s.startsWith(wkD));
    const publishedSeen = starts(mineAfter).some((s) => s.startsWith(wkP));
    const staffTable = await (async () => {
      const c = new pg.Client({ connectionString: rt.toString() }); await c.connect();
      await c.query("BEGIN"); await c.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [w1.userId, H]);
      const r = await c.query(`SELECT (SELECT count(*)::int FROM schedule_week_shifts) e, (SELECT count(*)::int FROM schedule_weeks) w`);
      await c.query("ROLLBACK"); await c.end(); return r.rows[0];
    })();
    check("K5. Los borradores nunca llegan al personal (ni por la API durante una publicación concurrente ni leyendo las tablas del calendario con su sesión)",
      mineDuring.status === 200 && mineAfter.status === 200 && !draftSeen && publishedSeen && staffTable.e === 0 && staffTable.w === 0, { draftSeen, publishedSeen, staffTable });
  }

  check("K0. Ningún error 5xx", errors500.length === 0, errors500);
  server.close(); await pool.end(); await db.end();
  await srv.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await srv.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
