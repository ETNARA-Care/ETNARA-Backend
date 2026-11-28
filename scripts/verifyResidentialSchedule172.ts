/**
 * 172 · Hogares F2: calendario semanal del establecimiento. Datos FICTICIOS, base PROPIA desechable, aplicación real
 * por HTTP como app_runtime. Ningún correo real (Resend interceptado), ninguna salida de red.
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

/** Lunes (fecha local de Puerto Rico) dentro de n semanas a partir de la próxima. */
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
  const dbName = `etnara_sched_${randomBytes(4).toString("hex")}`;
  await srv.query(`CREATE DATABASE ${dbName}`);
  const su = new URL(serverUrl!); su.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: su.toString() }); await db.connect();
  { const log = console.log; console.log = () => undefined; try { await applyPendingMigrations(db, join(process.cwd(), "migrations")); } finally { console.log = log; } }
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const rt = new URL(su.toString()); rt.username = "app_runtime"; rt.password = runtimePassword;
  process.env.DATABASE_URL = rt.toString();
  const rtClient = new pg.Client({ connectionString: rt.toString() }); await rtClient.connect();

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const { resetFeatureWriteLimitForTests } = await import("../src/middleware/featureWriteLimit.js").catch(() => ({ resetFeatureWriteLimitForTests: () => undefined }));
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const errors500: string[] = [];
  const bodies: string[] = [];
  const call = async (method: string, path: string, token: string, body?: Json) => {
    (resetFeatureWriteLimitForTests as () => void)();
    const res = await realFetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); bodies.push(text);
    let json: Json = {}; try { json = JSON.parse(text); } catch { /* vacío */ }
    if (res.status >= 500) errors500.push(`${method} ${path} ${res.status} ${json.error ?? ""}`);
    return { status: res.status, body: json };
  };
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toLowerCase();
  const org = async (n: string, t: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2,'active') RETURNING id`, [n, t])).rows[0].id;
  const bls = (await q<{ id: string }>(`SELECT id FROM credential_types ORDER BY code LIMIT 1`)).rows[0].id;
  type P = { userId: string; token: string; owm?: string };
  const person = async (orgId: string, key: string, roles: string[], worker: "eligible" | "ineligible" | null = null): Promise<P> => {
    const email = `sc-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, orgId, roles]);
    let owm: string | undefined;
    if (worker) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Ficticia ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgId])).rows[0].id;
      if (worker === "eligible") await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'external_provider','active',current_date+365)`, [workerId, bls]);
    }
    const t = (await call("POST", "/auth/login", "", { email, password })).body.token as string;
    await call("POST", "/me/active-organization", t, { organizationId: orgId });
    return { userId, token: t, owm };
  };

  const H = await org(`Hogar Ficticio ${tag}`, "RESIDENTIAL_CARE_HOME"), H2 = await org(`Hogar Dos ${tag}`, "RESIDENTIAL_CARE_HOME"), A = await org(`Agencia Ficticia ${tag}`, "HOME_CARE_AGENCY");
  await q(`SELECT app_ops_authorize_modality_activation('INDEPENDENT_PROVIDER','verificador local','Prueba local con datos ficticios (163: candado)',5)`);
  await q(`UPDATE platform_modalities SET enabled=true WHERE code='INDEPENDENT_PROVIDER'`);
  const I = await org(`Independiente Ficticia ${tag}`, "INDEPENDENT_PROVIDER");
  await q(`UPDATE platform_modalities SET enabled=false WHERE code='INDEPENDENT_PROVIDER'`);
  for (const o of [H, H2, A]) {
    const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'Ficticia') RETURNING id`, [o])).rows[0].id;
    await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,false)`, [rs, bls]);
  }
  const L = (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,'Casa Calendario') RETURNING id`, [H])).rows[0].id;
  const L2 = (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,'Casa Dos') RETURNING id`, [H2])).rows[0].id;
  const tech = (await q<{ unit_id: string; room_id: string }>(`SELECT unit_id, room_id FROM establishment_technical_rooms WHERE location_id=$1`, [L])).rows[0];
  const adminH = await person(H, "admin-h", ["ORGANIZATION_ADMIN"]), w1 = await person(H, "w1", ["WORKER"], "eligible"), w2 = await person(H, "w2", ["WORKER"], "eligible"), w3 = await person(H, "w3", ["WORKER"], "ineligible");
  const adminH2 = await person(H2, "admin-h2", ["ORGANIZATION_ADMIN"]), adminA = await person(A, "admin-a", ["ORGANIZATION_ADMIN"]), adminI = await person(I, "admin-i", ["ORGANIZATION_ADMIN"]);
  const S = (o: string) => `/organizations/${o}/residential/schedule`;
  const week = futureMonday(1), week2 = plusDays(week, 7), week3 = plusDays(week, 14);
  const W = (o = H, l = L, w = week) => `${S(o)}/establishments/${l}/weeks/${w}`;

  // ---- Interruptor y modalidades -----------------------------------------------------------------------------
  const off = await call("GET", W(), adminH.token);
  check("G1. Con HOGAR_CALENDARIO apagado, el calendario no existe (404 FEATURE_NOT_ENABLED)", off.status === 404 && off.body.error === "FEATURE_NOT_ENABLED", off);
  for (const o of [H, H2]) await q(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'HOGAR_CALENDARIO',true)`, [o]);
  await q(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'HOGAR_CALENDARIO',false) ON CONFLICT DO NOTHING`, [A]);
  const agency = await call("GET", `${S(A)}/establishments`, adminA.token);
  const indep = await call("GET", `${S(I)}/establishments`, adminI.token);
  check("G2. Agencia e independiente: el calendario de hogares no existe para ellas (403 MODALITY_NOT_AVAILABLE)", agency.status === 403 && agency.body.error === "MODALITY_NOT_AVAILABLE" && indep.status === 403, [agency, indep]);
  const workerTry = await call("GET", W(), w1.token);
  check("G3. El personal no administra el calendario (403)", workerTry.status === 403, workerTry);

  // ---- Semana vacía, entradas y validaciones ---------------------------------------------------------------
  const estList = await call("GET", `${S(H)}/establishments`, adminH.token);
  const empty = await call("GET", W(), adminH.token);
  const tuesday = await call("GET", W(H, L, plusDays(week, 1)), adminH.token);
  check("S1. Lista de establecimientos y semana vacía; una semana que no empieza en lunes se rechaza (400)",
    estList.status === 200 && estList.body.establishments.length === 1 && empty.status === 200 && empty.body.schedule.week.status === "empty" && empty.body.schedule.entries.length === 0 && tuesday.status === 400, [estList.body, empty.body.schedule?.week, tuesday.status]);
  const night = await call("POST", `${W()}/entries`, adminH.token, { startsAt: `${week}T23:00`, durationMinutes: 480, membershipId: w1.owm, label: "Noche" });
  const day = await call("POST", `${W()}/entries`, adminH.token, { startsAt: `${plusDays(week, 1)}T07:00`, durationMinutes: 480, membershipId: w2.owm, label: "Día" });
  const full = await call("POST", `${W()}/entries`, adminH.token, { startsAt: `${plusDays(week, 2)}T07:00`, durationMinutes: 1440 });
  const tooLong = await call("POST", `${W()}/entries`, adminH.token, { startsAt: `${plusDays(week, 2)}T07:00`, durationMinutes: 1441 });
  const outside = await call("POST", `${W()}/entries`, adminH.token, { startsAt: `${plusDays(week, 7)}T07:00`, durationMinutes: 60 });
  check("S2. Entradas: nocturna (23:00–07:00), de día y de 24 h; más de 24 h (400) o fuera de la semana (409) se rechazan",
    night.status === 201 && day.status === 201 && full.status === 201 && tooLong.status === 400 && outside.status === 409 && outside.body.error === "RESIDENTIAL_SCHEDULE_OUTSIDE_WEEK", [night, day, full, tooLong.status, outside]);
  const s1 = (await call("GET", W(), adminH.token)).body.schedule;
  const byDay = Object.fromEntries(s1.summary.byDay.map((d: Json) => [d.date, d.minutes]));
  check("S3. Horas programadas: el turno de 23:00 a 07:00 reparte 1 h al lunes y 7 h al martes; total y por persona",
    byDay[week] === 60 && byDay[plusDays(week, 1)] === 420 + 480 && byDay[plusDays(week, 2)] === 1020 && byDay[plusDays(week, 3)] === 420 && s1.summary.totalMinutes === 480 + 480 + 1440
    && s1.summary.byWorker.find((w: Json) => w.membershipId === w1.owm)?.minutes === 480 && s1.summary.unassignedEntries === 1 && s1.week.status === "draft", s1.summary);
  const overlapEntry = await call("POST", `${W()}/entries`, adminH.token, { startsAt: `${plusDays(week, 1)}T05:00`, durationMinutes: 240, membershipId: w1.owm });
  const dupEntry = await call("POST", `${W()}/entries`, adminH.token, { startsAt: `${plusDays(week, 1)}T07:00`, durationMinutes: 480, membershipId: w2.owm });
  const s2 = (await call("GET", W(), adminH.token)).body.schedule;
  check("S4. Avisos: solape de la misma persona y duplicado exacto", s2.warnings.some((x: Json) => x.type === "overlap" && x.membershipId === w1.owm) && s2.warnings.some((x: Json) => x.type === "duplicate" && x.membershipId === w2.owm), s2.warnings);
  const pubBlocked = await call("POST", `${W()}/publish`, adminH.token);
  const techShifts0 = (await q<{ n: number }>(`SELECT count(*)::int n FROM shifts WHERE room_id=$1`, [tech.room_id])).rows[0].n;
  check("S5. Con solapes o duplicados no se publica nada (409 RESIDENTIAL_SCHEDULE_OVERLAP, con las entradas)", pubBlocked.status === 409 && pubBlocked.body.error === "RESIDENTIAL_SCHEDULE_OVERLAP" && Array.isArray(pubBlocked.body.details?.warnings) && techShifts0 === 0, [pubBlocked, techShifts0]);
  const mine0 = await call("GET", `/organizations/${H}/me/shifts`, w1.token);
  check("S6. En borrador nada es un turno: el personal no ve la semana", mine0.status === 200 && (mine0.body.shifts ?? []).length === 0, mine0);
  const delA = await call("DELETE", `${S(H)}/entries/${overlapEntry.body.entry.id}`, adminH.token);
  const delB = await call("DELETE", `${S(H)}/entries/${dupEntry.body.entry.id}`, adminH.token);
  check("S7. Quitar entradas en borrador las borra", delA.status === 200 && delB.status === 200 && (await call("GET", W(), adminH.token)).body.schedule.entries.length === 3, [delA.status, delB.status]);

  // ---- Publicar ------------------------------------------------------------------------------------------------------
  const pub1 = await call("POST", `${W()}/publish`, adminH.token);
  const techShifts1 = (await q<{ n: number }>(`SELECT count(*)::int n FROM shifts WHERE room_id=$1 AND status <> 'cancelled'`, [tech.room_id])).rows[0].n;
  const asg = (await q<{ n: number }>(`SELECT count(*)::int n FROM assignments a JOIN shifts s ON s.id=a.shift_id WHERE s.room_id=$1 AND a.response_status='pending'`, [tech.room_id])).rows[0].n;
  const notes1 = (await q<{ user_id: string; t: string }>(`SELECT user_id, notification_type t FROM notifications WHERE notification_type LIKE 'SCHEDULE_WEEK_%'`)).rows;
  check("S8. Publicar crea 3 turnos sobre la habitación técnica, 2 asignaciones con las reglas de siempre y avisa a las 2 personas",
    pub1.status === 200 && pub1.body.publication.version === 1 && pub1.body.publication.shiftsCreated === 3 && techShifts1 === 3 && asg === 2
    && notes1.length === 2 && notes1.every((n) => n.t === "SCHEDULE_WEEK_PUBLISHED") && new Set(notes1.map((n) => n.user_id)).size === 2, [pub1, techShifts1, asg, notes1]);
  const snap = (await q<{ snapshot: Json[] }>(`SELECT snapshot FROM schedule_week_publications WHERE version=1`)).rows[0]?.snapshot ?? [];
  check("S9. La versión guarda la foto de los turnos sin nombres ni datos de residentes", snap.length === 3 && snap.every((x) => Object.keys(x).sort().join() === "endsAt,membershipId,requiredRole,shiftId,startsAt"), snap);
  const mine1 = await call("GET", `/organizations/${H}/me/shifts`, w1.token);
  const myShift = (mine1.body.shifts ?? [])[0] ?? {};
  check("S10. Publicada, la persona ve su turno como del establecimiento («Casa Calendario»), sin residente ni habitación", mine1.status === 200 && mine1.body.shifts.length === 1 && myShift.establishment_name === "Casa Calendario" && myShift.care_recipient_id === null, myShift);
  const notesApi = await call("GET", "/me/notifications", w1.token);
  const n1 = (notesApi.body.items ?? notesApi.body.notifications ?? []).find((n: Json) => n.type === "SCHEDULE_WEEK_PUBLISHED" || n.notification_type === "SCHEDULE_WEEK_PUBLISHED");
  check("S11. El aviso es general: «Horario semanal publicado», sin residente", !!n1 && JSON.stringify(n1).includes("Horario semanal publicado") && (n1.care_recipient_id ?? null) === null, n1 ?? notesApi.body);
  const again = await call("POST", `${W()}/publish`, adminH.token);
  check("S12. Sin cambios no hay nada que publicar (409)", again.status === 409 && again.body.error === "RESIDENTIAL_SCHEDULE_NOTHING_TO_PUBLISH", again);

  // ---- Modificar una semana publicada ------------------------------------------------------------------------------
  const pubDayId = s1.entries.find((e: Json) => e.label === "Día").id;
  const moved = await call("PATCH", `${S(H)}/entries/${pubDayId}`, adminH.token, { startsAt: `${plusDays(week, 1)}T08:00` });
  const s3 = (await call("GET", W(), adminH.token)).body.schedule;
  check("S13. Cambiar una entrada publicada la sustituye (la anterior queda marcada) y la semana queda con cambios sin publicar",
    moved.status === 200 && moved.body.entry.replaced === true && s3.week.hasUnpublishedChanges === true && s3.entries.some((e: Json) => e.id === pubDayId && e.removed) && s3.entries.some((e: Json) => e.id === moved.body.entry.id && !e.published), [moved, s3.week]);
  const pub2 = await call("POST", `${W()}/publish`, adminH.token);
  const notes2 = (await q<{ user_id: string }>(`SELECT user_id FROM notifications WHERE notification_type='SCHEDULE_WEEK_UPDATED'`)).rows;
  const hist = await call("GET", `${W()}/publications`, adminH.token);
  check("S14. Volver a publicar: versión 2, cancela 1 turno y crea 1; avisa del cambio; historial con 2 versiones",
    pub2.status === 200 && pub2.body.publication.version === 2 && pub2.body.publication.shiftsCancelled === 1 && pub2.body.publication.shiftsCreated === 1 && notes2.some((n) => n.user_id === w2.userId)
    && hist.status === 200 && hist.body.publications.length === 2 && hist.body.publications[0].version === 2, [pub2, notes2, hist.body]);
  const inel = await call("POST", `${W()}/entries`, adminH.token, { startsAt: `${plusDays(week, 4)}T07:00`, durationMinutes: 480, membershipId: w3.owm });
  const pubInel = await call("POST", `${W()}/publish`, adminH.token);
  const v = (await q<{ version: number }>(`SELECT version FROM schedule_weeks WHERE location_id=$1 AND week_start=$2`, [L, week])).rows[0].version;
  const techShifts2 = (await q<{ n: number }>(`SELECT count(*)::int n FROM shifts WHERE room_id=$1 AND status <> 'cancelled'`, [tech.room_id])).rows[0].n;
  check("S15. Una persona no apta impide publicar (409 RESIDENTIAL_SCHEDULE_STAFF_NOT_ELIGIBLE, con la entrada) y no se publica nada",
    inel.status === 201 && pubInel.status === 409 && pubInel.body.error === "RESIDENTIAL_SCHEDULE_STAFF_NOT_ELIGIBLE" && pubInel.body.details?.entryIds?.[0] === inel.body.entry.id && v === 2 && techShifts2 === 3, [pubInel, v, techShifts2]);
  await call("DELETE", `${S(H)}/entries/${inel.body.entry.id}`, adminH.token);

  // ---- Plantillas y copia ----------------------------------------------------------------------------------------
  const slots = [1, 2, 3, 4, 5, 6, 7].flatMap((d) => [{ weekday: d, startTime: "07:00", durationMinutes: 480, headcount: 2, label: "Día" }, { weekday: d, startTime: "23:00", durationMinutes: 480, label: "Noche" }]);
  const tpl = await call("POST", `${S(H)}/establishments/${L}/templates`, adminH.token, { name: "Semana estándar", slots });
  const applied = await call("POST", `${W(H, L, week2)}/apply-template`, adminH.token, { templateId: tpl.body.template?.id });
  const s4 = (await call("GET", W(H, L, week2), adminH.token)).body.schedule;
  check("S16. Plantilla 24/7 (día ×2 y noche, 7 días) aplicada a una semana: 21 plazas y 168 h", tpl.status === 201 && applied.status === 200 && applied.body.applied.added === 21 && s4.entries.length === 21 && s4.summary.totalMinutes === 21 * 480, [tpl.status, applied.body, s4.summary?.totalMinutes]);
  const copied = await call("POST", `${W(H, L, week3)}/copy`, adminH.token, { fromWeekStart: week });
  const copyAgain = await call("POST", `${W(H, L, week3)}/copy`, adminH.token, { fromWeekStart: week });
  const s5 = (await call("GET", W(H, L, week3), adminH.token)).body.schedule;
  check("S17. Copiar la semana: mismas horas y personas, 14 días después; copiar sobre una semana con entradas se rechaza",
    copied.status === 200 && copied.body.copy.copied === 3 && s5.entries.length === 3 && s5.entries.every((e: Json) => !e.published) && s5.entries.some((e: Json) => e.membershipId === w1.owm && e.startsAt === `${plusDays(week3, 0)}T23:00`)
    && copyAgain.status === 409 && copyAgain.body.error === "RESIDENTIAL_SCHEDULE_WEEK_NOT_EMPTY", [copied.body, s5.entries?.map((e: Json) => e.startsAt), copyAgain]);
  const tplList = await call("GET", `${S(H)}/establishments/${L}/templates`, adminH.token);
  const tplArch = await call("PATCH", `${S(H)}/templates/${tpl.body.template.id}`, adminH.token, { archived: true });
  const applyArchived = await call("POST", `${W(H, L, plusDays(week, 21))}/apply-template`, adminH.token, { templateId: tpl.body.template.id });
  check("S18. Plantillas: lista, archivar y una archivada ya no se aplica", tplList.status === 200 && tplList.body.templates.length === 1 && tplArch.status === 200 && tplArch.body.template.archived === true && applyArchived.status === 404, [tplList.status, tplArch.body, applyArchived.status]);

  // ---- Aislamiento ---------------------------------------------------------------------------------------------------
  const crossRead = await call("GET", W(H2, L), adminH2.token);
  const crossEdit = await call("PATCH", `${S(H2)}/entries/${moved.body.entry.id}`, adminH2.token, { label: "x" });
  const crossTpl = await call("PATCH", `${S(H2)}/templates/${tpl.body.template.id}`, adminH2.token, { name: "x" });
  const ownWeek = await call("GET", W(H2, L2), adminH2.token);
  check("S19. Otro hogar no ve ni cambia el calendario, las entradas ni las plantillas del primero (404); el suyo sí",
    crossRead.status === 404 && crossEdit.status === 404 && crossTpl.status === 404 && ownWeek.status === 200 && ownWeek.body.schedule.entries.length === 0, [crossRead.status, crossEdit.status, crossTpl.status, ownWeek.status]);

  // ---- Guardas en la base de datos (app_runtime directo y propietario) -------------------------------------------------
  const pubEntry = (await q<{ id: string; shift_id: string }>(`SELECT id, shift_id FROM schedule_week_shifts WHERE shift_id IS NOT NULL AND removed_at IS NULL LIMIT 1`)).rows[0];
  const err = async (client: pg.Client, s: string, p: unknown[] = []) => { try { await client.query(s, p); return "OK"; } catch (e) { return (e as Error).message; } };
  const rtCtx = async (s: string, p: unknown[] = []) => {
    await rtClient.query("BEGIN");
    await rtClient.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [adminH.userId, H]);
    const r = await err(rtClient, s, p); await rtClient.query("ROLLBACK"); return r;
  };
  const g1 = await rtCtx(`UPDATE schedule_week_shifts SET starts_at = starts_at + interval '1 hour' WHERE id=$1`, [pubEntry.id]);
  const g2 = await rtCtx(`DELETE FROM schedule_week_shifts WHERE id=$1`, [pubEntry.id]);
  const g3 = await err(db, `UPDATE schedule_week_publications SET shift_count = 0`);
  const g4 = await err(db, `INSERT INTO schedule_weeks (organization_id, location_id, week_start) SELECT $1, l.id, $2::date FROM locations l LIMIT 0`, [A, week]);
  const aLoc = (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,'Sede Agencia') RETURNING id`, [A])).rows[0].id;
  const g5 = await err(db, `INSERT INTO schedule_weeks (organization_id, location_id, week_start) VALUES ($1,$2,$3::date)`, [A, aLoc, week]);
  const otherShift = (await q<{ id: string }>(`INSERT INTO shifts (organization_id, room_id, scheduled_start, scheduled_end) SELECT $1, r.id, now() + interval '30 days', now() + interval '30 days 1 hour' FROM rooms r JOIN units u ON u.id=r.unit_id WHERE u.location_id=$2 AND NOT app_is_technical_room(r.id) LIMIT 1 RETURNING id`, [H, L])).rows[0]?.id ?? null;
  const draft = (await q<{ id: string }>(`SELECT id FROM schedule_week_shifts WHERE shift_id IS NULL LIMIT 1`)).rows[0].id;
  const g6 = otherShift ? await err(db, `UPDATE schedule_week_shifts SET shift_id=$1 WHERE id=$2`, [otherShift, draft]) : "SKIP";
  const g7 = await rtCtx(`SELECT app_schedule_location_guard($1,$2)`, [H, L]);
  check("S20. Base de datos: una entrada publicada no se edita ni se borra (también app_runtime directo); las versiones son solo anexos; una agencia no puede tener calendario; las guardas no se ejecutan directamente",
    g1.includes("RESIDENTIAL_SCHEDULE_PUBLISHED_ENTRY") && g2.includes("RESIDENTIAL_SCHEDULE_PUBLISHED_ENTRY") && g3.includes("RESIDENTIAL_HISTORY_APPEND_ONLY") && g4 === "OK" && g5.includes("MODALITY_NOT_AVAILABLE")
    && (g6 === "SKIP" || g6.includes("RESIDENTIAL_SCHEDULE_SHIFT_MISMATCH")) && g7.includes("permission denied"), [g1, g2, g3, g5, g6, g7]);
  const supAgencyRls = await rtCtx(`INSERT INTO schedule_templates (organization_id, location_id, name) VALUES ($1,$2,'x')`, [H2, L2]);
  check("S21. RLS: el administrador de un hogar no escribe en otro hogar aunque use app_runtime directo", supAgencyRls !== "OK", supAgencyRls);

  // ---- Convención de la habitación técnica y no regresión ---------------------------------------------------------------
  const mgrList = await call("GET", `/organizations/${H}/shifts`, adminH.token);
  const listed = (mgrList.body.shifts ?? []).filter((s: Json) => s.establishment_name === "Casa Calendario" && s.status !== "cancelled");
  const closure = await call("GET", `/organizations/${H}/residential/establishments/${L}/closure-check`, adminH.token);
  check("S22. La lista de turnos de la administración presenta los del calendario como del establecimiento; el cierre los cuenta (no se puede cerrar con turnos futuros)",
    mgrList.status === 200 && listed.length === 3 && closure.status === 200 && closure.body.closure.futureShifts >= 3 && closure.body.closure.canClose === false, [mgrList.status, listed.length, closure.body]);
  const leaks = bodies.filter((b) => b.includes(tech.room_id) || b.includes(tech.unit_id) || b.includes("__etnara"));
  check("S23. Ninguna respuesta contiene la habitación ni la unidad técnicas", leaks.length === 0 && bodies.length > 40, `${leaks.length} de ${bodies.length}`);
  const recA = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Cliente','Ficticio') RETURNING id`, [A])).rows[0].id;
  const agencyShift = await call("POST", `/organizations/${A}/shifts`, adminA.token, { careRecipientId: recA, scheduledStart: new Date(Date.now() + 9 * 86_400_000).toISOString(), scheduledEnd: new Date(Date.now() + 9 * 86_400_000 + 3_600_000).toISOString() });
  const agencyList = await call("GET", `/organizations/${A}/shifts`, adminA.token);
  check("S24. Agencia sin cambios: crea y lista sus turnos como antes (sin nombre de establecimiento)", agencyShift.status === 201 && agencyList.status === 200 && agencyList.body.shifts.every((s: Json) => s.establishment_name === null), [agencyShift.status, agencyList.status]);
  check("Z1. Nunca un 500 en todo el recorrido", errors500.length === 0, errors500);

  server.close(); await pool.end(); await rtClient.end(); await db.end();
  await srv.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await srv.end();
}

main().then(() => {
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 1500)}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 1500)}`}`); console.error(e); process.exit(1); });
