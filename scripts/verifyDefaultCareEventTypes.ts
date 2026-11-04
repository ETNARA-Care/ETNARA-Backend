/**
 * 148: tipos de registro de cuidado por defecto (hallazgo A1, validación de agencias fundadoras, 4-nov-2026).
 *
 * Prueba con la app real y datos ficticios:
 *  - una agencia creada por ETNARA Central (HTTP) nace con los 8 tipos de Casa Demo, habilitados;
 *  - ciclo completo de esa agencia: administradora, política, cuidadora, residente, turno, asignación,
 *    inicio, los 7 registros que ofrece el portal (201), fin, familia que ve los registros;
 *  - PHOTO sigue rechazado con el módulo de fotos apagado y no deja ningún registro;
 *  - el disparador solo toca la agencia nueva; volver a aplicar 148 no cambia nada;
 *  - relleno: una agencia sin configuración la recibe; una con configuración propia (tipo apagado,
 *    etiqueta) queda EXACTAMENTE igual; una archivada no se toca;
 *  - app_runtime no puede ejecutar la función de 148 ni leer o escribir su registro, y una gestora no
 *    cambia la configuración de otra agencia.
 *
 * Bases desechables solamente:
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 *   DATABASE_URL = el mismo superusuario (como en producción antes del 31-oct) o app_runtime.
 */
import type { AddressInfo } from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { hashPassword } from "../src/security/password.js";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL, DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl + appUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>;
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });
const DEFAULTS = ["MEAL", "HYDRATION", "TOILETING", "MOBILITY", "ACTIVITY", "MOOD", "NOTE", "PHOTO"];
const PORTAL_TYPES: [string, Json | undefined][] = [
  ["MEAL", { mealType: "Almuerzo", amountConsumed: "Casi todo" }], ["HYDRATION", { amount: "Vaso completo" }],
  ["TOILETING", { result: "Sin novedad" }], ["MOBILITY", { activity: "Caminata corta" }],
  ["ACTIVITY", { label: "Lectura", durationMinutes: 15 }], ["MOOD", { mood: "Tranquilo" }], ["NOTE", undefined],
];
const M148 = readFileSync("migrations/148_default_care_event_types.sql", "utf8");

async function main() {
  const runtimeMode = new URL(appUrl!).username === "app_runtime";
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  const q = <T extends pg.QueryResultRow = Json>(s: string, p: unknown[] = []) => admin.query<T>(s, p);
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j: Json = {}; try { j = (await r.json()) as Json; } catch { /* sin cuerpo */ }
    return { s: r.status, j };
  };
  const login = async (email: string, password: string) => (await call("POST", "/auth/login", undefined, { email, password })).j.token as string;
  const tag = randomUUID().slice(0, 8);
  const pw = () => "Pw-" + randomBytes(12).toString("hex");
  const enabledCodes = async (org: string) => (await q<{ code: string }>(
    `SELECT cet.code FROM organization_care_event_types o JOIN care_event_types cet ON cet.id=o.care_event_type_id
      WHERE o.organization_id=$1 AND o.is_enabled ORDER BY cet.code`, [org])).rows.map((r) => r.code);
  const configOf = async (org: string) => JSON.stringify((await q(
    `SELECT care_event_type_id, is_enabled, label_override, display_order, is_required FROM organization_care_event_types
      WHERE organization_id=$1 ORDER BY care_event_type_id`, [org])).rows);
  // Las invitaciones viajan por correo (sin correo en la prueba): se fija un token conocido en la base desechable.
  const tokenFor = async (email: string) => {
    const t = randomBytes(32).toString("hex");
    await q(`UPDATE access_invitations SET token_hash=$1 WHERE lower(email)=lower($2) AND status='pending'`, [createHash("sha256").update(t).digest("hex"), email]);
    return t;
  };

  try {
    check("T00 148 registrada", (await q(`SELECT 1 FROM schema_migrations WHERE filename='148_default_care_event_types.sql'`)).rowCount === 1);
    const codes = (await q<{ c: string[] }>(`SELECT public.app_default_care_event_type_codes() c`)).rows[0].c;
    const inCatalog = (await q<{ n: number }>(`SELECT count(*)::int n FROM care_event_types WHERE code = ANY($1)`, [codes])).rows[0].n;
    check("T01 los 8 códigos por defecto son los de Casa Demo y existen en el catálogo", JSON.stringify([...codes].sort()) === JSON.stringify([...DEFAULTS].sort()) && inCatalog === 8, `${codes} / ${inCatalog}`);
    const demo = (await q<{ id: string }>(`SELECT id FROM organizations WHERE name LIKE 'Cuidado en Casa Demo%' ORDER BY created_at LIMIT 1`)).rows[0]?.id;
    if (demo) {
      const demoCodes = await enabledCodes(demo);
      check("T02 Casa Demo tiene habilitados los mismos 8", DEFAULTS.every((c) => demoCodes.includes(c)), demoCodes.join(","));
    }

    // ---------- agencia nueva creada por ETNARA Central (HTTP)
    const platPw = pw();
    const platUser = (await q<{ user_id: string }>(`SELECT user_id FROM platform_admins WHERE revoked_at IS NULL ORDER BY granted_at LIMIT 1`)).rows[0]?.user_id;
    if (!platUser) throw new Error("No platform admin in the disposable database");
    await q(`UPDATE users SET password_hash=$1 WHERE id=$2`, [await hashPassword(platPw), platUser]);
    const platEmail = (await q<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [platUser])).rows[0].email;
    const P = await login(platEmail, platPw);
    const totalBefore = (await q<{ n: number }>(`SELECT count(*)::int n FROM organization_care_event_types`)).rows[0].n;
    const created = await call("POST", "/platform/organizations", P, { name: `Fundadora ${tag}`, organizationType: "HOME_CARE_AGENCY", status: "trial" });
    const org = (created.j.organization ?? created.j).id as string;
    check("T10 Central crea la agencia (201)", created.s === 201, `${created.s}`);
    check("T11 la agencia nueva nace con los 8 tipos habilitados", JSON.stringify(await enabledCodes(org)) === JSON.stringify([...DEFAULTS].sort()), (await enabledCodes(org)).join(","));
    const grants = (await q<{ source: string; n: number }>(`SELECT source, count(*)::int n FROM care_event_type_default_grants WHERE organization_id=$1 GROUP BY 1`, [org])).rows;
    check("T12 quedan registrados como 'new_agency'", grants.length === 1 && grants[0].source === "new_agency" && grants[0].n === 8, JSON.stringify(grants));
    const totalAfter = (await q<{ n: number }>(`SELECT count(*)::int n FROM organization_care_event_types`)).rows[0].n;
    check("T13 el disparador solo añadió las 8 filas de esa agencia", totalAfter - totalBefore === 8, `${totalAfter - totalBefore}`);

    // ---------- ciclo completo de la agencia nueva
    const adminEmail = `dir-${tag}@fundadora.example`;
    const inv = await call("POST", `/platform/organizations/${org}/admin-invitations`, P, { email: adminEmail });
    const adminPw = pw();
    const act = await call("POST", "/platform/admin-invitations/activate", undefined, { token: await tokenFor(adminEmail), password: adminPw });
    const AD = await login(adminEmail, adminPw);
    check("T20 administradora invitada y activada", inv.s === 201 && act.s === 201 && !!AD, `${inv.s}/${act.s}`);
    const pol = await call("PUT", `/organizations/${org}/compliance/configuration`, AD, { workerRole: "CNA", requirements: [{ credentialTypeCode: "CPR", isMandatory: false, requiresOrganizationReview: true }] });
    const w = await call("POST", `/organizations/${org}/workers`, AD, { displayName: "Lucía Ficticia", internalRole: "CNA" });
    const mem = (w.j.membership ?? w.j).id as string;
    const cgEmail = `lucia-${tag}@fundadora.example`;
    const wi = await call("POST", `/organizations/${org}/access-invitations`, AD, { type: "worker", email: cgEmail, workerMembershipId: mem });
    const cgPw = pw();
    const wa = await call("POST", "/access-invitations/activate", undefined, { token: (wi.j.rawToken ?? wi.j.token ?? await tokenFor(cgEmail)) as string, password: cgPw });
    const CG = await login(cgEmail, cgPw);
    const r = await call("POST", `/organizations/${org}/care-recipients`, AD, { firstName: "Ana", lastName: "Ficticia", dateOfBirth: "1940-05-01" });
    const rec = (r.j.careRecipient ?? r.j.recipient ?? r.j).id as string;
    const now = Date.now();
    const sh = await call("POST", `/organizations/${org}/shifts`, AD, { careRecipientId: rec, scheduledStart: new Date(now - 20 * 60e3).toISOString(), scheduledEnd: new Date(now + 2 * 3600e3).toISOString(), requiredRole: "CNA" });
    const shift = (sh.j.shift ?? sh.j).id as string;
    const as = await call("POST", `/organizations/${org}/shifts/${shift}/assignments`, AD, { organizationWorkerMembershipId: mem });
    const ac = await call("POST", `/organizations/${org}/me/shifts/${shift}/respond`, CG, { decision: "accepted" });
    const ci = await call("POST", `/organizations/${org}/shifts/${shift}/check-in`, CG, { verificationMethodCode: "CAREGIVER_SESSION" });
    check("T21 política, cuidadora, residente, turno, asignación, aceptación e inicio", [pol.s, wa.s, ac.s].every((s) => s === 200) && [w.s, wi.s, r.s, sh.s, as.s, ci.s].every((s) => s === 201),
      JSON.stringify({ pol: pol.s, w: w.s, wi: wi.s, wa: wa.s, r: r.s, sh: sh.s, as: as.s, ac: ac.s, ci: ci.s }));
    const recorded: string[] = []; const refused: string[] = [];
    for (const [code, payload] of PORTAL_TYPES) {
      const e = await call("POST", `/organizations/${org}/shifts/${shift}/care-events`, CG, { typeCode: code, careRecipientId: rec, noteText: `Registro ficticio ${code}`, clientEventId: randomUUID(), ...(payload ? { payload } : {}) });
      (e.s === 201 ? recorded : refused).push(`${code}:${e.s}${e.s === 201 ? "" : " " + JSON.stringify(e.j)}`);
    }
    check("T22 los 7 registros del portal se guardan en la agencia nueva (antes 409 EVENT_TYPE_NOT_ENABLED)", refused.length === 0, refused.join(" ; "));
    const photoBefore = (await q<{ n: number }>(`SELECT count(*)::int n FROM care_events WHERE organization_id=$1`, [org])).rows[0].n;
    const ph = await call("POST", `/organizations/${org}/shifts/${shift}/care-events`, CG, { typeCode: "PHOTO", careRecipientId: rec, storedFileId: randomUUID(), clientEventId: randomUUID() });
    const ph2 = await call("POST", `/organizations/${org}/shifts/${shift}/care-events`, CG, { typeCode: "PHOTO", careRecipientId: rec, clientEventId: randomUUID() });
    const photoAfter = (await q<{ n: number }>(`SELECT count(*)::int n FROM care_events WHERE organization_id=$1`, [org])).rows[0].n;
    check("T23 PHOTO con el módulo de fotos apagado: rechazado y sin ningún registro guardado", ph.s >= 400 && ph.s < 500 && ph2.s >= 400 && ph2.s < 500 && photoAfter === photoBefore, `${ph.s} ${JSON.stringify(ph.j)} / ${ph2.s} / ${photoBefore}->${photoAfter}`);
    const co = await call("POST", `/organizations/${org}/shifts/${shift}/check-out`, CG, {});
    check("T24 fin de la visita", co.s === 201, `${co.s}`);
    const famEmail = `hija-${tag}@fundadora.example`;
    const fi = await call("POST", `/organizations/${org}/access-invitations`, AD, { type: "family", email: famEmail, careRecipientId: rec, relationshipType: "Hija" });
    const famPw = pw();
    const fa = await call("POST", "/access-invitations/activate", undefined, { token: (fi.j.rawToken ?? fi.j.token ?? await tokenFor(famEmail)) as string, password: famPw });
    const FM = await login(famEmail, famPw);
    const tl = await call("GET", `/organizations/${org}/care-recipients/${rec}/timeline?limit=50`, FM);
    const items = (tl.j.events ?? tl.j.items ?? []) as unknown[];
    check("T25 la familia ve los registros de cuidado en su cronología", fi.s === 201 && fa.s === 200 && tl.s === 200 && items.length >= 7, `${fi.s}/${fa.s}/${tl.s} eventos=${items.length}`);

    // ---------- seguridad
    // app_runtime sin tocar su contraseña: otra conexión del superusuario con SET LOCAL ROLE.
    const rt = new pg.Client({ connectionString: adminUrl }); await rt.connect();
    const attempt = async (s: string, p: unknown[] = []) => {
      try { await rt.query("BEGIN"); await rt.query("SET LOCAL ROLE app_runtime"); await rt.query(s, p); await rt.query("ROLLBACK"); return "ok"; }
      catch (e) { await rt.query("ROLLBACK").catch(() => undefined); return (e as { code?: string }).code ?? String(e); }
    };
    check("T30 app_runtime no puede ejecutar la función de aprovisionamiento", await attempt(`SELECT public.app_provision_default_care_event_types($1,'new_agency')`, [org]) === "42501");
    check("T31 app_runtime no lee ni escribe el registro de 148", await attempt(`SELECT * FROM care_event_type_default_grants`) === "42501" && await attempt(`DELETE FROM care_event_type_default_grants`) === "42501");
    // Una gestora de la agencia nueva intenta apagar los tipos de OTRA agencia en su contexto (029).
    const otherOrg = demo ?? (await q<{ id: string }>(`SELECT id FROM organizations WHERE id<>$1 LIMIT 1`, [org])).rows[0].id;
    const adminUser = (await q<{ id: string }>(`SELECT id FROM users WHERE lower(email)=lower($1)`, [adminEmail])).rows[0].id;
    const otherBefore = await configOf(otherOrg);
    await rt.query("BEGIN");
    await rt.query("SET LOCAL ROLE app_runtime");
    await rt.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [adminUser, org]);
    const upd = await rt.query(`UPDATE organization_care_event_types SET is_enabled=false WHERE organization_id=$1`, [otherOrg]).then((x) => x.rowCount, (e) => (e as { code?: string }).code);
    await rt.query("ROLLBACK").catch(() => undefined);
    check("T32 aislamiento: la gestora de una agencia no cambia los tipos de otra", (upd === 0 || upd === "42501") && (await configOf(otherOrg)) === otherBefore, `resultado=${upd}`);
    await rt.end();

    // ---------- relleno de agencias existentes e idempotencia (se vuelve a ejecutar el texto de 148)
    const mk = async (name: string, archived = false) => {
      await q("BEGIN"); await q("SET LOCAL session_replication_role = replica"); // sin disparadores: simula una agencia anterior a 148
      const id = (await q<{ id: string }>(`INSERT INTO organizations (name, organization_type, status, archived_at) VALUES ($1,'HOME_CARE_AGENCY','active',$2) RETURNING id`, [name, archived ? new Date() : null])).rows[0].id;
      await q("COMMIT"); return id;
    };
    const blank = await mk(`Sin configuración ${tag}`);
    const custom = await mk(`Configuración propia ${tag}`);
    const archived = await mk(`Archivada ${tag}`, true);
    check("T40 las agencias simuladas anteriores a 148 no tienen tipos", (await enabledCodes(blank)).length === 0 && (await configOf(custom)) === "[]" && (await configOf(archived)) === "[]");
    await q(`INSERT INTO organization_care_event_types (organization_id, care_event_type_id, is_enabled) SELECT $1, id, false FROM care_event_types WHERE code='MEAL'`, [custom]);
    await q(`INSERT INTO organization_care_event_types (organization_id, care_event_type_id, label_override, display_order) SELECT $1, id, 'Nota del turno', 3 FROM care_event_types WHERE code='NOTE'`, [custom]);
    const customBefore = await configOf(custom); const newBefore = await configOf(org);
    const grantsBefore = (await q<{ n: number }>(`SELECT count(*)::int n FROM care_event_type_default_grants`)).rows[0].n;
    let reapply = "ok"; try { await q("BEGIN"); await q(M148); await q("COMMIT"); } catch (e) { await q("ROLLBACK").catch(() => undefined); reapply = (e as Error).message; }
    check("T41 148 se puede volver a aplicar sin errores (idempotente)", reapply === "ok", reapply);
    check("T42 relleno: la agencia sin configuración recibe los 8, registrados como 'backfill_148'",
      JSON.stringify(await enabledCodes(blank)) === JSON.stringify([...DEFAULTS].sort())
      && (await q<{ n: number }>(`SELECT count(*)::int n FROM care_event_type_default_grants WHERE organization_id=$1 AND source='backfill_148'`, [blank])).rows[0].n === 8);
    check("T43 la agencia con configuración propia queda EXACTAMENTE igual (MEAL apagado, etiqueta, sin tipos añadidos)", (await configOf(custom)) === customBefore, await configOf(custom));
    check("T44 la agencia archivada no se toca", (await configOf(archived)) === "[]");
    check("T45 la agencia nueva no cambia al volver a aplicar 148", (await configOf(org)) === newBefore);
    const grantsAfter = (await q<{ n: number }>(`SELECT count(*)::int n FROM care_event_type_default_grants`)).rows[0].n;
    check("T46 el registro solo crece con la agencia rellenada (8)", grantsAfter - grantsBefore === 8, `${grantsAfter - grantsBefore}`);
    const dup = (await q<{ n: number }>(`SELECT count(*)::int n FROM (SELECT organization_id, care_event_type_id FROM organization_care_event_types GROUP BY 1,2 HAVING count(*)>1) d`)).rows[0].n;
    check("T47 ninguna configuración duplicada en toda la base", dup === 0, `${dup}`);
    const again = (await q<{ n: number }>(`SELECT public.app_provision_default_care_event_types($1,'backfill_148') n`, [org])).rows[0].n;
    check("T48 aprovisionar otra vez una agencia ya configurada inserta 0 filas", again === 0, `${again}`);
    const bad = await q(`SELECT public.app_provision_default_care_event_types($1,'otro')`, [org]).then(() => "ok", (e) => (e as Error).message);
    check("T49 la función rechaza un origen desconocido", /INVALID_PROVISIONING_SOURCE/.test(bad), bad);
  } finally {
    server.close();
    await admin.end();
  }
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `  (${r.detail})`}`);
  console.log(`\nDEFAULT_CARE_EVENT_TYPES (${runtimeMode ? "app_runtime" : "superuser"}) ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exit(1);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
