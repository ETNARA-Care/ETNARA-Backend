/**
 * Desactivar y reactivar una cuidadora (paso 1B, 30-oct-2026; corrección del 500 en #237).
 *
 * Calls the real Express app as each actor:
 *   - who may change the status: administradora y supervisora sí; la propia cuidadora, otra
 *     cuidadora, la familia y la administradora de otra agencia no (4xx, nada cambia);
 *   - the change is saved with its audit row (WORKER_MEMBERSHIP_STATUS_CHANGED), never a 500;
 *   - a deactivated caregiver loses, in that agency only: her shifts (list and detail), the
 *     person's profile, plan, records, private instructions and address, starting, «en camino»,
 *     writing records or incidents, accepting a pending shift, and every conversation (resident
 *     and direct), reading and writing;
 *   - her membership in another agency keeps working;
 *   - history stays for the agency: shifts, check-ins, her records and messages are still there and
 *     readable by the administradora, and no row is deleted or changed;
 *   - she cannot be assigned while inactive;
 *   - reactivating restores access to what is still current (her future shift, the direct thread).
 *
 * Synthetic data only, disposable databases only.
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> \
 *   AUTHZ_DB_MODE=superuser|app_runtime npx tsx scripts/verifyCaregiverDeactivation.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
const mode = process.env.AUTHZ_DB_MODE ?? "superuser";
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");
if (mode !== "superuser" && mode !== "app_runtime") throw new Error("AUTHZ_DB_MODE must be superuser or app_runtime");

type Json = Record<string, any>;
const results: { name: string; pass: boolean; detail: string }[] = [];
const notes: string[] = [];
const note = (s: string) => notes.push(s);
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });
const denied = (s: number) => s === 403 || s === 404 || s === 409 || s === 422;

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = async <T extends pg.QueryResultRow = any>(s: string, p: unknown[] = []) => (await db.query<T>(s, p)).rows;
  if (mode === "app_runtime") {
    const pw = randomBytes(24).toString("hex");
    await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${pw}'`);
    const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = pw;
    process.env.DATABASE_URL = u.toString();
  } else process.env.DATABASE_URL = adminUrl;

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
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: Json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    return { status: res.status, json, text };
  }

  // ------------------------------------------------------------------ fixtures
  const org = async (name: string) => (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name]))[0].id as string;
  const orgA = await org(`DEACT A ${tag}`);
  const orgB = await org(`DEACT B ${tag}`);
  // Features and an (empty) requirement set, so the checks measure access only. An agency with no
  // requirement set fails «Comenzar» with a 500: that is the next blocker, not this one.
  for (const o of [orgA, orgB]) {
    await q(`INSERT INTO organization_features (organization_id,feature_code,enabled) VALUES ($1,'SMARTMATCH',true) ON CONFLICT DO NOTHING`, [o]);
    await q(`INSERT INTO requirement_sets (organization_id,name) VALUES ($1,'Sin requisitos')`, [o]);
  }
  await q(`INSERT INTO organization_care_event_types (organization_id,care_event_type_id,is_enabled) SELECT $1,id,true FROM care_event_types WHERE code='MOOD' ON CONFLICT DO NOTHING`, [orgA]);

  type P = { key: string; userId: string; token: string; owm?: string; om: string };
  const login = async (email: string) => {
    const r = await call("POST", "/auth/login", "", { email, password });
    if (r.status !== 200) throw new Error(`login ${email} ${r.status}`);
    return r.json.token as string;
  };
  async function person(key: string, orgId: string, role: string, worker = false, userId?: string, workerId?: string): Promise<P & { workerId?: string }> {
    const email = `deact-${key}-${tag}@example.invalid`;
    const uid = userId ?? (await q(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash]))[0].id;
    const om = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [uid, orgId]))[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [om, orgId, role]);
    let owm: string | undefined; let wid = workerId;
    if (worker) {
      wid = wid ?? (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [uid, `Sintetica ${key}`]))[0].id;
      owm = (await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [wid, orgId]))[0].id;
    }
    return { key, userId: uid, token: userId ? "" : await login(email), owm, om, workerId: wid };
  }
  const admin = await person("admin", orgA, "ORGANIZATION_ADMIN");
  const sup = await person("sup", orgA, "SUPERVISOR");
  const fam = await person("fam", orgA, "FAMILY");
  const otherCg = await person("other-cg", orgA, "WORKER", true);
  const adminB = await person("admin-b", orgB, "ORGANIZATION_ADMIN");
  // The caregiver under test works for both agencies (same user and worker).
  const d = await person("d", orgA, "WORKER", true);
  const dB = await person("d-b", orgB, "WORKER", true, d.userId, d.workerId);
  const supTarget = await person("sup-target", orgA, "WORKER", true);

  const recipient = async (o: string, last: string) => (await q(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Sintetico',$2) RETURNING id`, [o, `${last}-${tag}`]))[0].id as string;
  const r1 = await recipient(orgA, "R1");
  const rB = await recipient(orgB, "RB");
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status,can_view_service_location) VALUES ($1,$2,$3,'hija','active',true)`, [fam.userId, orgA, r1]);
  const ADDRESS = `Calle Desactivada ${tag}`;
  await q(`INSERT INTO care_recipient_locations (organization_id,care_recipient_id,label,address_line,municipality,postal_code,latitude,longitude,is_primary,gps_confirmed_at,gps_confirmed_by_user_id)
           VALUES ($1,$2,'Casa',$3,'San Juan','00901',18.4655,-66.1057,true,now(),$4)`, [orgA, r1, ADDRESS, admin.userId]);
  await q(`INSERT INTO care_recipient_locations (organization_id,care_recipient_id,label,address_line,municipality,is_primary) VALUES ($1,$2,'Casa',$3,'Caguas',true)`, [orgB, rB, `Rival ${tag}`]);
  await q(`INSERT INTO care_plans (organization_id,care_recipient_id,version,plan_details,effective_from,status) VALUES ($1,$2,1,$3::jsonb,now()-interval '1 day','active')`,
    [orgA, r1, JSON.stringify({ summary: `PLAN-${tag}` })]);

  const method = (await q(`SELECT id FROM verification_methods WHERE code='CAREGIVER_SESSION'`))[0].id;
  const shift = async (o: string, r: string, startH: number, endH: number, status: string) =>
    (await q(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()+make_interval(mins=>$3::int),now()+make_interval(mins=>$4::int),$5) RETURNING id`,
      [o, r, Math.round(startH * 60), Math.round(endH * 60), status]))[0].id as string;
  const assign = async (o: string, s: string, owm: string, r: string, response: string) =>
    q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,response_status) VALUES ($1,$2,$3,$4,$5)`, [o, s, owm, r, response]);
  const verification = async (o: string, s: string, owm: string, type: string, hoursAgo: number) =>
    q(`INSERT INTO verification_events (organization_id,shift_id,organization_worker_membership_id,verification_method_id,event_type,occurred_at,created_at) VALUES ($1,$2,$3,$4,$5,now()-make_interval(mins=>$6::int),now()-make_interval(mins=>$6::int))`,
      [o, s, owm, method, type, Math.round(hoursAgo * 60)]);

  const S = {
    past: await shift(orgA, r1, -30, -26, "completed"),
    open: await shift(orgA, r1, -1, 3, "in_progress"),
    soon: await shift(orgA, r1, 0.5, 4, "confirmed"),
    future: await shift(orgA, r1, 48, 52, "confirmed"),
    pending: await shift(orgA, r1, 72, 76, "confirmed"),
    unassigned: await shift(orgA, r1, 96, 100, "unassigned"),
  };
  const SB = await shift(orgB, rB, 24, 28, "confirmed");
  await assign(orgA, S.past, d.owm!, r1, "accepted");
  await verification(orgA, S.past, d.owm!, "check_in", 30);
  await verification(orgA, S.past, d.owm!, "check_out", 26);
  await assign(orgA, S.open, d.owm!, r1, "accepted");
  await verification(orgA, S.open, d.owm!, "check_in", 1);
  await assign(orgA, S.soon, d.owm!, r1, "accepted");
  await assign(orgA, S.future, d.owm!, r1, "accepted");
  await assign(orgA, S.pending, d.owm!, r1, "pending");
  await assign(orgB, SB, dB.owm!, rB, "accepted");
  const moodType = (await q(`SELECT id FROM care_event_types WHERE code='MOOD'`))[0].id;
  const pastEvent = (await q(`INSERT INTO care_events (organization_id,shift_id,care_recipient_id,organization_worker_membership_id,care_event_type_id,occurred_at,note_text)
                              VALUES ($1,$2,$3,$4,$5,now()-interval '28 hours',$6) RETURNING id`, [orgA, S.past, r1, d.owm, moodType, `NOTA-${tag}`]))[0].id;
  for (const s of [S.soon, S.future]) await call("PUT", `/organizations/${orgA}/shifts/${s}/private-instructions`, admin.token, { instructions: `CLAVE-${tag}` });

  const A = `/organizations/${orgA}`;
  // Conversations: resident thread (agency opens, she joins while assigned) and direct thread.
  const resOpen = await call("POST", `${A}/care-recipients/${r1}/conversation`, admin.token, {});
  const resThread = (resOpen.json.conversation?.id ?? resOpen.json.conversationId) as string;
  if (!resThread) throw new Error(`resident thread not opened: ${resOpen.status} ${resOpen.text.slice(0, 120)}`);
  const dJoin = await call("POST", `${A}/care-recipients/${r1}/conversation`, d.token, {});
  await call("POST", `${A}/conversations/${resThread}/messages`, d.token, { body: `MSG-D-${tag}` });
  const directOpen = await call("POST", `${A}/workers/${d.owm}/conversation`, admin.token, {});
  const directThread = directOpen.json.conversationId as string;
  await call("POST", `${A}/conversations/${directThread}/messages`, admin.token, { body: `DIRECTO-${tag}` });
  await call("POST", `${A}/conversations/${directThread}/messages`, d.token, { body: `RESPUESTA-${tag}` });

  // ------------------------------------------------------------------ baseline (active)
  {
    const mine = await call("GET", `${A}/me/shifts`, d.token);
    check("activa: «Mis turnos» lista sus turnos vigentes", mine.status === 200 && [S.soon, S.future, S.open].every((s) => mine.text.includes(s)), `${mine.status}`);
    check("activa: abre el detalle del turno", (await call("GET", `${A}/shifts/${S.future}`, d.token)).status === 200);
    check("activa: ve la ficha de la persona", (await call("GET", `${A}/care-recipients/${r1}`, d.token)).status === 200);
    check("activa: ve el plan", (await call("GET", `${A}/care-recipients/${r1}/care-plan`, d.token)).text.includes(`PLAN-${tag}`));
    check("activa: ve las instrucciones privadas", (await call("GET", `${A}/shifts/${S.future}/private-instructions`, d.token)).text.includes(`CLAVE-${tag}`));
    check("activa: ve la dirección", (await call("GET", `${A}/shifts/${S.soon}/service-location`, d.token)).text.includes(ADDRESS));
    check("activa: entró a la conversación del residente", dJoin.status === 200, `${dJoin.status}`);
    check("activa: conversación directa abierta", directOpen.status < 300 && !!directThread, `${directOpen.status}`);
    const convs = await call("GET", `${A}/conversations`, d.token);
    check("activa: ve sus dos conversaciones", convs.text.includes(resThread) && convs.text.includes(directThread));
    check("activa: lee la conversación directa", (await call("GET", `${A}/conversations/${directThread}/messages`, d.token)).text.includes(`DIRECTO-${tag}`));
  }

  // ------------------------------------------------------------------ who may change the status
  const statusOf = async (owm: string) => (await q(`SELECT status FROM organization_worker_memberships WHERE id=$1`, [owm]))[0].status as string;
  const auditCount = async (owm: string) => Number((await q(`SELECT count(*) FROM audit_log WHERE action='WORKER_MEMBERSHIP_STATUS_CHANGED' AND entity_id=$1`, [owm]))[0].count);
  const deactivateBody = { status: "inactive", endedAt: new Date().toISOString() };
  for (const [who, token, url] of [
    ["la propia cuidadora", d.token, A],
    ["otra cuidadora", otherCg.token, A],
    ["la familia", fam.token, A],
    ["administradora de otra agencia (URL de A)", adminB.token, A],
    ["administradora de otra agencia (su URL)", adminB.token, `/organizations/${orgB}`],
  ] as const) {
    const r = await call("PATCH", `${url}/workers/${d.owm}`, token, deactivateBody);
    check(`no desactiva: ${who}`, denied(r.status) && (await statusOf(d.owm!)) === "active", `${r.status}`);
  }
  check("intentos rechazados: sin fila de auditoría", (await auditCount(d.owm!)) === 0);

  // Supervisor (policy 085: manages caregivers) on a separate caregiver, both directions.
  {
    const off = await call("PATCH", `${A}/workers/${supTarget.owm}`, sup.token, deactivateBody);
    check("supervisora desactiva (200, sin 500)", off.status === 200 && (await statusOf(supTarget.owm!)) === "inactive", `${off.status} ${off.text.slice(0, 80)}`);
    const on = await call("PATCH", `${A}/workers/${supTarget.owm}`, sup.token, { status: "active", endedAt: null });
    check("supervisora reactiva (200)", on.status === 200 && (await statusOf(supTarget.owm!)) === "active", `${on.status}`);
    check("supervisora: dos filas de auditoría", (await auditCount(supTarget.owm!)) === 2);
  }

  // Snapshot of history before deactivating.
  const snapshot = async () => (await q(`SELECT
      (SELECT count(*) FROM assignments WHERE organization_worker_membership_id=$1) a,
      (SELECT string_agg(shift_id::text||response_status, ',' ORDER BY shift_id) FROM assignments WHERE organization_worker_membership_id=$1) ar,
      (SELECT count(*) FROM verification_events WHERE organization_worker_membership_id=$1) v,
      (SELECT count(*) FROM care_events WHERE organization_worker_membership_id=$1) e,
      (SELECT count(*) FROM messages m WHERE m.message_thread_id IN ($2::uuid,$3::uuid)) m,
      (SELECT count(*) FROM message_thread_participants WHERE user_id=$4) p,
      (SELECT string_agg(id::text||status, ',' ORDER BY id) FROM shifts WHERE organization_id=$5) s`, [d.owm, resThread, directThread, d.userId, orgA]))[0];
  const before = await snapshot();

  // ------------------------------------------------------------------ deactivate (administradora)
  const off = await call("PATCH", `${A}/workers/${d.owm}`, admin.token, deactivateBody);
  check("administradora desactiva (200, sin 500)", off.status === 200 && off.json.membership?.status === "inactive", `${off.status} ${off.text.slice(0, 120)}`);
  const audit = (await q(`SELECT previous_value, new_value, actor_user_id FROM audit_log WHERE action='WORKER_MEMBERSHIP_STATUS_CHANGED' AND entity_id=$1`, [d.owm]))[0];
  check("auditoría: active → inactive, por la administradora", audit?.previous_value?.status === "active" && audit?.new_value?.status === "inactive" && audit?.actor_user_id === admin.userId, JSON.stringify(audit ?? {}));
  check("se guarda la fecha de baja", !!(await q(`SELECT ended_at FROM organization_worker_memberships WHERE id=$1`, [d.owm]))[0].ended_at);

  // ------------------------------------------------------------------ the deactivated caregiver (agency A)
  {
    const mine = await call("GET", `${A}/me/shifts`, d.token);
    const leaked = Object.entries(S).filter(([, s]) => mine.text.includes(s)).map(([k]) => k);
    check("desactivada: «Mis turnos» de A sin turnos", mine.status !== 200 || leaked.length === 0, `${mine.status} visibles=${leaked.join(",")}`);
    for (const [k, s] of Object.entries(S)) {
      const r = await call("GET", `${A}/shifts/${s}`, d.token);
      check(`desactivada: NO abre el turno ${k}`, denied(r.status), `${r.status}`);
    }
    const prof = await call("GET", `${A}/care-recipients/${r1}`, d.token);
    check("desactivada: NO ve la ficha", denied(prof.status), `${prof.status}`);
    const list = await call("GET", `${A}/care-recipients`, d.token);
    check("desactivada: lista de personas sin R1", !list.text.includes(r1), `${list.status}`);
    const plan = await call("GET", `${A}/care-recipients/${r1}/care-plan`, d.token);
    check("desactivada: NO ve el plan", !plan.text.includes(`PLAN-${tag}`), `${plan.status}`);
    const ev = await call("GET", `${A}/care-recipients/${r1}/care-events`, d.token);
    check("desactivada: NO lee los registros de la persona", !ev.text.includes(`NOTA-${tag}`), `${ev.status}`);
    for (const s of [S.soon, S.future]) {
      const pi = await call("GET", `${A}/shifts/${s}/private-instructions`, d.token);
      check("desactivada: NO ve instrucciones privadas", !pi.text.includes(`CLAVE-${tag}`), `${pi.status}`);
      const loc = await call("GET", `${A}/shifts/${s}/service-location`, d.token);
      check("desactivada: NO ve la dirección", !loc.text.includes(ADDRESS), `${loc.status}`);
    }
    const g = await call("GET", `/me/care-recipients/${r1}/service-location`, d.token);
    check("desactivada: NO ve la dirección por /me", !g.text.includes(ADDRESS), `${g.status}`);

    const vBefore = Number((await q(`SELECT count(*) FROM verification_events WHERE organization_worker_membership_id=$1`, [d.owm]))[0].count);
    const ci = await call("POST", `${A}/shifts/${S.soon}/check-in`, d.token, { verificationMethodCode: "CAREGIVER_SESSION" });
    check("desactivada: NO comienza el turno", denied(ci.status), `${ci.status} ${ci.text.slice(0, 80)}`);
    const route = await call("POST", `${A}/shifts/${S.soon}/journey/en-route`, d.token, {});
    check("desactivada: NO marca «en camino»", denied(route.status), `${route.status}`);
    const ce = await call("POST", `${A}/shifts/${S.open}/care-events`, d.token, { typeCode: "MOOD", careRecipientId: r1, payload: { mood: "Tranquilo" } });
    check("desactivada: NO registra cuidado en la visita abierta", denied(ce.status), `${ce.status}`);
    const inc = await call("POST", `${A}/incidents`, d.token, { careRecipientId: r1, severity: "low", description: "x" });
    check("desactivada: NO reporta incidente", denied(inc.status), `${inc.status}`);
    const resp = await call("POST", `${A}/me/shifts/${S.pending}/respond`, d.token, { decision: "accepted" });
    check("desactivada: NO acepta el turno pendiente", denied(resp.status), `${resp.status}`);
    const co = await call("POST", `${A}/shifts/${S.open}/check-out`, d.token, {});
    check("desactivada: NO cierra la visita abierta (la cierra la agencia)", denied(co.status), `${co.status} ${co.text.slice(0, 80)}`);
    const vAfter = Number((await q(`SELECT count(*) FROM verification_events WHERE organization_worker_membership_id=$1`, [d.owm]))[0].count);
    check("desactivada: ningún registro de entrada, llegada o salida creado", vAfter === vBefore, `${vBefore}→${vAfter}`);
    const jCount = Number((await q(`SELECT count(*) FROM shift_journey_events WHERE shift_id=$1`, [S.soon]).catch(() => [{ count: 0 }]))[0].count);
    check("desactivada: ningún «en camino» creado", jCount === 0, `${jCount}`);

    const convs = await call("GET", `${A}/conversations`, d.token);
    check("desactivada: NO ve las conversaciones de A", !convs.text.includes(resThread) && !convs.text.includes(directThread), `${convs.status}`);
    const cc = await call("GET", `${A}/caregiver-conversations`, d.token);
    check("desactivada: NO ve la conversación directa en su lista", !cc.text.includes(directThread), `${cc.status}`);
    for (const [k, t] of [["residente", resThread], ["directa", directThread]] as const) {
      const r = await call("GET", `${A}/conversations/${t}/messages`, d.token);
      check(`desactivada: NO lee la conversación ${k}`, denied(r.status), `${r.status}`);
      const w = await call("POST", `${A}/conversations/${t}/messages`, d.token, { body: `NO-${k}` });
      check(`desactivada: NO escribe en la conversación ${k}`, denied(w.status), `${w.status}`);
    }
    const st = await call("GET", `${A}/conversations/startable-recipients`, d.token);
    check("desactivada: sin destinatarios para escribir", !st.text.includes(r1), `${st.status}`);
    const start = await call("POST", `${A}/care-recipients/${r1}/conversation`, d.token, {});
    check("desactivada: NO inicia conversación", denied(start.status), `${start.status}`);
  }

  // ------------------------------------------------------------------ other agency unaffected
  {
    const B = `/organizations/${orgB}`;
    const mine = await call("GET", `${B}/me/shifts`, d.token);
    check("agencia B: su turno sigue en «Mis turnos»", mine.status === 200 && mine.text.includes(SB), `${mine.status}`);
    check("agencia B: abre su turno", (await call("GET", `${B}/shifts/${SB}`, d.token)).status === 200);
    check("agencia B: ve la ficha de su persona", (await call("GET", `${B}/care-recipients/${rB}`, d.token)).status === 200);
    const cross = await call("GET", `${B}/shifts/${S.future}`, d.token);
    check("agencia B: no alcanza turnos de A con su URL", denied(cross.status), `${cross.status}`);
  }

  // ------------------------------------------------------------------ history kept for the agency
  {
    const after = await snapshot();
    check("historial: ninguna fila borrada ni cambiada (asignaciones, entradas, registros, mensajes, turnos)", JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    check("administradora: abre el turno terminado", (await call("GET", `${A}/shifts/${S.past}`, admin.token)).status === 200);
    const evs = await call("GET", `${A}/care-recipients/${r1}/care-events`, admin.token);
    check("administradora: ve el registro que escribió la cuidadora", evs.text.includes(pastEvent) || evs.text.includes(`NOTA-${tag}`), `${evs.status}`);
    const vv = await call("GET", `${A}/shifts/${S.past}/visit-verification`, admin.token);
    check("administradora: ve la verificación de la visita terminada", vv.status === 200, `${vv.status}`);
    check("administradora: lee sus mensajes en la conversación del residente", (await call("GET", `${A}/conversations/${resThread}/messages`, admin.token)).text.includes(`MSG-D-${tag}`));
    check("administradora: lee la conversación directa", (await call("GET", `${A}/conversations/${directThread}/messages`, admin.token)).text.includes(`RESPUESTA-${tag}`));
    check("supervisora: lee la conversación del residente", (await call("GET", `${A}/conversations/${resThread}/messages`, sup.token)).text.includes(`MSG-D-${tag}`));
    check("familia: sigue leyendo la conversación del residente", (await call("GET", `${A}/conversations/${resThread}/messages`, fam.token)).text.includes(`MSG-D-${tag}`));
    const prof = await call("GET", `${A}/workers/${d.owm}`, admin.token);
    check("administradora: ve el perfil, «inactiva»", prof.status === 200 && prof.text.includes("inactive"), `${prof.status}`);
    const all = await call("GET", `${A}/workers`, admin.token);
    check("administradora: sigue en la lista de personal", all.text.includes(d.owm!), `${all.status}`);
    const asg = await call("POST", `${A}/shifts/${S.unassigned}/assignments`, admin.token, { organizationWorkerMembershipId: d.owm });
    check("no se le asignan turnos nuevos mientras está inactiva (4xx, sin 500)", asg.status >= 400 && asg.status < 500, `${asg.status} ${asg.text.slice(0, 80)}`);
    const dm = await call("POST", `${A}/workers/${d.owm}/conversation`, admin.token, {});
    note(`abrir conversación directa con la cuidadora inactiva → ${dm.status} ${dm.text.slice(0, 60)}`);
    const ops = await call("GET", `${A}/operations/center`, admin.token);
    note(`centro de operaciones: turnos futuros aceptados por la inactiva aparecen marcados = ${[S.soon, S.future].map((s) => ops.text.includes(s)).join("/")} (status ${ops.status})`);
    const sa = await call("GET", `${A}/shifts/${S.future}/assignments`, admin.token);
    note(`asignaciones del turno futuro para la agencia: ${sa.status}, ¿sigue aceptada por la inactiva? ${sa.text.includes(d.owm!)} ${sa.text.slice(0, 160)}`);
    const sl = await call("GET", `${A}/shifts`, admin.token);
    const row = (sl.json.shifts ?? []).find((x: Json) => x.id === S.future);
    note(`lista de turnos de la agencia, turno futuro: status=${row?.status} ${JSON.stringify(row ?? {}).slice(0, 200)}`);
  }

  // ------------------------------------------------------------------ reactivate
  {
    const on = await call("PATCH", `${A}/workers/${d.owm}`, admin.token, { status: "active", endedAt: null });
    check("administradora reactiva (200)", on.status === 200 && on.json.membership?.status === "active", `${on.status}`);
    check("auditoría: inactive → active", (await auditCount(d.owm!)) === 2);
    const mine = await call("GET", `${A}/me/shifts`, d.token);
    check("reactivada: vuelve a ver su turno futuro", mine.text.includes(S.future), `${mine.status}`);
    check("reactivada: abre el turno futuro", (await call("GET", `${A}/shifts/${S.future}`, d.token)).status === 200);
    check("reactivada: lee la conversación directa", (await call("GET", `${A}/conversations/${directThread}/messages`, d.token)).text.includes(`DIRECTO-${tag}`));
    check("reactivada: el turno terminado sigue fuera de su alcance (regla 081)", denied((await call("GET", `${A}/shifts/${S.past}`, d.token)).status));
    const ci = await call("POST", `${A}/shifts/${S.soon}/check-in`, d.token, { verificationMethodCode: "CAREGIVER_SESSION" });
    check("reactivada: puede comenzar el turno en horario (el rechazo anterior era por la baja)", ci.status >= 200 && ci.status < 300, `${ci.status} ${ci.text.slice(0, 100)}`);
  }

  server.close();
  await pool.end();
  await db.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `  (${r.detail})`}`);
  for (const i of notes) console.log(`INFO  ${i}`);
  console.log(`\n[${mode}] ${results.length - failed.length}/${results.length} pasan`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
