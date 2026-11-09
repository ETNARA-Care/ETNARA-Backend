/**
 * Etapa 0 (9-nov-2026): ETNARA Central nunca recibe el enlace de activación del administrador de una agencia.
 *
 * Real Express app against a disposable database prepared by bootstrap:staging + seedDemo. The email provider
 * is replaced IN MEMORY (globalThis.fetch for api.resend.com only): nothing is sent, and the test reads the link
 * from the captured email exactly as the invitee would. Runs in both modes (app as postgres and as app_runtime).
 *
 *   DATABASE_URL=... MIGRATIONS_DATABASE_URL=... DEMO_PASSWORD=... ETNARA_DISPOSABLE_DB=true npx tsx scripts/verifyCentralAdminInvitations.ts
 */
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { hashPassword } from "../src/security/password.js";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl || !process.env.DEMO_PASSWORD || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL, DATABASE_URL, DEMO_PASSWORD and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl + appUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>;
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });
const HEX64 = /[a-f0-9]{64}/i;

// ---------------------------------------------------------------- fake email provider (in memory)
type Mode = "unset" | "ok" | "http500" | "throw";
let mode: Mode = "unset";
const outbox: { to: string; token: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.resend.com/")) return realFetch(input, init);
  if (mode === "throw") throw new Error("provider exploded: internal-host-10.0.0.1 secret-detail");
  if (mode === "http500") return new Response("{}", { status: 500 });
  const body = JSON.parse(init.body as string);
  const token = /token=([a-f0-9]{64})/.exec(body.html)?.[1] ?? "";
  outbox.push({ to: body.to, token });
  return new Response(JSON.stringify({ id: `msg_${randomUUID()}` }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
const setMode = (m: Mode) => { mode = m; if (m === "unset") delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = "test-key-not-real"; };

async function main() {
  const runtimeMode = new URL(appUrl!).username === "app_runtime";
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  const runtime = new pg.Client({ connectionString: appUrl }); await runtime.connect();
  const q = <T extends pg.QueryResultRow = Json>(s: string, p: unknown[] = []) => admin.query<T>(s, p);
  const { createApp } = await import("../src/app.js");
  const { resetCentralResendLimit, checkCentralResendLimit, CENTRAL_RESEND_LIMIT_PER_USER } = await import("../src/modules/platformOrganizations/platformAdminInvitations.rateLimit.js");
  const server = createApp().listen(0); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const r = await realFetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let j: Json = {}; try { j = JSON.parse(text) as Json; } catch { /* sin cuerpo */ }
    return { s: r.status, j, text };
  };
  const login = async (email: string, password: string) => { const r = await call("POST", "/auth/login", undefined, { email, password }); if (r.s !== 200) throw new Error(`login ${r.s}`); return r.j.token as string; };
  const tag = randomUUID().slice(0, 8);
  const noSecret = (text: string) => !HEX64.test(text) && !/activationToken|"token"|token_hash/i.test(text);
  const inspect = (token: string) => call("GET", `/platform/admin-invitations/inspect?token=${token}`);
  const audit = (id: string) => q<{ action: string; new_value: Json; organization_id: string | null; target_organization_id: string | null }>(
    `SELECT action, new_value, organization_id, target_organization_id FROM audit_log WHERE entity_type='access_invitation' AND entity_id=$1 ORDER BY occurred_at, action`, [id]);

  try {
    resetCentralResendLimit();
    // ---------------------------------------------------------------- actors
    const platPw = "Pw-" + randomBytes(12).toString("hex");
    const platUser = (await q<{ user_id: string }>(`SELECT user_id FROM platform_admins WHERE revoked_at IS NULL ORDER BY granted_at LIMIT 1`)).rows[0]?.user_id;
    if (!platUser) throw new Error("No platform admin in the disposable database");
    await q(`UPDATE users SET password_hash=$1 WHERE id=$2`, [await hashPassword(platPw), platUser]);
    const P = await login((await q<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [platUser])).rows[0].email, platPw);
    const demoOrg = (await q<{ id: string }>(`SELECT id FROM organizations WHERE name LIKE 'Cuidado en Casa Demo%' ORDER BY created_at LIMIT 1`)).rows[0].id;
    const A = await login("admin@demo.etnara.care", process.env.DEMO_PASSWORD!);
    await call("POST", "/me/active-organization", A, { organizationId: demoOrg });
    const C = await login("carlos@demo.etnara.care", process.env.DEMO_PASSWORD!);

    const created = await call("POST", "/platform/organizations", P, { name: `Agencia Ficticia Contrato ${tag}`, organizationType: "HOME_CARE_AGENCY", status: "trial" });
    const org = created.j.organization.id as string;
    const other = (await call("POST", "/platform/organizations", P, { name: `Agencia Ficticia Otra ${tag}`, organizationType: "HOME_CARE_AGENCY", status: "trial" })).j.organization.id as string;

    // ---------------------------------------------------------------- T1 creation never returns the token
    setMode("unset");
    const e1 = `rep1-${tag}@ficticia.example`;
    const inv1 = await call("POST", `/platform/organizations/${org}/admin-invitations`, P, { email: e1 });
    check("T01 invitar con el correo sin configurar: 201 y estado 'failed' con código fijo", inv1.s === 201 && inv1.j.emailDelivery?.status === "failed" && inv1.j.emailDelivery?.error === "EMAIL_NOT_CONFIGURED", `${inv1.s} ${JSON.stringify(inv1.j.emailDelivery)}`);
    check("T02 la respuesta no contiene token, hash ni enlace (correo fallido)", noSecret(inv1.text) && !("activationToken" in inv1.j), inv1.text.slice(0, 160));
    const id1 = inv1.j.invitation.id as string;

    setMode("throw");
    const e2 = `rep2-${tag}@ficticia.example`;
    const inv2 = await call("POST", `/platform/organizations/${org}/admin-invitations`, P, { email: e2 });
    check("T03 proveedor que lanza error: EMAIL_SEND_FAILED, sin detalles internos", inv2.s === 201 && inv2.j.emailDelivery?.error === "EMAIL_SEND_FAILED" && !/exploded|10\.0\.0\.1|secret/.test(inv2.text) && noSecret(inv2.text), inv2.text.slice(0, 160));
    setMode("http500");
    const inv2b = await call("POST", `/platform/organizations/${org}/admin-invitations`, P, { email: `rep2b-${tag}@ficticia.example` });
    check("T04 proveedor con HTTP 500: EMAIL_SEND_FAILED, sin token", inv2b.j.emailDelivery?.error === "EMAIL_SEND_FAILED" && noSecret(inv2b.text), inv2b.text.slice(0, 120));

    setMode("ok");
    const e3 = `rep3-${tag}@ficticia.example`;
    const inv3 = await call("POST", `/platform/organizations/${org}/admin-invitations`, P, { email: e3 });
    const mail3 = outbox.filter((m) => m.to === e3).at(-1);
    check("T05 correo enviado: 'sent', sin token en la respuesta; el enlace solo está en el correo", inv3.s === 201 && inv3.j.emailDelivery?.status === "sent" && noSecret(inv3.text) && !!mail3?.token && !inv3.text.includes(mail3!.token), inv3.text.slice(0, 160));
    check("T06 el enlace del correo es válido", (await inspect(mail3!.token)).s === 200);
    const id3 = inv3.j.invitation.id as string;

    const a1 = (await audit(id1)).rows;
    check("T07 auditoría ORG_ADMIN_INVITATION_CREATED sin correo ni secretos", a1.length === 1 && a1[0].action === "ORG_ADMIN_INVITATION_CREATED" && a1[0].target_organization_id === org && a1[0].organization_id === null
      && !JSON.stringify(a1[0]).includes(e1) && noSecret(JSON.stringify(a1[0].new_value)), JSON.stringify(a1));

    // ---------------------------------------------------------------- T2 list
    const list = await call("GET", `/platform/organizations/${org}/admin-invitations`, P);
    const keys = new Set<string>((list.j.invitations ?? []).flatMap((i: Json) => Object.keys(i)));
    check("T10 Central consulta el estado de las invitaciones", list.s === 200 && list.j.invitations.length === 4 && list.j.invitations.every((i: Json) => i.status === "pending"), `${list.s} ${list.j.invitations?.length}`);
    check("T11 la lista solo trae campos permitidos y ningún secreto", noSecret(list.text) && [...keys].every((k) => ["id", "email", "status", "createdAt", "expiresAt", "acceptedAt", "revokedAt", "resendable", "revocable"].includes(k)), [...keys].join(","));

    // ---------------------------------------------------------------- T3 resend rotates
    const rs = await call("POST", `/platform/organizations/${org}/admin-invitations/${id3}/resend`, P);
    const mail3b = outbox.filter((m) => m.to === e3).at(-1)!;
    check("T20 reenvío: 200 'sent', sin token en la respuesta", rs.s === 200 && rs.j.emailDelivery?.status === "sent" && noSecret(rs.text), rs.text.slice(0, 160));
    check("T21 el token rota: el enlace anterior deja de valer y el nuevo vale", mail3b.token !== mail3!.token && (await inspect(mail3!.token)).s === 400 && (await inspect(mail3b.token)).s === 200);
    setMode("http500");
    const rf = await call("POST", `/platform/organizations/${org}/admin-invitations/${id3}/resend`, P);
    check("T22 reenvío con correo fallido: 'failed' y el último enlace válido sigue valiendo (rotación revertida)", rf.s === 200 && rf.j.emailDelivery?.status === "failed" && (await inspect(mail3b.token)).s === 200 && noSecret(rf.text), rf.text.slice(0, 160));
    const a3 = (await audit(id3)).rows.map((r) => r.action);
    check("T23 auditoría de reenvío y de reenvío fallido", a3.includes("ORG_ADMIN_INVITATION_RESENT") && a3.includes("ORG_ADMIN_INVITATION_RESEND_FAILED"), a3.join(","));
    check("T24 la auditoría nunca guarda el token, el hash ni el correo", (await audit(id3)).rows.every((r) => noSecret(JSON.stringify(r.new_value)) && !JSON.stringify(r).includes(e3)));

    // ---------------------------------------------------------------- T4 limits
    setMode("ok");
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await call("POST", `/platform/organizations/${org}/admin-invitations/${id3}/resend`, P)).s);
    const lastOk = outbox.filter((m) => m.to === e3).at(-1)!;
    check("T30 límite por invitación: 5 intentos por hora, el 6.º recibe 429", JSON.stringify(statuses) === "[200,200,200,429]", JSON.stringify(statuses));
    check("T31 el 429 no rota el token", (await inspect(lastOk.token)).s === 200);
    resetCentralResendLimit();
    let allowed = 0; for (let i = 0; i < CENTRAL_RESEND_LIMIT_PER_USER + 3; i++) if (checkCentralResendLimit(`u-${tag}`)) allowed++;
    check("T32 límite por usuario de Central", allowed === CENTRAL_RESEND_LIMIT_PER_USER, `${allowed}`);
    resetCentralResendLimit();

    // ---------------------------------------------------------------- T5 expiry
    await q(`UPDATE access_invitations SET expires_at = now() - interval '1 minute' WHERE id=$1`, [id1]);
    const le = (await call("GET", `/platform/organizations/${org}/admin-invitations`, P)).j.invitations.find((i: Json) => i.id === id1);
    check("T40 una invitación vencida se muestra como 'expired' y sigue siendo renovable", le?.status === "expired" && le?.resendable === true, `${le?.status} ${le?.resendable}`);
    const re = await call("POST", `/platform/organizations/${org}/admin-invitations/${id1}/resend`, P);
    const mail1 = outbox.filter((m) => m.to === e1).at(-1)!;
    const days = (new Date(re.j.invitation?.expiresAt).getTime() - Date.now()) / 86_400_000;
    check("T41 reenviar una invitación vencida la renueva 7 días con enlace nuevo", re.s === 200 && re.j.invitation.status === "pending" && days > 6.9 && days <= 7.01 && (await inspect(mail1.token)).s === 200, `${re.s} ${days.toFixed(2)}`);
    const pw = "Clave-Ficticia-" + randomBytes(6).toString("hex");
    const act = await call("POST", "/platform/admin-invitations/activate", undefined, { token: mail1.token, password: pw });
    check("T42 compatibilidad: el enlace reenviado activa la cuenta (proceso existente)", act.s === 201 && act.j.activation?.organization_id === org, `${act.s}`);
    const R = await login(e1, pw);
    const me = await call("GET", "/me", R);
    check("T43 el representante entra como ORGANIZATION_ADMIN de su agencia", me.j.organizations?.some((o: Json) => o.id === org && o.roles.includes("ORGANIZATION_ADMIN")), JSON.stringify(me.j.organizations?.map((o: Json) => o.roles)));
    check("T44 una invitación aceptada no se reenvía ni se revoca (409)",
      (await call("POST", `/platform/organizations/${org}/admin-invitations/${id1}/resend`, P)).s === 409 && (await call("POST", `/platform/organizations/${org}/admin-invitations/${id1}/revoke`, P)).s === 409);
    await q(`UPDATE access_invitations SET expires_at = now() - interval '1 minute' WHERE id=$1`, [id3]);
    const exp = await call("POST", "/platform/admin-invitations/activate", undefined, { token: lastOk.token, password: pw });
    check("T45 el enlace de una invitación vencida no activa (proceso existente: INVITATION_NOT_AVAILABLE)", exp.s === 400 && exp.j.error === "INVITATION_NOT_AVAILABLE", `${exp.s} ${exp.j.error}`);
    // The activation function marks a row 'expired' when it is used after expiry; such a row is final.
    await q(`UPDATE access_invitations SET status='expired' WHERE id=$1`, [id3]);
    const ex2 = await call("POST", `/platform/organizations/${org}/admin-invitations/${id3}/resend`, P);
    check("T46 una invitación en estado 'expired' no se reenvía (409)", ex2.s === 409 && ex2.j.error === "INVITATION_NOT_RESENDABLE", `${ex2.s} ${ex2.j.error}`);
    const l46 = (await call("GET", `/platform/organizations/${org}/admin-invitations`, P)).j.invitations.find((i: Json) => i.id === id3);
    check("T47 la lista la marca como no renovable ni revocable", l46?.status === "expired" && l46?.resendable === false && l46?.revocable === false, JSON.stringify(l46));

    // ---------------------------------------------------------------- T6 revocation
    const e4 = `rep4-${tag}@ficticia.example`;
    const inv4 = await call("POST", `/platform/organizations/${org}/admin-invitations`, P, { email: e4 });
    const id4 = inv4.j.invitation.id as string, tok4 = outbox.filter((m) => m.to === e4).at(-1)!.token;
    const rv = await call("POST", `/platform/organizations/${org}/admin-invitations/${id4}/revoke`, P);
    check("T50 revocar: 200 'revoked', sin secretos", rv.s === 200 && rv.j.invitation?.status === "revoked" && noSecret(rv.text), rv.text.slice(0, 120));
    check("T51 el enlace revocado deja de valer", (await inspect(tok4)).s === 400);
    check("T52 una invitación revocada no se reenvía ni se vuelve a revocar (409)",
      (await call("POST", `/platform/organizations/${org}/admin-invitations/${id4}/resend`, P)).s === 409 && (await call("POST", `/platform/organizations/${org}/admin-invitations/${id4}/revoke`, P)).s === 409);
    check("T53 auditoría ORG_ADMIN_INVITATION_REVOKED", (await audit(id4)).rows.some((r) => r.action === "ORG_ADMIN_INVITATION_REVOKED"));
    const inv5 = await call("POST", `/platform/organizations/${org}/admin-invitations`, P, { email: `rep4-${tag}@ficticia.example` });
    check("T54 corregir: tras revocar se puede invitar de nuevo (proceso existente)", inv5.s === 201 && noSecret(inv5.text));

    // ---------------------------------------------------------------- T7 permissions and isolation
    const id5 = inv5.j.invitation.id as string;
    const paths: [string, string][] = [["GET", `/platform/organizations/${org}/admin-invitations`], ["POST", `/platform/organizations/${org}/admin-invitations/${id5}/resend`], ["POST", `/platform/organizations/${org}/admin-invitations/${id5}/revoke`]];
    const anon = await Promise.all(paths.map(([m, p]) => call(m, p)));
    check("T60 sin sesión: 401", anon.every((r) => r.s === 401), anon.map((r) => r.s).join(","));
    // admin@demo is ALSO a platform admin in the disposable fixture (seedDemo), so the agency-only actors are the
    // freshly activated representative (ORGANIZATION_ADMIN of `org`, not platform) and the caregiver.
    check("T61 el representante activado no es administrador de la plataforma (actor válido)", (await q(`SELECT count(*)::int n FROM platform_admins pa JOIN users u ON u.id=pa.user_id WHERE lower(u.email)=lower($1)`, [e1])).rows[0].n === 0);
    for (const [who, tok] of [["cuidador", C], ["representante (administrador de agencia)", R]] as const) {
      const rr = await Promise.all(paths.map(([m, p]) => call(m, p, tok)));
      check(`T61 ${who}: 403 PLATFORM_ADMIN_REQUIRED`, rr.every((r) => r.s === 403 && r.j.error === "PLATFORM_ADMIN_REQUIRED"), rr.map((r) => r.s).join(","));
    }
    check("T62 tras los intentos ajenos la invitación sigue pendiente", (await q(`SELECT status::text s FROM access_invitations WHERE id=$1`, [id5])).rows[0].s === "pending");
    check("T63 otra agencia en la ruta: 404 (sin cruce entre agencias)",
      (await call("POST", `/platform/organizations/${other}/admin-invitations/${id5}/resend`, P)).s === 404 && (await call("POST", `/platform/organizations/${other}/admin-invitations/${id5}/revoke`, P)).s === 404
      && (await call("GET", `/platform/organizations/${other}/admin-invitations`, P)).j.invitations.length === 0);
    // Team invitations created by the agency: by its own administrator (R, in `org`) and by a person who is both
    // platform admin and agency admin (admin@demo, in Casa Demo). Both stay the agency's.
    await call("POST", "/me/active-organization", R, { organizationId: org });
    const teams = [
      { org, r: await call("POST", `/organizations/${org}/team/invitations`, R, { email: `coadmin-${tag}@ficticia.example`, role: "ORGANIZATION_ADMIN" }) },
      { org: demoOrg, r: await call("POST", `/organizations/${demoOrg}/team/invitations`, A, { email: `coadmin2-${tag}@ficticia.example`, role: "ORGANIZATION_ADMIN" }) },
    ];
    for (const [i, t] of teams.entries()) {
      const teamId = t.r.j.invitation?.id as string;
      const centralList = (await call("GET", `/platform/organizations/${t.org}/admin-invitations`, P)).j.invitations as Json[];
      check(`T64.${i + 1} Central no ve la invitación de equipo creada por la agencia`, t.r.s === 201 && !!teamId && !centralList.some((x) => x.id === teamId), `${t.r.s}`);
      check(`T65.${i + 1} Central no la reenvía ni la revoca (404) y sigue pendiente`,
        (await call("POST", `/platform/organizations/${t.org}/admin-invitations/${teamId}/resend`, P)).s === 404 && (await call("POST", `/platform/organizations/${t.org}/admin-invitations/${teamId}/revoke`, P)).s === 404
        && (await q(`SELECT status::text s FROM access_invitations WHERE id=$1`, [teamId])).rows[0].s === "pending");
    }
    check("T66b la agencia sigue gestionando su propio equipo (proceso existente: el enlace se muestra a la agencia)", typeof teams[0].r.j.token === "string");
    check("T66 identificadores inválidos: 404", (await call("POST", `/platform/organizations/${org}/admin-invitations/not-a-uuid/resend`, P)).s === 404);
    await call("PATCH", `/platform/organizations/${org}/lifecycle`, P, { action: "suspend", reason: "Prueba ficticia Etapa 0" });
    const sus = await call("POST", `/platform/organizations/${org}/admin-invitations/${id5}/resend`, P);
    check("T67 agencia suspendida: no se reenvía (404) y la suspensión revocó la invitación", sus.s === 404 && (await q(`SELECT status::text s FROM access_invitations WHERE id=$1`, [id5])).rows[0].s === "revoked", `${sus.s}`);

    // ---------------------------------------------------------------- T8 audit is append-only for the runtime role
    if (runtimeMode) {
      const tryRuntime = async (s: string) => { try { await runtime.query(s); return "ok"; } catch (e) { return (e as { code?: string }).code ?? "err"; } };
      check("T70 app_runtime no puede modificar ni borrar la auditoría", (await tryRuntime(`UPDATE audit_log SET action='X' WHERE entity_type='access_invitation'`)) === "42501" && (await tryRuntime(`DELETE FROM audit_log WHERE entity_type='access_invitation'`)) === "42501");
    }
  } finally {
    globalThis.fetch = realFetch;
    server.close(); await admin.end(); await runtime.end();
  }
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}${r.pass ? "" : ` — ${r.detail}`}`);
  console.log(`\nCENTRAL_ADMIN_INVITATIONS (${new URL(appUrl!).username === "app_runtime" ? "app_runtime" : "superuser"}) ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
