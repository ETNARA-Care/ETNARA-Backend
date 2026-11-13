/**
 * 151 — «Escribir a mi agencia» y supervisoras autorizadas (D4, 5-nov-2026). Datos ficticios.
 * App real por HTTP como app_runtime (RLS), base desechable. Comprueba: la cuidadora abre su propia
 * conversación (una sola, también en paralelo y con la de la agencia), participantes (todas las
 * administradoras activas; supervisoras solo autorizadas), autorización/revocación auditadas, pérdida
 * inmediata de acceso (rol, membresía, autorización), sin restauración silenciosa, administradoras
 * nuevas, conversaciones con familias separadas, aislamiento entre agencias y ETNARA Central.
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
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });

async function main() {
  const db = new pg.Client({ connectionString: adminUrl }); await db.connect();
  const q = <T extends pg.QueryResultRow = Json>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const rt = randomBytes(24).toString("hex"); await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${rt}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = rt; process.env.DATABASE_URL = u.toString();
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const pw = randomBytes(12).toString("hex"), hash = await hashPassword(pw), tag = randomUUID().slice(0, 6);
  const call = async (m: string, p: string, t: string, b?: Json) => { const r = await fetch(base + p, { method: m, headers: { Authorization: `Bearer ${t}`, ...(b ? { "Content-Type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }); let j: Json = {}; try { j = await r.json(); } catch { /* */ } return { s: r.status, b: j }; };

  const org = async (n: string) => (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [n])).rows[0].id as string;
  const A = await org(`Agencia A ${tag}`), B = await org(`Agencia B ${tag}`), C = await org(`Agencia sin administración ${tag}`);
  type P = { key: string; email: string; id: string; t: string; m: string; owm?: string; o: string };
  async function person(key: string, o: string, roles: string[], worker = false): Promise<P> {
    const email = `cim-${key}-${tag}@example.invalid`;
    const id = (await q(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [id, o])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code=ANY($3)`, [m, o, roles]);
    let owm: string | undefined;
    if (worker) { const w = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [id, `Cuidadora ${key}`])).rows[0].id; owm = (await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','CNA') RETURNING id`, [w, o])).rows[0].id; }
    return { key, email, id, t: "", m, owm, o };
  }
  const P = {
    admin1: await person("admin1", A, ["ORGANIZATION_ADMIN"]), admin2: await person("admin2", A, ["ORGANIZATION_ADMIN"]),
    sup: await person("sup", A, ["SUPERVISOR"]), sup2: await person("sup2", A, ["SUPERVISOR"]),
    cg: await person("cg", A, ["WORKER"], true), cg2: await person("cg2", A, ["WORKER"], true), cg3: await person("cg3", A, ["WORKER"], true),
    fam: await person("fam", A, ["FAMILY"]), worker: await person("worker", A, ["WORKER"]),
    adminB: await person("adminb", B, ["ORGANIZATION_ADMIN"]), supB: await person("supb", B, ["SUPERVISOR"]), cgB: await person("cgb", B, ["WORKER"], true),
    cgC: await person("cgc", C, ["WORKER"], true), newAdmin: await person("newadmin", A, ["WORKER"]),
  };
  const central = await person("central", B, []);
  await q(`DELETE FROM organization_memberships WHERE id=$1`, [central.m]); await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.id]);
  const res = (await q(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Juliana','Ficticia','active') RETURNING id`, [A])).rows[0].id;
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [P.fam.id, A, res]);
  const sh = (await q(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '1 hour',now()+interval '3 hours','in_progress') RETURNING id`, [A, res])).rows[0].id;
  await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,response_status,responded_at) VALUES ($1,$2,$3,'accepted',now())`, [A, sh, P.cg.owm]);
  for (const p of [...Object.values(P), central]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password: pw }); if (!r.b.token) throw new Error(`login ${p.key}`);
    p.t = r.b.token; if (p !== central) await call("POST", "/me/active-organization", p.t, { organizationId: p.o });
  }
  const OA = `/organizations/${A}`;
  const msgs = (p: P, th: string) => call("GET", `${OA}/conversations/${th}/messages`, p.t);
  const send = (p: P, th: string, body: string) => call("POST", `${OA}/conversations/${th}/messages`, p.t, { body });
  const participants = async (th: string) => (await q(`SELECT u.email FROM message_thread_participants p JOIN users u ON u.id=p.user_id WHERE p.message_thread_id=$1`, [th])).rows.map((r) => String(r.email).split("-")[1]).sort();
  const audit = async (action: string, entity: string) => (await q(`SELECT actor_user_id,new_value,previous_value FROM audit_log WHERE action=$1 AND entity_id=$2 ORDER BY occurred_at`, [action, entity])).rows;

  // ---------------------------------------------------------------- 1. la cuidadora inicia
  const open1 = await call("POST", `${OA}/my-agency-conversation`, P.cg.t);
  const th = open1.b.conversationId as string;
  check("1. La cuidadora abre «Escribir a mi agencia»: 201 y una conversación directa", open1.s === 201 && open1.b.created === true && !!th, open1.s);
  const again = await call("POST", `${OA}/my-agency-conversation`, P.cg.t);
  const fromProfile = await call("POST", `${OA}/workers/${P.cg.owm}/conversation`, P.admin1.t);
  check("2. Una sola conversación: repetir (200) y abrir desde el perfil devuelven la misma", again.s === 200 && again.b.conversationId === th && fromProfile.s === 200 && fromProfile.b.conversationId === th, [again.s, fromProfile.s]);
  const par = await Promise.all([1, 2, 3].map(() => call("POST", `${OA}/my-agency-conversation`, P.cg2.t)).concat([call("POST", `${OA}/workers/${P.cg2.owm}/conversation`, P.admin2.t)]));
  const cg2Threads = Number((await q(`SELECT count(*) FROM message_threads WHERE organization_worker_membership_id=$1`, [P.cg2.owm])).rows[0].count);
  check("2b. En paralelo (cuidadora ×3 + administradora): una sola conversación", cg2Threads === 1 && new Set(par.map((r) => r.b.conversationId)).size === 1, cg2Threads);
  const op = await audit("CAREGIVER_CONVERSATION_OPENED", th);
  check("3. Auditoría: apertura registrada una vez, iniciada por la cuidadora", op.length === 1 && op[0].actor_user_id === P.cg.id && op[0].new_value.initiated_by === "caregiver", op.map((a) => a.new_value.initiated_by));
  check("4. Participantes: la cuidadora y TODAS las administradoras activas; ni supervisoras sin autorizar ni familia", JSON.stringify(await participants(th)) === JSON.stringify(["admin1", "admin2", "cg"]), await participants(th));
  const s1 = await send(P.cg, th, "Hola agencia (ficticio)");
  const a1 = await msgs(P.admin1, th), a2 = await msgs(P.admin2, th);
  check("5. Ambas administradoras leen el mensaje de la cuidadora", s1.s === 201 && a1.s === 200 && a2.s === 200 && a1.b.messages.length === 1, [s1.s, a1.s, a2.s]);
  const r1 = await send(P.admin2, th, "Recibido (ficticio)");
  check("5b. La administradora responde y la cuidadora lo lee", r1.s === 201 && (await msgs(P.cg, th)).b.messages.length === 2);

  // ---------------------------------------------------------------- 2. supervisoras
  const supBefore = await msgs(P.sup, th);
  check("6. Supervisora sin autorización: no lee (404) ni abre desde el perfil (403)", supBefore.s === 404 && (await call("POST", `${OA}/workers/${P.cg.owm}/conversation`, P.sup.t)).s === 403, supBefore.s);
  const bySup = await call("POST", `${OA}/team/message-handlers`, P.sup.t, { membershipId: P.sup2.m, authorized: true });
  const byWorker = await call("POST", `${OA}/team/message-handlers`, P.cg.t, { membershipId: P.sup.m, authorized: true });
  check("7. Solo administradoras autorizan: supervisora y cuidadora → 403", bySup.s === 403 && byWorker.s === 403, [bySup.s, byWorker.s]);
  const notSup = await call("POST", `${OA}/team/message-handlers`, P.admin1.t, { membershipId: P.worker.m, authorized: true });
  const otherOrg = await call("POST", `${OA}/team/message-handlers`, P.admin1.t, { membershipId: P.supB.m, authorized: true });
  check("8. Solo supervisoras de la MISMA agencia: cuidadora → 409, supervisora de otra agencia → 409", notSup.s === 409 && notSup.b.error === "NOT_A_SUPERVISOR" && otherOrg.s === 409, [notSup.s, otherOrg.s]);
  const grant = await call("POST", `${OA}/team/message-handlers`, P.admin1.t, { membershipId: P.sup.m, authorized: true });
  const supAfter = await msgs(P.sup, th);
  check("9. Autorizada: la supervisora lee el historial de inmediato (incluidas conversaciones previas)", grant.s === 200 && grant.b.changed === true && supAfter.s === 200 && supAfter.b.messages.length === 2, [grant.s, supAfter.s]);
  const ga = await audit("CAREGIVER_MESSAGE_HANDLER_GRANTED", P.sup.m);
  check("10. Auditoría de la autorización (quién)", ga.length === 1 && ga[0].actor_user_id === P.admin1.id);
  const regrant = await call("POST", `${OA}/team/message-handlers`, P.admin2.t, { membershipId: P.sup.m, authorized: true });
  check("10b. Autorizar dos veces no duplica (changed=false, sin auditoría extra)", regrant.s === 200 && regrant.b.changed === false && (await audit("CAREGIVER_MESSAGE_HANDLER_GRANTED", P.sup.m)).length === 1);
  const team = (await call("GET", `${OA}/team`, P.admin1.t)).b.members as Json[];
  const flag = (m: string) => team.find((x) => x.membershipId === m)?.caregiverMessages;
  check("11. Equipo muestra quién atiende: administradoras sí, supervisora autorizada sí, la otra no", flag(P.admin1.m) === true && flag(P.sup.m) === true && flag(P.sup2.m) === false);
  await send(P.cg, th, "Segundo mensaje (ficticio)");
  const notified = (await q(`SELECT u.email FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.related_entity_id=$1 AND n.notification_type='NEW_MESSAGE' ORDER BY n.created_at DESC LIMIT 3`, [th])).rows.map((r) => String(r.email).split("-")[1]).sort();
  check("12. Avisos del mensaje nuevo: administradoras y supervisora autorizada; nadie más", JSON.stringify(notified) === JSON.stringify(["admin1", "admin2", "sup"]), notified);
  const revoke = await call("POST", `${OA}/team/message-handlers`, P.admin2.t, { membershipId: P.sup.m, authorized: false });
  check("13. Revocada: pierde la lectura al instante (404) y queda auditada", revoke.s === 200 && revoke.b.changed === true && (await msgs(P.sup, th)).s === 404 && (await audit("CAREGIVER_MESSAGE_HANDLER_REVOKED", P.sup.m)).at(-1)?.actor_user_id === P.admin2.id);
  check("13b. Historial conservado tras revocar (mensajes intactos)", (await msgs(P.admin1, th)).b.messages.length === 3);

  // pérdida de rol / membresía
  await call("POST", `${OA}/team/message-handlers`, P.admin1.t, { membershipId: P.sup2.m, authorized: true });
  check("14a. Supervisora 2 autorizada lee", (await msgs(P.sup2, th)).s === 200);
  const roleOff = await call("POST", `${OA}/team/roles`, P.admin1.t, { membershipId: P.sup2.m, role: "SUPERVISOR", enabled: false });
  const lostRole = await msgs(P.sup2, th);
  const autoRev = await audit("CAREGIVER_MESSAGE_HANDLER_REVOKED", P.sup2.m);
  check("14b. Pierde el rol de supervisora: sin acceso al instante y autorización revocada automáticamente (auditada)", roleOff.s === 200 && lostRole.s === 404 && autoRev.at(-1)?.new_value?.reason === "role_removed", [roleOff.s, lostRole.s]);
  await call("POST", `${OA}/team/roles`, P.admin1.t, { membershipId: P.sup2.m, role: "SUPERVISOR", enabled: true });
  check("14c. Recupera el rol: NO recupera el acceso sin nueva autorización", (await msgs(P.sup2, th)).s === 404);
  await call("POST", `${OA}/team/message-handlers`, P.admin1.t, { membershipId: P.sup2.m, authorized: true });
  await q(`UPDATE organization_memberships SET status='revoked' WHERE id=$1`, [P.sup2.m]);
  const lostMem = await msgs(P.sup2, th);
  check("15. Membresía inactiva: sin acceso al instante y autorización revocada (auditada)", [403, 404].includes(lostMem.s) && (await audit("CAREGIVER_MESSAGE_HANDLER_REVOKED", P.sup2.m)).at(-1)?.new_value?.reason === "membership_inactive", lostMem.s);
  await call("POST", `${OA}/team/roles`, P.admin1.t, { membershipId: P.admin2.m, role: "ORGANIZATION_ADMIN", enabled: false });
  check("16. Administradora que pierde el rol: sin acceso al instante", (await msgs(P.admin2, th)).s === 404);
  await call("POST", `${OA}/team/roles`, P.admin1.t, { membershipId: P.newAdmin.m, role: "ORGANIZATION_ADMIN", enabled: true });
  check("17. Administradora nueva: participa de inmediato sin pasos adicionales", (await msgs(P.newAdmin, th)).s === 200 && (await participants(th)).includes("newadmin"));
  await q(`UPDATE users SET status='disabled' WHERE id=$1`, [P.newAdmin.id]);
  const suspended = await msgs(P.newAdmin, th);
  check("17b. Cuenta no activa: sin acceso", suspended.s !== 200, suspended.s);

  // ---------------------------------------------------------------- 3. cuidadoras y familias
  const other = await msgs(P.cg3, th);
  check("18. Otra cuidadora de la agencia no lee la conversación ajena", other.s === 404);
  const famRead = await msgs(P.fam, th), famList = (await call("GET", `${OA}/conversations`, P.fam.t)).b.conversations as Json[];
  check("19. La familia no ve la conversación interna (404, no listada)", famRead.s === 404 && !famList.some((c) => c.id === th));
  const famConv = (await call("POST", `${OA}/care-recipients/${res}/conversation`, P.fam.t)).b.conversation;
  await send(P.cg, famConv.id, "Para la familia (ficticio)");
  const famMsgs = (await msgs(P.fam, famConv.id)).b.messages as Json[];
  check("20. Conversación con la familia separada: el mensaje familiar no aparece en la interna y viceversa", famMsgs.length === 1 && !(await msgs(P.admin1, th)).b.messages.some((m: Json) => m.body.includes("familia")) && !famMsgs.some((m) => m.body.includes("agencia")));
  check("20b. 151 no añade participantes a conversaciones familiares", !(await participants(famConv.id)).includes("sup2") && famConv.thread_type === "family_agency");
  await q(`UPDATE organization_worker_memberships SET status='inactive' WHERE id=$1`, [P.cg3.owm]);
  const inactiveOpen = await call("POST", `${OA}/my-agency-conversation`, P.cg3.t);
  check("21. Cuidadora con membresía de cuidadora inactiva no abre (403)", inactiveOpen.s === 403, inactiveOpen.s);
  const notCg = await call("POST", `${OA}/my-agency-conversation`, P.fam.t);
  check("22. Una familiar no puede usar «Escribir a mi agencia» (403)", notCg.s === 403, notCg.s);

  // ---------------------------------------------------------------- 4. aislamiento
  const bInA = await call("POST", `${OA}/my-agency-conversation`, P.cgB.t);
  const bRead = await call("GET", `${OA}/conversations/${th}/messages`, P.adminB.t);
  const bOwn = await call("GET", `/organizations/${B}/conversations/${th}/messages`, P.adminB.t);
  const bGrant = await call("POST", `/organizations/${B}/team/message-handlers`, P.adminB.t, { membershipId: P.sup.m, authorized: true });
  check("23. Otra agencia: su cuidadora no abre en A (403), su administradora no lee (403/404) ni autoriza personal de A (409)", bInA.s === 403 && bRead.s === 403 && bOwn.s === 404 && bGrant.s === 409, [bInA.s, bRead.s, bOwn.s, bGrant.s]);
  const bTh = (await call("POST", `/organizations/${B}/my-agency-conversation`, P.cgB.t)).b.conversationId;
  check("23b. La cuidadora de B abre la suya en B; nadie de A la ve", !!bTh && (await call("GET", `/organizations/${A}/conversations/${bTh}/messages`, P.admin1.t)).s === 404);
  const noHandler = await call("POST", `/organizations/${C}/my-agency-conversation`, P.cgC.t);
  check("24. Agencia sin nadie que atienda: 409 AGENCY_HAS_NO_MESSAGE_HANDLER (no se crea conversación vacía)", noHandler.s === 409 && noHandler.b.error === "AGENCY_HAS_NO_MESSAGE_HANDLER" && Number((await q(`SELECT count(*) FROM message_threads WHERE organization_id=$1`, [C])).rows[0].count) === 0, noHandler.s);
  const cRead = await call("GET", `${OA}/conversations/${th}/messages`, central.t);
  const cTeam = await call("POST", `${OA}/team/message-handlers`, central.t, { membershipId: P.sup.m, authorized: true });
  check("25. ETNARA Central no lee ni autoriza", cRead.s === 403 && cTeam.s === 403, [cRead.s, cTeam.s]);

  // RLS directa como app_runtime
  const rls = new pg.Client({ connectionString: process.env.DATABASE_URL }); await rls.connect();
  const attempt = async (sqlText: string, p: unknown[] = []) => { await rls.query("BEGIN"); await rls.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.current_organization_id',$2,true)`, [P.admin1.id, A]); try { const r = await rls.query(sqlText, p); return `ok:${r.rowCount}`; } catch (e) { return (e as { code?: string }).code ?? "error"; } finally { await rls.query("ROLLBACK"); } };
  const ins = await attempt(`INSERT INTO caregiver_message_handlers (organization_id,organization_membership_id,granted_by_user_id) VALUES ($1,$2,$3)`, [A, P.sup.m, P.admin1.id]);
  const upd = await attempt(`UPDATE caregiver_message_handlers SET revoked_at=NULL, revoked_by_user_id=NULL WHERE organization_membership_id=$1`, [P.sup.m]);
  const addPart = await attempt(`INSERT INTO message_thread_participants (organization_id,message_thread_id,user_id,can_write) VALUES ($1,$2,$3,true)`, [A, th, P.sup.id]);
  check("26. RLS/permisos: la aplicación no escribe autorizaciones ni añade participantes por su cuenta (42501)", ins === "42501" && upd === "42501" && addPart === "42501", [ins, upd, addPart]);
  await rls.end();

  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail.slice(0, 110)} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nCAREGIVER_INITIATED_MESSAGES ${results.length - failed}/${results.length}`);
  server.close(); await pool.end(); await db.end();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
