/**
 * Conversation titles for caregivers inside the 24 h window (follow-up to #234).
 *
 * GET /conversations now returns care_recipient_name (short name) for the residents the
 * caller may message (app_my_message_recipients, 132), so a caregiver who just ended her
 * visit sees «Doña Prueba» instead of the generic «Equipo de cuidado». The 24 h rule and
 * the message history are unchanged; this script proves the name follows exactly the same
 * access rule:
 *   - inside the window: conversation listed with the short name, read and reply allowed;
 *   - 24 h after her check-out: conversation, name, messages, reply and «startable» all gone;
 *   - other residents, other caregivers, family of another resident, another agency: nothing;
 *   - direct agency/caregiver conversations: no resident name.
 * Runs the real app against a disposable database (bootstrap:staging + seedDemo), with
 * users created here (unique names, can run repeatedly). Both connection modes.
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
  async function user(label: string, org: string, role: string | null, opts: { worker?: string } = {}) {
    const email = `cn-${label}-${tag}@verify.etnara.test`;
    const u = (await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1,$2,'active') RETURNING id`, [email, passwordHash])).rows[0].id as string;
    const om = (await db.query(`INSERT INTO organization_memberships (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`, [u, org])).rows[0].id as string;
    if (role) await db.query(`INSERT INTO user_roles (organization_membership_id, organization_id, role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [om, org, role]);
    let owm: string | null = null;
    if (opts.worker) {
      const w = (await db.query(`INSERT INTO workers (user_id, display_name) VALUES ($1,$2) RETURNING id`, [u, opts.worker])).rows[0].id;
      owm = (await db.query(`INSERT INTO organization_worker_memberships (worker_id, organization_id, status, internal_role) VALUES ($1,$2,'active','HHA') RETURNING id`, [w, org])).rows[0].id;
    }
    const login = await call("POST", "/auth/login", null, { email, password });
    if (login.status !== 200) throw new Error(`login ${label} failed: ${login.status}`);
    const token = login.body.token as string;
    await call("POST", "/me/active-organization", token, { organizationId: org });
    return { id: u, om, owm, token };
  }

  try {
    const orgA = (await db.query(`SELECT o.id FROM organizations o JOIN organization_memberships om ON om.organization_id=o.id JOIN users u ON u.id=om.user_id WHERE u.email='admin@demo.etnara.care' LIMIT 1`)).rows[0].id as string;
    const orgB = (await db.query(`INSERT INTO organizations (name, organization_type, status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`Verificación nombres ${tag}`])).rows[0].id as string;
    const method = (await db.query(`SELECT id FROM verification_methods WHERE code='CAREGIVER_SESSION'`)).rows[0].id as string;

    const admin = await user("admin", orgA, "ORGANIZATION_ADMIN");
    const cg = await user("cg", orgA, "WORKER", { worker: "Cuidadora Ventana" });
    const cg2 = await user("cg2", orgA, "WORKER", { worker: "Cuidadora Sin Turno" });
    const familyA = await user("famA", orgA, "FAMILY");
    const familyB = await user("famB", orgA, "FAMILY");
    const otherAdmin = await user("otheradmin", orgB, "ORGANIZATION_ADMIN");

    const r1 = (await db.query(`INSERT INTO care_recipients (organization_id, first_name, last_name, preferred_name, status) VALUES ($1,'Carmela','Apellidoprivado','Doña Prueba ${tag}','active') RETURNING id`, [orgA])).rows[0].id as string;
    const r2 = (await db.query(`INSERT INTO care_recipients (organization_id, first_name, last_name, status) VALUES ($1,'Josefo','Otroapellido','active') RETURNING id`, [orgA])).rows[0].id as string;
    const r1Name = `Doña Prueba ${tag}`;
    for (const [fam, rec] of [[familyA, r1], [familyB, r2]] as const) {
      await db.query(`INSERT INTO family_relationships (organization_id, user_id, care_recipient_id, relationship_type, status) VALUES ($1,$2,$3,'daughter','active')`, [orgA, fam.id, rec]);
    }

    // Visits: R1 ended 2 h ago (check-out 1 h ago) → inside the window; R2 ended 30 days ago → outside.
    async function visit(rec: string, endedHoursAgo: number, checkoutHoursAgo: number) {
      const s = (await db.query(`INSERT INTO shifts (organization_id, care_recipient_id, scheduled_start, scheduled_end, status) VALUES ($1,$2, now() - make_interval(hours => $3 + 3), now() - make_interval(hours => $3), 'completed') RETURNING id`, [orgA, rec, endedHoursAgo])).rows[0].id as string;
      await db.query(`INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, response_status) VALUES ($1,$2,$3,'accepted')`, [orgA, s, cg.owm]);
      await db.query(`INSERT INTO verification_events (organization_id, shift_id, organization_worker_membership_id, verification_method_id, event_type, occurred_at, created_at) VALUES ($1,$2,$3,$4,'check_in', now() - make_interval(hours => $5 + 2), now() - make_interval(hours => $5 + 2))`, [orgA, s, cg.owm, method, checkoutHoursAgo]);
      const co = (await db.query(`INSERT INTO verification_events (organization_id, shift_id, organization_worker_membership_id, verification_method_id, event_type, occurred_at, created_at) VALUES ($1,$2,$3,$4,'check_out', now() - make_interval(hours => $5), now() - make_interval(hours => $5)) RETURNING id`, [orgA, s, cg.owm, method, checkoutHoursAgo])).rows[0].id as string;
      return { shift: s, checkout: co };
    }
    const v1 = await visit(r1, 2, 1);
    await visit(r2, 24 * 30, 24 * 30);

    // The agency opens both resident conversations and writes; family of each joins its own.
    const open = async (t: string, rec: string) => call("POST", `/organizations/${orgA}/care-recipients/${rec}/conversation`, t);
    const t1 = (await open(admin.token, r1)).body.conversation?.id as string;
    const t2 = (await open(admin.token, r2)).body.conversation?.id as string;
    await open(familyA.token, r1);
    await open(familyB.token, r2);
    for (const t of [t1, t2]) await call("POST", `/organizations/${orgA}/conversations/${t}/messages`, admin.token, { body: "Mensaje de la agencia" });
    const direct = (await call("POST", `/organizations/${orgA}/workers/${cg.owm}/conversation`, admin.token)).body.conversationId as string;
    check("Preparación: conversaciones de dos residentes y una directa", !!t1 && !!t2 && !!direct && t1 !== t2);

    const list = async (t: string, org = orgA) => call("GET", `/organizations/${org}/conversations`, t);
    const find = (r: { body: Json }, id: string) => ((r.body?.conversations ?? []) as Json[]).find((c) => c.id === id);
    const msgs = (t: string, id: string) => call("GET", `/organizations/${orgA}/conversations/${id}/messages`, t);
    const reply = (t: string, id: string) => call("POST", `/organizations/${orgA}/conversations/${id}/messages`, t, { body: "respuesta" });
    const startable = async (t: string) => ((await call("GET", `/organizations/${orgA}/conversations/startable-recipients`, t)).body?.recipients ?? []).map((r: Json) => r.id);

    // 1. Caregiver inside the 24 h window.
    let l = await list(cg.token);
    check("Ventana abierta: la conversación de la residente aparece con su nombre corto", find(l, t1)?.care_recipient_name === r1Name, JSON.stringify(find(l, t1)));
    check("Ventana abierta: el nombre no incluye el apellido", !l.raw.includes("Apellidoprivado"));
    check("Otra residente (visita de hace 30 días): ni conversación ni nombre", !find(l, t2) && !l.raw.includes("Josefo") && !l.raw.includes("Otroapellido"));
    check("Conversación directa: sin nombre de residente", find(l, direct) !== undefined && find(l, direct)?.care_recipient_name == null, JSON.stringify(find(l, direct)));
    check("Ventana abierta: lee (200) y responde (201)", (await msgs(cg.token, t1)).status === 200 && (await reply(cg.token, t1)).status === 201);
    check("Otra residente: no lee ni responde (404)", (await msgs(cg.token, t2)).status === 404 && (await reply(cg.token, t2)).status === 404);
    let st = await startable(cg.token);
    check("«Puede iniciar» coincide: solo la residente de la ventana", st.includes(r1) && !st.includes(r2), JSON.stringify(st));

    // 2. Boundary: check-out 23 h 59 min ago → still inside; 24 h 01 min ago → gone.
    await db.query(`UPDATE verification_events SET created_at = now() - interval '23 hours 59 minutes', occurred_at = now() - interval '23 hours 59 minutes' WHERE id = $1`, [v1.checkout]);
    await db.query(`UPDATE shifts SET scheduled_end = now() - interval '25 hours', scheduled_start = now() - interval '28 hours' WHERE id = $1`, [v1.shift]);
    l = await list(cg.token);
    check("23 h 59 min después de su salida: sigue con nombre y acceso", find(l, t1)?.care_recipient_name === r1Name && (await msgs(cg.token, t1)).status === 200);
    await db.query(`UPDATE verification_events SET created_at = now() - interval '24 hours 1 minute', occurred_at = now() - interval '24 hours 1 minute' WHERE id = $1`, [v1.checkout]);
    l = await list(cg.token);
    check("24 h 01 min después: la conversación desaparece de la lista", !find(l, t1) && !l.raw.includes(r1Name));
    check("24 h 01 min después: no lee ni responde (404)", (await msgs(cg.token, t1)).status === 404 && (await reply(cg.token, t1)).status === 404);
    st = await startable(cg.token);
    check("24 h 01 min después: ya no puede iniciar sobre ella", !st.includes(r1));
    check("La conversación directa sigue disponible y sin nombre de residente", find(l, direct)?.care_recipient_name == null && find(l, direct) !== undefined);
    // History is untouched by the window: the agency still sees every message.
    const hist = await msgs(admin.token, t1);
    check("El historial se conserva (la agencia ve sus mensajes y la respuesta)", hist.status === 200 && (hist.body.messages ?? []).length === 2, `${(hist.body.messages ?? []).length}`);

    // 3. Others.
    const l2 = await list(cg2.token);
    check("Cuidadora sin turno: no ve ninguna de las dos ni sus nombres", !find(l2, t1) && !find(l2, t2) && !l2.raw.includes(r1Name) && !l2.raw.includes("Josefo"));
    check("Cuidadora sin turno: 404 al leer", (await msgs(cg2.token, t1)).status === 404);
    const lf = await list(familyA.token);
    check("Familia de la residente: la ve con nombre; no ve la de otra residente", find(lf, t1)?.care_recipient_name === r1Name && !find(lf, t2) && !lf.raw.includes("Josefo"));
    const lfb = await list(familyB.token);
    check("Familia de otra residente: no ve la conversación ni el nombre", !find(lfb, t1) && !lfb.raw.includes(r1Name));
    const la = await list(admin.token);
    check("Administradora: ve ambas con nombre", find(la, t1)?.care_recipient_name === r1Name && typeof find(la, t2)?.care_recipient_name === "string");
    const lo = await list(otherAdmin.token);
    const lfake = await call("GET", `/organizations/${randomUUID()}/conversations`, otherAdmin.token);
    check("Otra agencia: 403 sin datos, igual que una agencia inexistente", lo.status === 403 && lo.raw === lfake.raw && !lo.raw.includes(r1Name), `${lo.status}`);
    const lob = await list(otherAdmin.token, orgB);
    check("Otra agencia en su propia ruta: no ve conversaciones de A", lob.status === 200 && !lob.raw.includes(r1Name) && !find(lob, t1));
  } finally {
    await db.end();
    server.close();
  }

  console.log(`\nConversation names · 24 h window (${runtimeMode ? "app_runtime, RLS" : "superuser"})\n`);
  console.log("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail.replace(/\|/g, "/").slice(0, 160)} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
