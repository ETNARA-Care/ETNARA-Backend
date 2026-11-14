/**
 * 154 — Centro operacional: resolución legítima de pendientes «Requiere atención».
 *
 * Calls the real Express app with real payloads (as each actor) against a DISPOSABLE database seeded
 * with bootstrap:staging + seedDemo (demo caregiver Carlos is eligible). Synthetic people and data only.
 * Run in both modes: app as superuser (production today) and as app_runtime (RLS applies).
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=<superuser url> DATABASE_URL=<app url> \
 *   DEMO_PASSWORD=<demo> npx tsx scripts/verifyOperationalPendingResolution.ts
 *
 * Covers: shifts ended without service (close as not covered / not performed, reasons, mandatory note,
 * who/when, immutability, history), no shift becomes «completed» without a real check-in, the audited
 * exceptional correction of an omitted check-in, a shift in progress unaffected, incidents (resolution
 * attributed, final, immutable story, serious incidents need follow-up + authorized closer), roles,
 * tenant isolation, the operations center counter, and the activation cutoff (no silent expiry, no
 * flood of old history).
 */
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

for (const name of ["DATABASE_URL", "MIGRATIONS_DATABASE_URL", "DEMO_PASSWORD"] as const) {
  if (!process.env[name]) throw new Error(`${name} is required.`);
}
if (process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
for (const u of [process.env.DATABASE_URL!, process.env.MIGRATIONS_DATABASE_URL!]) {
  if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(u)) throw new Error("Hosted database refused");
}

type Json = Record<string, any>;
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });
const HOUR = 3600;

async function main() {
  const runtimeMode = new URL(process.env.DATABASE_URL!).username === "app_runtime";
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const db = new pg.Client({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  await db.connect();
  const q = async (s: string, p: unknown[] = []) => (await db.query(s, p)).rows;
  const one = async (s: string, p: unknown[] = []) => (await db.query(s, p)).rows[0];
  const tag = randomUUID().slice(0, 8);
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  let activationBefore: string | null = null;

  async function call(method: string, path: string, token: string | null, body?: Json) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 120) }; }
    return { status: res.status, body: parsed, raw: text.slice(0, 220) };
  }
  const denied = (r: { status: number }) => r.status === 403 || r.status === 404;
  /** Runs SQL as app_runtime inside a request-like context; returns the SQLSTATE/message on error. */
  async function asRuntime(user: string, org: string, sqlText: string, params: unknown[] = []) {
    await db.query("BEGIN");
    try {
      await db.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [user, org]);
      await db.query("SET LOCAL ROLE app_runtime");
      const r = await db.query(sqlText, params);
      return `rows=${r.rowCount}`;
    } catch (e: any) {
      return `${e.code}:${String(e.message).slice(0, 60)}`;
    } finally {
      await db.query("ROLLBACK");
    }
  }
  async function superSql(sqlText: string, params: unknown[] = []) {
    await db.query("BEGIN");
    try { const r = await db.query(sqlText, params); await db.query("COMMIT"); return `rows=${r.rowCount}`; }
    catch (e: any) { await db.query("ROLLBACK"); return `${e.code}:${String(e.message).slice(0, 60)}`; }
  }

  try {
    await db.query("BEGIN"); await db.query("COMMIT"); // connection sanity
    // ------------------------------------------------------------------ fixtures
    const orgA = (await one(`SELECT om.organization_id FROM organization_memberships om JOIN users u ON u.id=om.user_id
      WHERE u.email='carlos@demo.etnara.care' AND om.status='active' ORDER BY om.created_at LIMIT 1`)).organization_id as string;
    const orgB = (await one(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`OPR B ${tag}`])).id as string;
    async function person(key: string, org: string, roles: string[], worker = false) {
      const email = `opr-${key}-${tag}@example.invalid`;
      const userId = (await one(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).id as string;
      const m = (await one(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, org])).id as string;
      await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, org, roles]);
      let owm: string | undefined;
      if (worker) {
        const w = (await one(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Sintética ${key}`])).id;
        owm = (await one(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [w, org])).id;
      }
      const login = await call("POST", "/auth/login", null, { email, password });
      if (login.status !== 200) throw new Error(`login ${key}: ${login.status}`);
      return { key, email, userId, membershipId: m, owm, token: login.body.token as string };
    }
    const admin = await person("admin", orgA, ["ORGANIZATION_ADMIN"]);
    const sup = await person("sup", orgA, ["SUPERVISOR"]);
    const cg2 = await person("cg2", orgA, ["WORKER"], true);
    const fam = await person("fam", orgA, ["FAMILY"]);
    const adminB = await person("admin-b", orgB, ["ORGANIZATION_ADMIN"]);
    const carlosLogin = await call("POST", "/auth/login", null, { email: "carlos@demo.etnara.care", password: process.env.DEMO_PASSWORD });
    const carlos = carlosLogin.body.token as string;
    await call("POST", "/me/active-organization", carlos, { organizationId: orgA });
    const carlosUser = (await one(`SELECT id FROM users WHERE email='carlos@demo.etnara.care'`)).id as string;
    const owm = (await one(`SELECT owm.id FROM organization_worker_memberships owm JOIN workers w ON w.id=owm.worker_id
      WHERE w.user_id=$1 AND owm.organization_id=$2`, [carlosUser, orgA])).id as string;
    const recipient = (await one(`INSERT INTO care_recipients (organization_id, first_name, last_name, status) VALUES ($1,'Pendiente',$2,'active') RETURNING id`, [orgA, `Prueba-${tag}`])).id as string;
    await q(`INSERT INTO family_relationships (organization_id, care_recipient_id, user_id, status, relationship_type)
             VALUES ($1,$2,$3,'active','child') ON CONFLICT DO NOTHING`, [orgA, recipient, fam.userId]).catch(() => undefined);

    async function shift(startOffsetH: number, hours: number, accepted: string | null, status = "confirmed") {
      const s = (await one(`INSERT INTO shifts (organization_id, care_recipient_id, scheduled_start, scheduled_end, status)
        VALUES ($1,$2, now() + make_interval(secs => $3), now() + make_interval(secs => $4), $5) RETURNING id`,
        [orgA, recipient, startOffsetH * HOUR, (startOffsetH + hours) * HOUR, accepted ? status : status === "confirmed" ? "unassigned" : status])).id as string;
      if (accepted) await q(`INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, response_status) VALUES ($1,$2,$3,'accepted')`, [orgA, s, accepted]);
      return s;
    }
    const P = `/organizations/${orgA}`;
    const center = async (token = admin.token) => {
      const r = await call("GET", `${P}/operations/center`, token);
      return { status: r.status, alerts: (r.body?.alerts ?? []) as Json[], summary: r.body?.summary as Json };
    };
    const snapshot = async (id: string) => one(`SELECT s.status, s.scheduled_start, s.scheduled_end, s.updated_at,
        (SELECT json_agg(json_build_object('m', a.organization_worker_membership_id, 'r', a.response_status) ORDER BY a.id) FROM assignments a WHERE a.shift_id=s.id) AS assignments,
        (SELECT count(*) FROM verification_events v WHERE v.shift_id = s.id)::int AS events,
        (SELECT count(*) FROM timesheets t WHERE t.shift_id = s.id)::int AS sheets
      FROM shifts s WHERE s.id = $1`, [id]);
    const closures = async (id: string) => Number((await one(`SELECT count(*) n FROM shift_attention_closures WHERE shift_id=$1`, [id])).n);
    const audits = async (action: string, entity: string) => Number((await one(`SELECT count(*) n FROM audit_log WHERE action=$1 AND entity_id=$2`, [action, entity])).n);

    // ================================================================= A. Ended shifts
    const uncovered = await shift(-3, 2, null);               // ended 1 h ago, nobody accepted
    const noShow = await shift(-4, 2, owm);                   // ended 2 h ago, Carlos accepted, no check-in
    const forCorrection = await shift(-5, 2, owm);            // ended 3 h ago, service did happen
    const ongoing = await shift(-0.5, 3, owm);                // in progress window
    const future = await shift(24, 2, null);
    const cancelled = await shift(-6, 2, null, "cancelled");
    const withCheckIn = await shift(-7, 2, owm);
    const method = (await one(`SELECT id FROM verification_methods WHERE code='CAREGIVER_SESSION'`)).id;
    await q(`INSERT INTO verification_events (organization_id,shift_id,organization_worker_membership_id,verification_method_id,event_type,occurred_at)
             VALUES ($1,$2,$3,$4,'check_in', now() - interval '6 hours')`, [orgA, withCheckIn, owm, method]);
    const tenDaysAgo = await shift(-24 * 10, 2, null);         // ended 10 days ago

    let c0 = await center();
    const keyOf = (id: string) => c0.alerts.find((a) => a.relatedEntityId === id);
    check("A1 Centro: «Turno terminado sin cubrir» aparece", c0.status === 200 && keyOf(uncovered)?.title === "Turno terminado sin cubrir", JSON.stringify(keyOf(uncovered)));
    check("A2 Centro: «Turno terminado sin registro de entrada» aparece", keyOf(noShow)?.title === "Turno terminado sin registro de entrada");
    check("A3 Centro: un turno terminado hace 10 días, ANTERIOR a la activación, no se acumula (regla de 7 días intacta)", !keyOf(tenDaysAgo));
    check("A4 Centro: el contador coincide con la lista", c0.summary?.total === c0.alerts.length, `${c0.summary?.total}/${c0.alerts.length}`);

    // Activation cutoff: move the activation back 30 days (disposable DB only), the 10-day-old shift now stays.
    activationBefore = (await one(`SELECT activated_at FROM operational_pending_activation`)).activated_at.toISOString();
    const immut = await superSql(`UPDATE operational_pending_activation SET activated_at = now()`);
    check("A5 La fecha de activación es inmutable (incluso para el propietario)", /OPERATIONAL_ACTIVATION_IMMUTABLE/.test(immut), immut);
    await q(`ALTER TABLE operational_pending_activation DISABLE TRIGGER operational_pending_activation_guard`);
    await q(`UPDATE operational_pending_activation SET activated_at = now() - interval '30 days'`);
    await q(`ALTER TABLE operational_pending_activation ENABLE TRIGGER operational_pending_activation_guard`);
    c0 = await center();
    check("A6 Tras la activación no hay expiración silenciosa: el de hace 10 días sigue hasta resolverse", !!keyOf(tenDaysAgo));

    const att = await call("GET", `${P}/shifts/${uncovered}/attention`, sup.token);
    check("A7 Detalle (supervisora): se puede cerrar, resultado «no cubierto», sin el motivo «el cuidador no se presentó»",
      att.status === 200 && att.body.canClose === true && att.body.outcome === "not_covered" && !att.body.allowedReasons.includes("caregiver_no_show") && att.body.allowedReasons.length === 4, att.raw);
    const attNs = await call("GET", `${P}/shifts/${noShow}/attention`, admin.token);
    check("A8 Detalle: con cuidador aceptado → «servicio no prestado», sin «no hubo cuidador disponible», con corrección excepcional disponible",
      attNs.status === 200 && attNs.body.outcome === "not_performed" && !attNs.body.allowedReasons.includes("no_caregiver_available") && attNs.body.canCorrectOmittedVisit === true, attNs.raw);
    for (const [who, tok] of [["cuidadora", carlos], ["familia", fam.token], ["otra agencia", adminB.token]] as const) {
      const r = await call("GET", `${P}/shifts/${uncovered}/attention`, tok);
      check(`A9 Detalle: ${who} sin acceso`, denied(r), `${r.status}`);
    }

    const before = await snapshot(uncovered);
    const note = "No hubo cuidador disponible; se avisó a la familia.";
    const attempts: Array<[string, string, string | null, Json, (r: any) => boolean]> = [
      ["cuidadora", carlos, uncovered, { reasonCode: "no_caregiver_available", note }, denied],
      ["familia", fam.token, uncovered, { reasonCode: "no_caregiver_available", note }, denied],
      ["otra agencia (ruta de A)", adminB.token, uncovered, { reasonCode: "no_caregiver_available", note }, denied],
      ["nota corta", admin.token, uncovered, { reasonCode: "no_caregiver_available", note: "corta" }, (r) => r.status === 400],
      ["«Otro» sin explicación suficiente", admin.token, uncovered, { reasonCode: "other", note: "Otro motivo xx" }, (r) => r.status === 400 && r.body.error === "SHIFT_CLOSURE_NOTE_REQUIRED"],
      ["motivo que no corresponde (no se presentó, sin cuidador)", admin.token, uncovered, { reasonCode: "caregiver_no_show", note }, (r) => r.status === 400 && r.body.error === "SHIFT_CLOSURE_REASON_INVALID"],
      ["motivo inexistente", admin.token, uncovered, { reasonCode: "x", note }, (r) => r.status === 400],
      ["turno futuro", admin.token, future, { reasonCode: "no_caregiver_available", note }, (r) => r.status === 409 && r.body.error === "SHIFT_CLOSURE_NOT_ENDED"],
      ["turno en curso", admin.token, ongoing, { reasonCode: "caregiver_no_show", note }, (r) => r.status === 409 && r.body.error === "SHIFT_CLOSURE_NOT_ENDED"],
      ["turno cancelado", admin.token, cancelled, { reasonCode: "no_caregiver_available", note }, (r) => r.status === 409 && r.body.error === "SHIFT_CLOSURE_NOT_CLOSABLE"],
      ["turno con registro de entrada", admin.token, withCheckIn, { reasonCode: "caregiver_no_show", note }, (r) => r.status === 409 && r.body.error === "SHIFT_CLOSURE_HAS_CHECK_IN"],
    ];
    for (const [label, tok, id, body, ok] of attempts) {
      const r = await call("POST", `${P}/shifts/${id}/close-without-service`, tok, body);
      check(`A10 Cerrar rechazado: ${label}`, ok(r) && (await closures(id!)) === 0, `${r.status} ${r.raw}`);
    }
    const viaB = await call("POST", `/organizations/${orgB}/shifts/${uncovered}/close-without-service`, adminB.token, { reasonCode: "no_caregiver_available", note });
    check("A11 Otra agencia por su propia ruta no encuentra el turno de A (404)", viaB.status === 404 && (await closures(uncovered)) === 0, `${viaB.status} ${viaB.raw}`);
    const direct = await asRuntime(admin.userId, orgA, `INSERT INTO shift_attention_closures (organization_id,shift_id,outcome,reason_code,note,closed_by_user_id) VALUES ($1,$2,'not_covered','other','Inserción directa sin la función',$3)`, [orgA, uncovered, admin.userId]);
    check("A12 app_runtime no puede insertar cierres directamente (solo la función auditada)", /^42501/.test(direct), direct);

    const closed = await call("POST", `${P}/shifts/${uncovered}/close-without-service`, sup.token, { reasonCode: "no_caregiver_available", note });
    const row = await one(`SELECT * FROM shift_attention_closures WHERE shift_id=$1`, [uncovered]);
    check("A13 Supervisora cierra «no cubierto»: 201, responsable, fecha, motivo y nota guardados",
      closed.status === 201 && row?.closed_by_user_id === sup.userId && row?.outcome === "not_covered" && row?.reason_code === "no_caregiver_available" && row?.note === note && !!row?.closed_at
        && closed.body.closure?.closedByEmail === sup.email, closed.raw);
    const after = await snapshot(uncovered);
    check("A14 El turno no se modifica (estado, horario, asignaciones, sin registros ni horas)", JSON.stringify(before) === JSON.stringify(after) && after.status === "unassigned" && after.events === 0 && after.sheets === 0, JSON.stringify(after));
    check("A15 Auditoría SHIFT_CLOSED_WITHOUT_SERVICE (sin el texto de la nota)", (await audits("SHIFT_CLOSED_WITHOUT_SERVICE", uncovered)) === 1
      && !JSON.stringify((await one(`SELECT new_value FROM audit_log WHERE action='SHIFT_CLOSED_WITHOUT_SERVICE' AND entity_id=$1`, [uncovered])).new_value).includes("familia"));
    let c1 = await center();
    check("A16 La alerta desaparece y el contador baja en 1", !c1.alerts.some((a) => a.relatedEntityId === uncovered) && c1.summary.total === c0.summary.total - 1, `${c0.summary.total}→${c1.summary.total}`);
    const again = await call("POST", `${P}/shifts/${uncovered}/close-without-service`, admin.token, { reasonCode: "family_cancelled", note });
    check("A17 Un segundo cierre se rechaza (409)", again.status === 409 && again.body.error === "SHIFT_CLOSURE_ALREADY_CLOSED", again.raw);
    for (const [label, s] of [["UPDATE", `UPDATE shift_attention_closures SET note='cambiada para ocultar' WHERE shift_id='${uncovered}'`], ["DELETE", `DELETE FROM shift_attention_closures WHERE shift_id='${uncovered}'`]]) {
      const r = await superSql(s);
      check(`A18 Cierre inmutable: ${label} rechazado incluso como propietario`, /SHIFT_CLOSURE_IMMUTABLE/.test(r), r);
    }
    const reschedule = await call("PATCH", `${P}/shifts/${uncovered}`, admin.token, { scheduledStart: new Date(Date.now() + 2 * 86400e3).toISOString(), scheduledEnd: new Date(Date.now() + 2 * 86400e3 + 7200e3).toISOString() });
    check("A19 Un turno cerrado no se puede reprogramar (para «revivir» la alerta)", reschedule.status === 409 && reschedule.body.error === "SHIFT_SCHEDULE_LOCKED", reschedule.raw);

    const ns = await call("POST", `${P}/shifts/${noShow}/close-without-service`, admin.token, { reasonCode: "caregiver_no_show", note: "La cuidadora no se presentó ni avisó." });
    check("A20 Administradora cierra «servicio no prestado» (el cuidador no se presentó)", ns.status === 201 && ns.body.closure?.outcome === "not_performed", ns.raw);
    const hist = await call("GET", `${P}/shift-closures`, admin.token);
    const hItem = (hist.body.closures ?? []).find((x: Json) => x.shiftId === uncovered);
    check("A21 Historial de cerrados: motivo, nota, responsable, horario y residente", hist.status === 200 && hItem?.reasonCode === "no_caregiver_available" && hItem?.closedByEmail === sup.email && !!hItem?.scheduledStart && /Pendiente/.test(hItem?.recipientName ?? ""), JSON.stringify(hItem));
    for (const [who, tok] of [["cuidadora", carlos], ["familia", fam.token], ["otra agencia", adminB.token]] as const) {
      const r = await call("GET", `${P}/shift-closures`, tok);
      check(`A22 Historial: ${who} sin acceso`, denied(r), `${r.status}`);
    }
    const histB = await call("GET", `/organizations/${orgB}/shift-closures`, adminB.token);
    check("A23 Otra agencia solo ve los suyos (0)", histB.status === 200 && histB.body.closures.length === 0, histB.raw);

    // ================================================================= R. Rectification of a closure made by mistake
    const firstClosure = await one(`SELECT * FROM shift_attention_closures WHERE shift_id=$1`, [uncovered]);
    const rPath = `${P}/shift-closures/${firstClosure.id}/rectify`;
    const rReason = "Cerrado por error: sí había cuidadora disponible esa tarde.";
    const rSup = await call("POST", rPath, sup.token, { reason: rReason });
    check("R1 Una supervisora no rectifica cierres (solo administradora, 403)", rSup.status === 403 && rSup.body.error === "SHIFT_CLOSURE_RECTIFY_FORBIDDEN", rSup.raw);
    for (const [who, tok] of [["cuidadora", carlos], ["familia", fam.token], ["otra agencia", adminB.token]] as const) {
      const r = await call("POST", rPath, tok, { reason: rReason });
      check(`R2 Rectificar: ${who} sin acceso`, denied(r), `${r.status}`);
    }
    const rB = await call("POST", `/organizations/${orgB}/shift-closures/${firstClosure.id}/rectify`, adminB.token, { reason: rReason });
    check("R3 Otra agencia por su propia ruta no encuentra el cierre (404)", rB.status === 404, rB.raw);
    const rShort = await call("POST", rPath, admin.token, { reason: "por error" });
    check("R4 Rectificar exige un motivo sustantivo (400)", rShort.status === 400, rShort.raw);
    const rDirect = await superSql(`UPDATE shift_attention_closures SET rectified_at=now(), rectified_by_user_id=$2, rectification_reason=$3, note='nota cambiada' WHERE id=$1`, [firstClosure.id, admin.userId, rReason]);
    check("R5 Ni el propietario puede cambiar el contenido original al rectificar", /SHIFT_CLOSURE_IMMUTABLE/.test(rDirect), rDirect);
    const rOk = await call("POST", rPath, admin.token, { reason: rReason });
    const afterR = await one(`SELECT * FROM shift_attention_closures WHERE id=$1`, [firstClosure.id]);
    check("R6 Administradora rectifica: el registro original se conserva intacto y suma quién, cuándo y por qué",
      rOk.status === 200 && afterR.note === firstClosure.note && afterR.closed_by_user_id === firstClosure.closed_by_user_id && afterR.reason_code === firstClosure.reason_code
        && new Date(afterR.closed_at).getTime() === new Date(firstClosure.closed_at).getTime()
        && afterR.rectified_by_user_id === admin.userId && afterR.rectification_reason === rReason && !!afterR.rectified_at
        && rOk.body.closure?.rectifiedByEmail === admin.email, rOk.raw);
    check("R7 Auditoría SHIFT_CLOSURE_RECTIFIED", (await audits("SHIFT_CLOSURE_RECTIFIED", uncovered)) === 1);
    const cR = await center();
    const attR = await call("GET", `${P}/shifts/${uncovered}/attention`, admin.token);
    check("R8 Tras rectificar, el turno vuelve a «Requiere atención» y se puede cerrar de nuevo",
      cR.alerts.some((a) => a.relatedEntityId === uncovered) && attR.body.closure === null && attR.body.canClose === true && attR.body.rectifiedClosures?.length === 1, attR.raw);
    const rAgain = await call("POST", rPath, admin.token, { reason: rReason });
    check("R9 Un cierre ya rectificado no se vuelve a rectificar (409)", rAgain.status === 409 && rAgain.body.error === "SHIFT_CLOSURE_ALREADY_RECTIFIED", rAgain.raw);
    for (const [label, q2] of [["UPDATE", `UPDATE shift_attention_closures SET rectification_reason='otra razón distinta y más larga' WHERE id='${firstClosure.id}'`], ["DELETE", `DELETE FROM shift_attention_closures WHERE id='${firstClosure.id}'`]]) {
      const r = await superSql(q2);
      check(`R10 Rectificación definitiva: ${label} rechazado incluso como propietario`, /SHIFT_CLOSURE_IMMUTABLE/.test(r), r);
    }
    const reClose = await call("POST", `${P}/shifts/${uncovered}/close-without-service`, sup.token, { reasonCode: "family_cancelled", note: "La familia canceló el servicio por la mañana." });
    const histR = await call("GET", `${P}/shift-closures`, admin.token);
    const both = (histR.body.closures ?? []).filter((x: Json) => x.shiftId === uncovered);
    check("R11 Nuevo cierre tras la rectificación; el historial conserva ambos (uno rectificado)",
      reClose.status === 201 && both.length === 2 && both.filter((x: Json) => x.rectifiedAt).length === 1 && both.some((x: Json) => !x.rectifiedAt && x.reasonCode === "family_cancelled"), `${reClose.status} ${both.length}`);
    const rFinal = await call("GET", `${P}/shifts/${uncovered}/attention`, sup.token);
    check("R12 Detalle: la supervisora ve el cierre activo y el rectificado, pero no puede rectificar", rFinal.body.closure?.reasonCode === "family_cancelled" && rFinal.body.rectifiedClosures.length === 1 && rFinal.body.canRectify === false, rFinal.raw);
    const shiftsList = await call("GET", `${P}/shifts`, admin.token);
    const rowOf = (id: string) => (shiftsList.body.shifts ?? []).find((x: Json) => x.id === id);
    const oneShift = await call("GET", `${P}/shifts/${uncovered}`, admin.token);
    check("R13 Turnos: «Cerrado sin servicio» identificado en la lista y en el detalle (y no en los demás)",
      rowOf(uncovered)?.closed_without_service === true && rowOf(noShow)?.closed_without_service === true && rowOf(future)?.closed_without_service === false && oneShift.body.shift?.closed_without_service === true, `${shiftsList.status}`);

    // ================================================================= B. Evidence of service
    const fake = await shift(-3, 2, null);
    const patch = await call("PATCH", `${P}/shifts/${fake}`, admin.token, { status: "completed" });
    check("B1 «Completado» sin registro de entrada: rechazado por la API (409)", patch.status === 409 && patch.body.error === "SHIFT_STATUS_REQUIRES_CHECK_IN" && (await snapshot(fake)).status === "unassigned", patch.raw);
    const patch2 = await call("PATCH", `${P}/shifts/${fake}`, admin.token, { status: "in_progress" });
    check("B2 «En curso» sin registro de entrada: rechazado (409)", patch2.status === 409 && patch2.body.error === "SHIFT_STATUS_REQUIRES_CHECK_IN", patch2.raw);
    const sqlFake = await superSql(`UPDATE shifts SET status='completed' WHERE id=$1`, [fake]);
    check("B3 …también directamente en la base, como propietario", /SHIFT_STATUS_REQUIRES_CHECK_IN/.test(sqlFake), sqlFake);
    const patchClosed = await call("PATCH", `${P}/shifts/${uncovered}`, admin.token, { status: "completed" });
    check("B4 Un turno cerrado sin servicio no puede pasar a «completado»", patchClosed.status === 409, patchClosed.raw);
    const patchCg = await call("PATCH", `${P}/shifts/${fake}`, carlos, { status: "completed" });
    check("B5 La cuidadora sigue sin poder cambiar estados por HTTP (403/404)", denied(patchCg), `${patchCg.status}`);

    // Late real evidence: an offline check-in made in time that syncs after the closure is kept and audited.
    const late = await superSql(`INSERT INTO verification_events (organization_id,shift_id,organization_worker_membership_id,verification_method_id,event_type,occurred_at,recorded_offline)
      VALUES ($1,$2,$3,$4,'check_in', now() - interval '3 hours', true)`, [orgA, noShow, owm, method]);
    const attLate = await call("GET", `${P}/shifts/${noShow}/attention`, admin.token);
    check("B6 Un registro real que llega después del cierre se conserva y se audita la contradicción",
      late === "rows=1" && (await audits("SHIFT_CLOSURE_CONTRADICTED_BY_CHECK_IN", noShow)) === 1 && attLate.body.closureContradicted === true && (await closures(noShow)) === 1, `${late} ${attLate.raw}`);

    // ================================================================= C. Exceptional correction (service did happen)
    const corrBad: Array<[string, string, string, Json, (r: any) => boolean]> = [
      ["cuidadora", carlos, forCorrection, { organizationWorkerMembershipId: owm, reason: "La visita sí ocurrió, faltó registrar." }, denied],
      ["motivo corto", admin.token, forCorrection, { organizationWorkerMembershipId: owm, reason: "sí ocurrió" }, (r) => r.status === 400],
      ["cuidadora sin asignación aceptada", admin.token, forCorrection, { organizationWorkerMembershipId: cg2.owm!, reason: "La visita sí ocurrió, faltó registrar." }, (r) => r.status === 409 && r.body.error === "NO_ACCEPTED_ASSIGNMENT"],
      ["turno en curso (usa el flujo normal)", admin.token, ongoing, { organizationWorkerMembershipId: owm, reason: "La visita sí ocurrió, faltó registrar." }, (r) => r.status === 409 && r.body.error === "SHIFT_NOT_ENDED"],
      ["turno cerrado sin servicio", admin.token, uncovered, { organizationWorkerMembershipId: owm, reason: "La visita sí ocurrió, faltó registrar." }, (r) => r.status === 409 && r.body.error === "SHIFT_CLOSED_WITHOUT_SERVICE"],
      ["otra agencia", adminB.token, forCorrection, { organizationWorkerMembershipId: owm, reason: "La visita sí ocurrió, faltó registrar." }, denied],
    ];
    for (const [label, tok, id, body, ok] of corrBad) {
      const before2 = await snapshot(id);
      const r = await call("POST", `${P}/shifts/${id}/verification/omitted-visit-correction`, tok, body);
      check(`C1 Corrección rechazada: ${label}`, ok(r) && JSON.stringify(before2) === JSON.stringify(await snapshot(id)), `${r.status} ${r.raw}`);
    }
    const t0 = Date.now();
    const reason = "La cuidadora confirmó por teléfono la visita; la familia lo corrobora.";
    const corr = await call("POST", `${P}/shifts/${forCorrection}/verification/omitted-visit-correction`, sup.token, { organizationWorkerMembershipId: owm, reason });
    const evs = await q(`SELECT v.event_type, v.occurred_at, v.actor_user_id, v.actor_context, m.code, o.reason, o.authorized_by_user_id
      FROM verification_events v JOIN verification_methods m ON m.id=v.verification_method_id LEFT JOIN verification_overrides o ON o.verification_event_id=v.id
      WHERE v.shift_id=$1 ORDER BY v.occurred_at`, [forCorrection]);
    const realTime = evs.every((e) => Math.abs(new Date(e.occurred_at).getTime() - t0) < 60_000);
    check("C2 Corrección (supervisora): entrada y salida etiquetadas SUPERVISOR_OVERRIDE, con la hora REAL de la corrección, motivo y responsable",
      corr.status === 201 && evs.length === 2 && evs[0].event_type === "check_in" && evs[1].event_type === "check_out"
        && evs.every((e) => e.code === "SUPERVISOR_OVERRIDE" && e.actor_context === "omitted_visit_correction" && e.reason === reason && e.authorized_by_user_id === sup.userId)
        && realTime && new Date(evs[1].occurred_at) > new Date(evs[0].occurred_at), `${corr.status} ${corr.raw} ${JSON.stringify(evs.map((e) => [e.event_type, e.code]))}`);
    const sheet = await one(`SELECT status, recorded_minutes, approved_minutes FROM timesheets WHERE shift_id=$1`, [forCorrection]);
    check("C3 Hoja de horas «pendiente» (sin minutos aprobados): nada se factura hasta que una administradora indique las horas reales",
      sheet?.status === "pending" && sheet?.approved_minutes === null && Number(sheet?.recorded_minutes) === 1, JSON.stringify(sheet));
    check("C4 Auditoría de ambas correcciones (VERIFICATION_OVERRIDE_RECORDED ×2)", (await audits("VERIFICATION_OVERRIDE_RECORDED", forCorrection)) === 2);
    check("C5 El turno queda «completado» solo porque ahora existe evidencia registrada", (await snapshot(forCorrection)).status === "completed");
    const c2 = await center();
    check("C6 Centro: la alerta del turno desaparece y aparece «Horas por revisar»",
      !c2.alerts.some((a) => a.relatedEntityId === forCorrection) && c2.alerts.some((a) => a.category === "pending_timesheet"), `${c2.alerts.length}`);
    const corrAgain = await call("POST", `${P}/shifts/${forCorrection}/verification/omitted-visit-correction`, admin.token, { organizationWorkerMembershipId: owm, reason });
    check("C7 No se puede repetir la corrección (409)", corrAgain.status === 409, corrAgain.raw);

    // Existing supervisor override keeps working (now audited).
    const ov = await call("POST", `${P}/shifts/${ongoing}/verification/supervisor-override`, admin.token, { organizationWorkerMembershipId: cg2.owm, eventType: "check_in", reason: "Corrección administrativa auditada de prueba" });
    check("C8 La corrección administrativa existente sigue disponible y ahora queda en audit_log", ov.status === 201 && (await audits("VERIFICATION_OVERRIDE_RECORDED", ongoing)) === 1, ov.raw);

    // ================================================================= D. A shift in progress is unaffected
    const inProgress = await shift(-0.25, 2, owm);
    const ci = await call("POST", `${P}/shifts/${inProgress}/check-in`, carlos, { verificationMethodCode: "CAREGIVER_SESSION" });
    const midStatus = (await snapshot(inProgress)).status;
    const co = await call("POST", `${P}/shifts/${inProgress}/check-out`, carlos, {});
    const done = await snapshot(inProgress);
    check("D1 Turno en horario: comenzar (201, «en curso») y finalizar (201, «completado», hoja de horas) como siempre",
      ci.status === 201 && midStatus === "in_progress" && co.status === 201 && done.status === "completed" && done.sheets === 1, `${ci.status}/${co.status} ${midStatus}/${done.status}`);
    const attOn = await call("GET", `${P}/shifts/${ongoing}/attention`, admin.token);
    check("D2 Un turno en curso no ofrece cierre ni corrección", attOn.status === 200 && attOn.body.canClose === false && attOn.body.canCorrectOmittedVisit === false, attOn.raw);

    // ================================================================= E. Incidents
    async function incident(severity: string) {
      return (await one(`INSERT INTO incidents (organization_id, care_recipient_id, organization_worker_membership_id, severity, description)
        VALUES ($1,$2,$3,$4,$5) RETURNING id`, [orgA, recipient, owm, severity, `Incidente ficticio ${severity} ${tag}`])).id as string;
    }
    const iMed = await incident("medium");
    const iHigh = await incident("high");
    const iHigh2 = await incident("Alta");
    let c3 = await center();
    const inc = (id: string) => c3.alerts.find((a) => a.relatedEntityId === id);
    check("E1 Centro: incidentes pendientes visibles; graves como críticos (high y «Alta»)", inc(iMed)?.severity === "warning" && inc(iHigh)?.severity === "critical" && inc(iHigh2)?.severity === "critical");
    const startOpen = await asRuntime(admin.userId, orgA, `INSERT INTO incidents (organization_id, care_recipient_id, organization_worker_membership_id, severity, description, status)
      VALUES ($1,$2,$3,'low','Nace resuelto','resolved')`, [orgA, recipient, owm]);
    check("E2 Desde la app un incidente siempre nace abierto", /INCIDENT_MUST_START_OPEN/.test(startOpen), startOpen);

    const cgRes = await call("POST", `${P}/incidents/${iMed}/status`, carlos, { status: "resolved", resolution: "Resuelto por la cuidadora" });
    check("E3 La cuidadora no resuelve incidentes (API)", denied(cgRes), `${cgRes.status}`);
    const cgSql = await asRuntime(carlosUser, orgA, `UPDATE incidents SET status='resolved', resolution='Cerrado por la cuidadora directamente', resolved_by_user_id=$2, resolved_at=now() WHERE id=$1`, [iMed, carlosUser]);
    check("E4 …ni directamente en la base (la RLS o la guarda lo impiden)", cgSql === "rows=0" || /INCIDENT_STATUS_FORBIDDEN/.test(cgSql), cgSql);
    const famRes = await call("POST", `${P}/incidents/${iMed}/status`, fam.token, { status: "resolved", resolution: "Resuelto por la familia" });
    check("E5 La familia no resuelve incidentes", denied(famRes), `${famRes.status}`);
    const bRes = await call("POST", `/organizations/${orgB}/incidents/${iMed}/status`, adminB.token, { status: "resolved", resolution: "Resuelto por otra agencia" });
    const bRes2 = await call("POST", `${P}/incidents/${iMed}/status`, adminB.token, { status: "resolved", resolution: "Resuelto por otra agencia" });
    check("E6 Otra agencia no resuelve (404 por su ruta, 403 por la de A)", bRes.status === 404 && denied(bRes2), `${bRes.status}/${bRes2.status}`);

    const shortRes = await call("POST", `${P}/incidents/${iMed}/status`, sup.token, { status: "resolved", resolution: "ok ya" });
    check("E7 Resolución sin nota sustantiva (menos de 10 caracteres): 400", shortRes.status === 400 && shortRes.body.error === "INCIDENT_RESOLUTION_TOO_SHORT", shortRes.raw);
    const medRes = await call("POST", `${P}/incidents/${iMed}/status`, sup.token, { status: "resolved", resolution: "Se revisó con la familia y el médico." });
    const medRow = await one(`SELECT status, resolution, resolved_by_user_id, resolved_at FROM incidents WHERE id=$1`, [iMed]);
    const tl = await q(`SELECT entry_text, created_by_user_id FROM incident_timeline_entries WHERE incident_id=$1`, [iMed]);
    check("E8 Supervisora resuelve un incidente no grave: responsable y fecha guardados, nota en el seguimiento",
      medRes.status === 200 && medRow.status === "resolved" && medRow.resolved_by_user_id === sup.userId && !!medRow.resolved_at
        && tl.some((e) => /Incidente resuelto/.test(e.entry_text) && e.created_by_user_id === sup.userId), medRes.raw);
    check("E9 Auditoría INCIDENT_RESOLVED", (await audits("INCIDENT_RESOLVED", iMed)) === 1);
    c3 = await center();
    check("E10 La alerta del incidente resuelto desaparece", !inc(iMed) && !!inc(iHigh));
    const reAssign = await call("POST", `${P}/incidents/${iMed}/assign`, admin.token, { assignedToUserId: sup.userId });
    check("E11b Asignar un incidente resuelto: 409 claro (nunca 500)", reAssign.status === 409 && reAssign.body.error === "INCIDENT_RESOLVED_IS_FINAL", reAssign.raw);
    const reRes = await call("POST", `${P}/incidents/${iMed}/status`, admin.token, { status: "resolved", resolution: "Otra resolución distinta" });
    check("E11 Un incidente resuelto es definitivo (409)", reRes.status === 409, reRes.raw);
    for (const [label, s, code] of [
      ["reabrir", `UPDATE incidents SET status='open' WHERE id='${iMed}'`, "INCIDENT_RESOLVED_IS_FINAL"],
      ["borrar", `DELETE FROM incidents WHERE id='${iMed}'`, "INCIDENT_NOT_DELETABLE"],
      ["cambiar la descripción de uno abierto", `UPDATE incidents SET description='otra historia' WHERE id='${iHigh}'`, "INCIDENT_RECORD_IMMUTABLE"],
      ["bajar la gravedad para evitar la revisión", `UPDATE incidents SET severity='low' WHERE id='${iHigh}'`, "INCIDENT_RECORD_IMMUTABLE"],
    ] as const) {
      const r = await superSql(s);
      check(`E12 Base (propietario): ${label} → rechazado`, r.includes(code), r);
    }

    // Serious incident: follow-up + authorized closer.
    const rulesSup = await call("GET", `${P}/incidents/${iHigh}/resolution-rules`, sup.token);
    check("E13 Reglas (supervisora sin autorización): grave, no puede cerrarlo, sin seguimiento, mínimo 30",
      rulesSup.status === 200 && rulesSup.body.rules.serious === true && rulesSup.body.rules.canCloseSerious === false && rulesSup.body.rules.hasDocumentedFollowUp === false && rulesSup.body.rules.minResolutionLength === 30, rulesSup.raw);
    const rulesCg = await call("GET", `${P}/incidents/${iHigh}/resolution-rules`, carlos);
    check("E14 Reglas: la cuidadora no las consulta", denied(rulesCg), `${rulesCg.status}`);
    const longRes = "Se revisó al residente, se notificó a la familia y al médico; sin lesiones.";
    const supHigh = await call("POST", `${P}/incidents/${iHigh}/status`, sup.token, { status: "resolved", resolution: longRes });
    check("E15 Supervisora sin autorización no cierra un grave (403)", supHigh.status === 403 && supHigh.body.error === "INCIDENT_SERIOUS_CLOSER_REQUIRED", supHigh.raw);
    const adminDirect = await call("POST", `${P}/incidents/${iHigh}/status`, admin.token, { status: "resolved", resolution: longRes });
    check("E16 Ni la administradora cierra un grave sin seguimiento (409)", adminDirect.status === 409 && adminDirect.body.error === "INCIDENT_SERIOUS_FOLLOW_UP_REQUIRED", adminDirect.raw);
    const start = await call("POST", `${P}/incidents/${iHigh}/status`, sup.token, { status: "in_progress" });
    check("E17 Supervisora inicia el seguimiento (auditado)", start.status === 200 && (await audits("INCIDENT_FOLLOW_UP_STARTED", iHigh)) === 1, start.raw);
    const noNote = await call("POST", `${P}/incidents/${iHigh}/status`, admin.token, { status: "resolved", resolution: longRes });
    check("E18 En seguimiento pero sin nota documentada: sigue rechazado", noNote.status === 409 && noNote.body.error === "INCIDENT_SERIOUS_FOLLOW_UP_REQUIRED", noNote.raw);
    await call("POST", `${P}/incidents/${iHigh}/timeline`, sup.token, { entryText: "Visto." });
    const tinyNote = await call("POST", `${P}/incidents/${iHigh}/status`, admin.token, { status: "resolved", resolution: longRes });
    check("E19 Una nota de seguimiento trivial no basta", tinyNote.status === 409, tinyNote.raw);
    const realNote = await call("POST", `${P}/incidents/${iHigh}/timeline`, sup.token, { entryText: "Se evaluó al residente y se llamó a la familia a las 3:10 p. m." });
    const shortHigh = await call("POST", `${P}/incidents/${iHigh}/status`, admin.token, { status: "resolved", resolution: "Revisado con la familia." });
    check("E20 Con seguimiento, una resolución de menos de 30 caracteres no basta para un grave", realNote.status === 201 && shortHigh.status === 400 && shortHigh.body.error === "INCIDENT_RESOLUTION_TOO_SHORT", `${realNote.status} ${shortHigh.raw}`);
    const supStill = await call("POST", `${P}/incidents/${iHigh}/status`, sup.token, { status: "resolved", resolution: longRes });
    check("E21 Con seguimiento completo, la supervisora sin autorización sigue sin poder cerrarlo", supStill.status === 403, supStill.raw);

    // Authorization by the agency.
    const listSup = await call("GET", `${P}/incident-closers`, sup.token);
    const grantB = await call("POST", `${P}/incident-closers`, adminB.token, { membershipId: sup.membershipId });
    const grantCg = await call("POST", `${P}/incident-closers`, admin.token, { membershipId: cg2.membershipId });
    check("E22 Solo una administradora de la agencia autoriza (supervisora 403, otra agencia 403/404, una cuidadora no es autorizable 409)",
      listSup.status === 403 && denied(grantB) && grantCg.status === 409, `${listSup.status}/${grantB.status}/${grantCg.status}`);
    const grant = await call("POST", `${P}/incident-closers`, admin.token, { membershipId: sup.membershipId });
    const list = await call("GET", `${P}/incident-closers`, admin.token);
    check("E23 La administradora autoriza a la supervisora (auditado, visible en la lista)",
      grant.status === 201 && (list.body.supervisors ?? []).some((s: Json) => s.membershipId === sup.membershipId && s.authorized && s.grantedBy === admin.email)
        && (await audits("INCIDENT_CLOSER_GRANTED", sup.membershipId)) === 1, `${grant.status} ${list.raw}`);
    const rulesAuth = await call("GET", `${P}/incidents/${iHigh}/resolution-rules`, sup.token);
    const supOk = await call("POST", `${P}/incidents/${iHigh}/status`, sup.token, { status: "resolved", resolution: longRes });
    const highRow = await one(`SELECT status, resolved_by_user_id FROM incidents WHERE id=$1`, [iHigh]);
    check("E24 Supervisora autorizada cierra el grave con seguimiento y resolución sustantiva",
      rulesAuth.body.rules?.canCloseSerious === true && rulesAuth.body.rules?.hasDocumentedFollowUp === true && supOk.status === 200 && highRow.status === "resolved" && highRow.resolved_by_user_id === sup.userId, supOk.raw);
    const revoke = await call("POST", `${P}/incident-closers/${sup.membershipId}/revoke`, admin.token, {});
    const grantRow = await one(`SELECT revoked_at, revoked_by_user_id FROM incident_closure_authorizers WHERE organization_membership_id=$1`, [sup.membershipId]);
    check("E25 Revocar conserva la autorización con quién y cuándo (auditado)", revoke.status === 200 && !!grantRow.revoked_at && grantRow.revoked_by_user_id === admin.userId && (await audits("INCIDENT_CLOSER_REVOKED", sup.membershipId)) === 1, revoke.raw);
    const delGrant = await superSql(`DELETE FROM incident_closure_authorizers WHERE organization_membership_id='${sup.membershipId}'`);
    check("E26 Las autorizaciones no se borran (propietario incluido)", /INCIDENT_CLOSER_NOT_DELETABLE/.test(delGrant), delGrant);
    await call("POST", `${P}/incidents/${iHigh2}/status`, admin.token, { status: "in_progress" });
    await call("POST", `${P}/incidents/${iHigh2}/timeline`, admin.token, { entryText: "Evaluación completa realizada; familia informada." });
    const revoked = await call("POST", `${P}/incidents/${iHigh2}/status`, sup.token, { status: "resolved", resolution: longRes });
    const adminOk = await call("POST", `${P}/incidents/${iHigh2}/status`, admin.token, { status: "resolved", resolution: longRes });
    check("E27 Revocada, la supervisora ya no cierra graves; la administradora sí", revoked.status === 403 && adminOk.status === 200, `${revoked.status}/${adminOk.status}`);

    const history = await call("GET", `${P}/incidents?status=resolved`, admin.token);
    const hIds = (history.body.incidents ?? []).filter((i: Json) => [iMed, iHigh, iHigh2].includes(i.id));
    check("E28 Historial: los resueltos se consultan con responsable y fecha", history.status === 200 && hIds.length === 3 && hIds.every((i: Json) => i.resolved_by_user_id && i.resolved_at), `${history.status} ${hIds.length}`);
    const famList = await q(`SELECT 1`); void famList;
    c3 = await center();
    check("E29 Centro: sin los incidentes resueltos; contador coherente", ![iMed, iHigh, iHigh2].some((id) => inc(id)) && c3.summary.total === c3.alerts.length);
    const cgCenter = await center(carlos);
    check("E30 Centro operacional: la cuidadora sigue sin acceso (403)", cgCenter.status === 403, `${cgCenter.status}`);
  } finally {
    if (activationBefore) {
      await db.query(`ALTER TABLE operational_pending_activation DISABLE TRIGGER operational_pending_activation_guard`).catch(() => undefined);
      await db.query(`UPDATE operational_pending_activation SET activated_at = $1`, [activationBefore]).catch(() => undefined);
      await db.query(`ALTER TABLE operational_pending_activation ENABLE TRIGGER operational_pending_activation_guard`).catch(() => undefined);
    }
    await db.end();
    server.close();
  }

  console.log(`\nResolución de pendientes 154 (${runtimeMode ? "app_runtime, RLS" : "superusuario"})\n`);
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 200)} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
