/**
 * Mensajería directa agencia ↔ cuidadora (migración 136).
 *
 * Levanta la app real contra una base desechable (bootstrap:staging + seedDemo) y comprueba por
 * HTTP, con usuarios creados aquí (nombres únicos, se puede ejecutar varias veces):
 *   - solo ORGANIZATION_ADMIN abre la conversación; repetir o abrir en paralelo no duplica;
 *   - la cuidadora lee y responde sin turnos ni asignaciones;
 *   - nadie más la ve: otra cuidadora, familia, supervisora, otra agencia;
 *   - avisos (NEW_MESSAGE) solo a quien puede leerla;
 *   - cuidadora desactivada o administradora degradada pierden el acceso (y los avisos);
 *   - ninguna respuesta incluye datos de residentes; queda auditoría de la apertura.
 * Con DATABASE_URL de app_runtime añade ataques directos contra RLS.
 */
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { hashPassword } from "../src/security/password.js";

for (const name of ["DATABASE_URL", "MIGRATIONS_DATABASE_URL", "DEMO_PASSWORD"] as const) {
  if (!process.env[name]) throw new Error(`${name} is required.`);
}
if (process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires ETNARA_DISPOSABLE_DB=true");

type Json = Record<string, any>;
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });
const RESIDENT_KEYS = /care_?recipient(?!_id":null|_name":null)|first_?name|last_?name|preferred_?name|address|latitude|longitude|care_?plan|instruction|diagnos|medication|date_?of_?birth/i;

async function main() {
  const runtimeMode = new URL(process.env.DATABASE_URL!).username === "app_runtime";
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const db = new Client({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  await db.connect();
  const password = process.env.DEMO_PASSWORD!;
  const passwordHash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);

  async function call(method: string, path: string, token: string | null, body?: Json) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json, raw: text };
  }
  async function login(email: string) {
    const r = await call("POST", "/auth/login", null, { email, password });
    if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status}`);
    return r.body.token as string;
  }
  async function user(label: string, org: string, role: string | null, opts: { worker?: string } = {}) {
    const email = `dm-${label}-${tag}@verify.etnara.test`;
    const u = (await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1,$2,'active') RETURNING id`, [email, passwordHash])).rows[0].id as string;
    const om = (await db.query(`INSERT INTO organization_memberships (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`, [u, org])).rows[0].id as string;
    if (role) await db.query(`INSERT INTO user_roles (organization_membership_id, organization_id, role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [om, org, role]);
    let owm: string | null = null;
    if (opts.worker) {
      const w = (await db.query(`INSERT INTO workers (user_id, display_name) VALUES ($1,$2) RETURNING id`, [u, opts.worker])).rows[0].id;
      owm = (await db.query(`INSERT INTO organization_worker_memberships (worker_id, organization_id, status, internal_role) VALUES ($1,$2,'active','HHA') RETURNING id`, [w, org])).rows[0].id;
    }
    const token = await login(email);
    await call("POST", "/me/active-organization", token, { organizationId: org });
    return { id: u, om, owm, token };
  }
  const notifCount = async (userId: string, thread: string) =>
    Number((await db.query(`SELECT count(*) FROM notifications WHERE user_id=$1 AND related_entity_id=$2 AND notification_type='NEW_MESSAGE'`, [userId, thread])).rows[0].count);

  try {
    const orgA = (await db.query(`SELECT o.id FROM organizations o JOIN organization_memberships om ON om.organization_id=o.id JOIN users u ON u.id=om.user_id WHERE u.email='admin@demo.etnara.care' LIMIT 1`)).rows[0].id as string;
    const orgB = (await db.query(`INSERT INTO organizations (name, organization_type, status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`Verificación DM ${tag}`])).rows[0].id as string;

    const admin = await user("admin", orgA, "ORGANIZATION_ADMIN");
    const admin2 = await user("admin2", orgA, "ORGANIZATION_ADMIN");
    const supervisor = await user("sup", orgA, "SUPERVISOR");
    const family = await user("fam", orgA, "FAMILY");
    const cg = await user("cg", orgA, "WORKER", { worker: "Cuidadora Verificación" });
    const cg2 = await user("cg2", orgA, "WORKER", { worker: "Otra Cuidadora" });
    const cg3 = await user("cg3", orgA, "WORKER", { worker: "Cuidadora Paralelo" });
    const otherAdmin = await user("otheradmin", orgB, "ORGANIZATION_ADMIN");
    const otherCg = await user("othercg", orgB, "WORKER", { worker: "Cuidadora Otra Agencia" });
    const adminWorker = await user("adminworker", orgA, "ORGANIZATION_ADMIN", { worker: "Admin que también cuida" });
    // Perfil sin cuenta y perfil inactivo.
    const noAccountW = (await db.query(`INSERT INTO workers (display_name) VALUES ('Sin cuenta') RETURNING id`)).rows[0].id;
    const noAccount = (await db.query(`INSERT INTO organization_worker_memberships (worker_id, organization_id, status, internal_role) VALUES ($1,$2,'active','HHA') RETURNING id`, [noAccountW, orgA])).rows[0].id;
    const inactiveCg = await user("inactive", orgA, "WORKER", { worker: "Inactiva" });
    await db.query(`UPDATE organization_worker_memberships SET status='inactive' WHERE id=$1`, [inactiveCg.owm]);

    // Sin asignaciones para la cuidadora principal.
    const assignments = Number((await db.query(`SELECT count(*) FROM assignments WHERE organization_worker_membership_id=$1`, [cg.owm])).rows[0].count);
    check("La cuidadora no tiene turnos ni asignaciones", assignments === 0, `asignaciones=${assignments}`);

    // Apertura.
    const open = (t: string, org: string, owm: string) => call("POST", `/organizations/${org}/workers/${owm}/conversation`, t);
    const o1 = await open(admin.token, orgA, cg.owm!);
    const thread = o1.body?.conversationId as string;
    check("La administradora abre la conversación desde el perfil (201, nueva)", o1.status === 201 && o1.body.created === true && !!thread, `${o1.status} ${o1.raw}`);
    check("La respuesta de apertura no incluye datos de residentes", Object.keys(o1.body).sort().join() === "conversationId,created", o1.raw);
    const o2 = await open(admin.token, orgA, cg.owm!);
    check("Abrir de nuevo devuelve la misma conversación (200, sin duplicar)", o2.status === 200 && o2.body.conversationId === thread && o2.body.created === false, o2.raw);
    const o3 = await open(admin2.token, orgA, cg.owm!);
    check("Otra administradora de la agencia obtiene la misma conversación", o3.status === 200 && o3.body.conversationId === thread, o3.raw);
    const threadsForCg = Number((await db.query(`SELECT count(*) FROM message_threads WHERE organization_worker_membership_id=$1`, [cg.owm])).rows[0].count);
    check("Existe una sola conversación para esa agencia y cuidadora", threadsForCg === 1, `${threadsForCg}`);
    const par = await Promise.all(Array.from({ length: 8 }, (_, i) => open(i % 2 ? admin.token : admin2.token, orgA, cg3.owm!)));
    const parIds = new Set(par.map((r) => r.body?.conversationId));
    const parCount = Number((await db.query(`SELECT count(*) FROM message_threads WHERE organization_worker_membership_id=$1`, [cg3.owm])).rows[0].count);
    check("8 aperturas simultáneas: una conversación, una sola marcada como nueva", parIds.size === 1 && parCount === 1 && par.filter((r) => r.body?.created).length === 1 && par.every((r) => r.status < 300), `ids=${parIds.size} filas=${parCount} estados=${par.map((r) => r.status).join(",")}`);
    const audit = (await db.query(`SELECT actor_user_id, organization_id, new_value FROM audit_log WHERE action='CAREGIVER_CONVERSATION_OPENED' AND entity_id=$1`, [thread])).rows;
    check("Auditoría: una fila CAREGIVER_CONVERSATION_OPENED con quién, agencia y cuidadora", audit.length === 1 && audit[0].actor_user_id === admin.id && audit[0].organization_id === orgA && audit[0].new_value?.organization_worker_membership_id === cg.owm, JSON.stringify(audit));
    const participants = (await db.query(`SELECT user_id FROM message_thread_participants WHERE message_thread_id=$1`, [thread])).rows.map((r) => r.user_id);
    check("Participantes: la cuidadora y administradoras, nunca supervisora ni familia ni otra cuidadora",
      participants.includes(cg.id) && participants.includes(admin.id) && participants.includes(admin2.id) && !participants.includes(supervisor.id) && !participants.includes(family.id) && !participants.includes(cg2.id), `${participants.length} participantes`);

    // Quién NO puede abrir.
    const deny = [
      ["supervisora", await open(supervisor.token, orgA, cg2.owm!), 403],
      ["otra cuidadora", await open(cg.token, orgA, cg2.owm!), 403],
      ["familia", await open(family.token, orgA, cg2.owm!), 403],
      ["otra agencia en la ruta de A", await open(otherAdmin.token, orgA, cg2.owm!), 403],
      ["otra agencia con la cuidadora de A en su ruta", await open(otherAdmin.token, orgB, cg2.owm!), 404],
      ["cuidadora de otra agencia desde A", await open(admin.token, orgA, otherCg.owm!), 404],
      ["perfil inactivo", await open(admin.token, orgA, inactiveCg.owm!), 404],
      ["perfil sin cuenta", await open(admin.token, orgA, noAccount), 409],
      ["consigo misma", await open(adminWorker.token, orgA, adminWorker.owm!), 409],
    ] as const;
    for (const [who, r, expected] of deny) check(`No abre: ${who} (${expected})`, r.status === expected, `${r.status} ${r.raw}`);
    const bad = await call("POST", `/organizations/${orgA}/workers/no-uuid/conversation`, admin.token);
    check("Identificador inválido → 400", bad.status === 400, `${bad.status}`);
    const fakeOrg = await call("POST", `/organizations/${randomUUID()}/workers/${cg2.owm}/conversation`, otherAdmin.token);
    const realOrg = deny[3][1];
    check("Otra agencia recibe lo mismo que con una agencia inexistente (sin revelar existencia)", fakeOrg.status === realOrg.status && fakeOrg.raw === realOrg.raw, `${fakeOrg.raw} vs ${realOrg.raw}`);
    const noDup = Number((await db.query(`SELECT count(*) FROM message_threads WHERE organization_worker_membership_id = ANY($1::uuid[])`, [[cg2.owm, otherCg.owm, inactiveCg.owm, noAccount, adminWorker.owm]])).rows[0].count);
    check("Los intentos rechazados no crean conversaciones", noDup === 0, `${noDup}`);

    // Mensajes y avisos.
    const msgPath = `/organizations/${orgA}/conversations/${thread}/messages`;
    const before = { cg: await notifCount(cg.id, thread), admin2: await notifCount(admin2.id, thread), sup: await notifCount(supervisor.id, thread) };
    const s1 = await call("POST", msgPath, admin.token, { body: "Hola, ¿puedes confirmar tu disponibilidad del viernes?" });
    check("La administradora escribe (201)", s1.status === 201, `${s1.status}`);
    check("Aviso NEW_MESSAGE a la cuidadora y a la otra administradora", (await notifCount(cg.id, thread)) === before.cg + 1 && (await notifCount(admin2.id, thread)) === before.admin2 + 1);
    check("La administradora que escribe no recibe su propio aviso", (await notifCount(admin.id, thread)) === 0);
    const cgList = await call("GET", `/organizations/${orgA}/caregiver-conversations`, cg.token);
    const cgItem = (cgList.body?.conversations ?? []).find((c: Json) => c.conversationId === thread);
    check("La cuidadora ve la conversación en su portal con el nombre de la agencia", cgList.status === 200 && !!cgItem && typeof cgItem.organizationName === "string", cgList.raw.slice(0, 200));
    check("Listado directo: solo id, membresía, nombre de la cuidadora y de la agencia", !!cgItem && Object.keys(cgItem).sort().join() === "caregiverName,conversationId,organizationName,organizationWorkerMembershipId" && cgItem.caregiverName === "Cuidadora Verificación", JSON.stringify(cgItem));
    const cgConvs = await call("GET", `/organizations/${orgA}/conversations`, cg.token);
    check("También aparece en la lista general de conversaciones (care_recipient_id nulo)", (cgConvs.body?.conversations ?? []).some((c: Json) => c.id === thread && c.care_recipient_id === null && c.thread_type === "caregiver_agency"));
    const cgRead = await call("GET", msgPath, cg.token);
    check("La cuidadora lee sin turnos aceptados", cgRead.status === 200 && JSON.stringify(cgRead.body).includes("disponibilidad del viernes"), `${cgRead.status}`);
    const r1 = await call("POST", msgPath, cg.token, { body: "Sí, confirmo." });
    check("La cuidadora responde (201)", r1.status === 201, `${r1.status}`);
    check("Aviso de la respuesta a ambas administradoras, no a la supervisora", (await notifCount(admin.id, thread)) === 1 && (await notifCount(admin2.id, thread)) === before.admin2 + 2 && (await notifCount(supervisor.id, thread)) === before.sup);
    for (const [label, r] of [["apertura", o1], ["listado directo", cgList], ["mensajes", cgRead], ["respuesta", r1], ["lista general", cgConvs]] as const) {
      const leak = r.raw.match(RESIDENT_KEYS);
      check(`Sin datos de residentes en la respuesta: ${label}`, !leak, leak?.[0] ?? "");
    }
    const adminList = await call("GET", `/organizations/${orgA}/caregiver-conversations`, admin.token);
    check("La administradora ve el nombre de la cuidadora en su listado", (adminList.body?.conversations ?? []).some((c: Json) => c.conversationId === thread && c.caregiverName === "Cuidadora Verificación"));

    // Quién NO lee ni escribe.
    for (const [who, t, expected] of [
      ["otra cuidadora", cg2.token, 404],
      ["familia", family.token, 404],
      ["supervisora", supervisor.token, 404],
      ["otra agencia", otherAdmin.token, 403],
      ["cuidadora de otra agencia", otherCg.token, 403],
    ] as const) {
      const g = await call("GET", msgPath, t);
      const p = await call("POST", msgPath, t, { body: "intrusión" });
      const l = await call("GET", `/organizations/${orgA}/caregiver-conversations`, t);
      const listed = (l.body?.conversations ?? []).some((c: Json) => c.conversationId === thread);
      check(`No lee ni escribe: ${who}`, g.status === expected && p.status === expected && !listed, `GET ${g.status} POST ${p.status} lista ${l.status}`);
    }
    const intrusions = Number((await db.query(`SELECT count(*) FROM messages WHERE message_thread_id=$1 AND body='intrusión'`, [thread])).rows[0].count);
    check("Ningún mensaje ajeno quedó guardado", intrusions === 0, `${intrusions}`);
    const otherAgencyView = await call("GET", `/organizations/${orgB}/caregiver-conversations`, otherAdmin.token);
    check("La otra agencia no ve conversaciones de A en su propio listado", otherAgencyView.status === 200 && (otherAgencyView.body.conversations ?? []).length === 0, otherAgencyView.raw);

    // Cuidadora desactivada.
    await db.query(`UPDATE organization_worker_memberships SET status='inactive' WHERE id=$1`, [cg.owm]);
    const offRead = await call("GET", msgPath, cg.token);
    const offList = await call("GET", `/organizations/${orgA}/caregiver-conversations`, cg.token);
    const offWrite = await call("POST", msgPath, cg.token, { body: "después de desactivar" });
    check("Cuidadora desactivada: no lee, no escribe, no la lista", offRead.status === 404 && offWrite.status === 404 && (offList.body?.conversations ?? []).length === 0, `${offRead.status}/${offWrite.status}`);
    const cgBefore = await notifCount(cg.id, thread);
    await call("POST", msgPath, admin.token, { body: "Mensaje con la cuidadora desactivada" });
    check("Cuidadora desactivada: no recibe avisos nuevos", (await notifCount(cg.id, thread)) === cgBefore);
    const reopenInactive = await open(admin.token, orgA, cg.owm!);
    check("No se reabre con la membresía inactiva (404)", reopenInactive.status === 404, `${reopenInactive.status}`);
    await db.query(`UPDATE organization_worker_memberships SET status='active' WHERE id=$1`, [cg.owm]);
    const backRead = await call("GET", msgPath, cg.token);
    check("Al reactivarla recupera el mismo historial (conservado)", backRead.status === 200 && (backRead.body.messages ?? []).length >= 3, `${backRead.status} ${(backRead.body.messages ?? []).length}`);

    // Administradora degradada a supervisora.
    await db.query(`UPDATE user_roles SET role_id=(SELECT id FROM roles WHERE code='SUPERVISOR') WHERE organization_membership_id=$1`, [admin2.om]);
    const demRead = await call("GET", msgPath, admin2.token);
    const a2Before = await notifCount(admin2.id, thread);
    await call("POST", msgPath, cg.token, { body: "Respuesta tras el cambio de rol" });
    check("Administradora degradada: pierde lectura y avisos", demRead.status === 404 && (await notifCount(admin2.id, thread)) === a2Before, `${demRead.status}`);
    await db.query(`UPDATE user_roles SET role_id=(SELECT id FROM roles WHERE code='ORGANIZATION_ADMIN') WHERE organization_membership_id=$1`, [admin2.om]);
    check("Al restaurar el rol recupera el acceso", (await call("GET", msgPath, admin2.token)).status === 200);

    // Nueva administradora: entra al abrir (no antes).
    const admin3 = await user("admin3", orgA, "ORGANIZATION_ADMIN");
    const pre = await call("GET", msgPath, admin3.token);
    const join = await open(admin3.token, orgA, cg.owm!);
    const post = await call("GET", msgPath, admin3.token);
    check("Administradora nueva: accede al abrir desde el perfil (misma conversación)", pre.status === 404 && join.body.conversationId === thread && post.status === 200, `${pre.status}/${join.status}/${post.status}`);

    // Historial: mensajes inmutables.
    const total = Number((await db.query(`SELECT count(*) FROM messages WHERE message_thread_id=$1`, [thread])).rows[0].count);
    check("Historial conservado en la conversación", total === 4, `${total} mensajes`);

    // Regresión: las conversaciones familiares siguen igual para la agencia.
    const famThreads = await call("GET", `/organizations/${orgA}/conversations`, await login("admin@demo.etnara.care"));
    check("Regresión: la administradora demo sigue viendo conversaciones familia-agencia", famThreads.status === 200 && (famThreads.body.conversations ?? []).some((c: Json) => c.thread_type === "family_agency"));

    if (runtimeMode) {
      const rt = async (userId: string, org: string, q: string, params: unknown[]) => {
        const c = new Client({ connectionString: process.env.DATABASE_URL });
        await c.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.current_user_id', $1, true), set_config('app.current_org_id', $2, true)", [userId, org]);
          const r = await c.query(q, params);
          return { rows: r.rows, error: null as string | null };
        } catch (e) {
          return { rows: [], error: String(e) };
        } finally {
          await c.query("ROLLBACK").catch(() => {});
          await c.end();
        }
      };
      const ins = await rt(admin.id, orgA, `INSERT INTO message_threads (organization_id, thread_type, organization_worker_membership_id) VALUES ($1,'caregiver_agency',$2)`, [orgA, cg2.owm]);
      check("RLS: ni una administradora crea conversaciones directas sin la función", /row-level security/i.test(ins.error ?? ""), ins.error ?? "insertó");
      const join2 = await rt(cg2.id, orgA, `INSERT INTO message_thread_participants (organization_id, message_thread_id, user_id, can_write) VALUES ($1,$2,$3,true)`, [orgA, thread, cg2.id]);
      check("RLS: otra cuidadora no se añade como participante", /row-level security/i.test(join2.error ?? ""), join2.error ?? "insertó");
      const joinAdmin = await rt(admin.id, orgA, `INSERT INTO message_thread_participants (organization_id, message_thread_id, user_id, can_write) VALUES ($1,$2,$3,true)`, [orgA, thread, supervisor.id]);
      check("RLS: una administradora no añade a terceros a mano", /row-level security/i.test(joinAdmin.error ?? ""), joinAdmin.error ?? "insertó");
      const readMsgs = await rt(cg2.id, orgA, `SELECT count(*)::int AS n FROM messages WHERE message_thread_id=$1`, [thread]);
      check("RLS: otra cuidadora lee 0 mensajes", readMsgs.rows[0]?.n === 0, JSON.stringify(readMsgs));
      const readSup = await rt(supervisor.id, orgA, `SELECT count(*)::int AS n FROM message_threads WHERE id=$1`, [thread]);
      check("RLS: la supervisora no ve la conversación", readSup.rows[0]?.n === 0, JSON.stringify(readSup));
      await db.query(`UPDATE organization_worker_memberships SET status='inactive' WHERE id=$1`, [cg.owm]);
      const inact = await rt(cg.id, orgA, `SELECT count(*)::int AS n FROM messages WHERE message_thread_id=$1`, [thread]);
      const inactW = await rt(cg.id, orgA, `INSERT INTO messages (organization_id, message_thread_id, sender_user_id, body) VALUES ($1,$2,$3,'x')`, [orgA, thread, cg.id]);
      await db.query(`UPDATE organization_worker_memberships SET status='active' WHERE id=$1`, [cg.owm]);
      check("RLS: cuidadora desactivada lee 0 y no escribe", inact.rows[0]?.n === 0 && /row-level security/i.test(inactW.error ?? ""), `${JSON.stringify(inact.rows)} ${inactW.error}`);
      const otherOrg = await rt(otherAdmin.id, orgB, `SELECT count(*)::int AS n FROM message_threads WHERE id=$1`, [thread]);
      check("RLS: la otra agencia no ve la conversación", otherOrg.rows[0]?.n === 0, JSON.stringify(otherOrg));
      const okRead = await rt(cg.id, orgA, `SELECT count(*)::int AS n FROM messages WHERE message_thread_id=$1`, [thread]);
      check("RLS: la cuidadora activa sí lee sus mensajes", (okRead.rows[0]?.n ?? 0) >= 4, JSON.stringify(okRead));
      const fnDirect = await rt(cg.id, orgA, `SELECT * FROM app_open_caregiver_thread($1)`, [cg2.owm]);
      check("Función de apertura llamada por una cuidadora: rechazada", /CAREGIVER_THREAD_FORBIDDEN/.test(fnDirect.error ?? ""), fnDirect.error ?? "");
    }
  } finally {
    await db.end();
    server.close();
  }

  console.log(`\nMensajería directa agencia ↔ cuidadora (${runtimeMode ? "app_runtime, RLS" : "superusuario"})\n`);
  console.log("| Comprobación | Resultado | Detalle |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail.replace(/\|/g, "/").slice(0, 160)} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
