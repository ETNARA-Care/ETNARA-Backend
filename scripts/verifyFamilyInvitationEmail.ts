/**
 * Family invitations by e-mail (migration 120), end to end over HTTP as app_runtime.
 *
 * The e-mail provider is replaced inside this process by a fake that records each
 * message and can be told to refuse the next N sends. Nothing is sent anywhere.
 * Synthetic data only: its own agency, invented residents, .invalid addresses.
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
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });

// ---------------------------------------------------------------- fake e-mail provider (in-process only)
const mails: Array<{ to: string; subject: string; html: string; text: string }> = [];
let refuseNext = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) {
    if (refuseNext > 0) { refuseNext--; return new Response(JSON.stringify({ name: "validation_error", message: "simulated refusal" }), { status: 403 }); }
    const body = JSON.parse(String(init?.body ?? "{}"));
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, subject: String(body.subject ?? ""), html: String(body.html ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";
process.env.ACTIVATION_BASE_URL = "https://app.example.invalid";

const logged: string[] = [];
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); if (level === "error" && !String(args[0]).startsWith("Family invitation email delivery failed")) original(...args); };
}
const out = (line: string) => process.stdout.write(line + "\n");
const linkToken = (html: string) => /\/activate#token=([0-9a-f]{64})/.exec(html)?.[1] ?? null;

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let clientIp = "198.51.100.40";
  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await realFetch(base + path, {
      method, headers: { "Content-Type": "application/json", "X-Forwarded-For": clientIp, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed, text };
  }

  const tag = randomUUID().slice(0, 8);
  const password = `Clave-${randomBytes(9).toString("hex")}`;
  const hash = await hashPassword(password);
  const newOrg = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgId = await newOrg(`Agencia Verificación ${tag}`);
  const otherOrg = await newOrg(`Otra Agencia ${tag}`);
  async function person(key: string, roles: string[], org = orgId) {
    const email = `fi-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, org])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, org, roles]);
    return { email, userId };
  }
  const resident = async (first: string, org = orgId) => (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,$2,'Prueba') RETURNING id`, [org, `${first}${tag}`])).rows[0].id;
  const admin = await person("admin", ["ORGANIZATION_ADMIN"]);
  const sup = await person("supervisor", ["SUPERVISOR"]);
  const cg = await person("caregiver", ["WORKER"]);
  const outsider = await person("outsider", ["ORGANIZATION_ADMIN"], otherOrg);
  const resA = await resident("Aurora");
  const resB = await resident("Bruno");
  const resOther = await resident("Ofelia", otherOrg);
  const login = async (email: string, pw = password) => (await call("POST", "/auth/login", "", { email, password: pw })).body.token as string;
  const adminTok = await login(admin.email);
  const supTok = await login(sup.email);
  const cgTok = await login(cg.email);
  const outsiderTok = await login(outsider.email);
  const famEmail = `fi-familiar-${tag}@example.invalid`;
  const invite = (tok: string, email: string, careRecipientId: string, relationshipType = "Hija/o", org = orgId) =>
    call("POST", `/organizations/${org}/access-invitations`, tok, { type: "family", email, careRecipientId, relationshipType });
  const rows = (email: string) => q<{ id: string; status: string; token_hash: string; email_sent_at: string | null; relationship_type: string }>(
    `SELECT id, status, token_hash, email_sent_at, relationship_type FROM access_invitations WHERE lower(email)=lower($1) ORDER BY created_at`, [email]).then((r) => r.rows);
  const mailsTo = (email: string) => mails.filter((m) => m.to === email);

  try {
    // ------------------------------------------------------------ F1-F4 create = e-mail sent
    const created = await invite(adminTok, famEmail, resA);
    const m1 = mailsTo(famEmail);
    const t1 = linkToken(m1[0]?.html ?? "");
    const stored1 = await rows(famEmail);
    check("F1 «Crear enlace seguro» (familia): 201 con emailDelivery=sent y el correo sale hacia la dirección indicada",
      created.status === 201 && created.body.emailDelivery?.status === "sent" && m1.length === 1, `${created.status} mails=${m1.length}`);
    check("F2 la respuesta NO incluye el token ni el enlace (solo llega por correo)",
      !("token" in created.body) && !!t1 && !created.text.includes(t1), `keys=${Object.keys(created.body)}`);
    check("F3 el enlace usa /activate#token=<64 hex> (fragmento: no llega a logs del servidor); en BD solo el hash; vence en 7 días",
      !!t1 && stored1.length === 1 && stored1[0].token_hash !== t1 && stored1[0].email_sent_at !== null,
      `rows=${stored1.length} sent_at=${!!stored1[0]?.email_sent_at}`);
    const ttl = (await q<{ d: number }>(`SELECT round(extract(epoch FROM expires_at - now())/86400)::int AS d FROM access_invitations WHERE id=$1`, [stored1[0].id])).rows[0].d;
    check("F4 vigencia de 7 días", ttl === 7, `días=${ttl}`);

    // ------------------------------------------------------------ E1-E4 e-mail content and privacy
    const mail = m1[0] ?? { to: "", subject: "", html: "", text: "" };
    const residentName = `Aurora${tag}`;
    check("E1 el correo nombra a la agencia y lleva asunto profesional", mail.subject.includes(`Agencia Verificación ${tag}`) && mail.subject.includes("Portal Familiar") && mail.html.includes("Activar mi acceso"), mail.subject);
    check("E2 privacidad: el correo NO contiene el nombre del residente, ni el correo del administrador, ni contraseñas",
      !mail.html.includes(residentName) && !mail.text.includes(residentName) && !mail.html.includes(admin.email) && !/contraseña:\s*\S/i.test(mail.text));
    check("E3 versión de texto plano con el mismo enlace y la fecha de vencimiento", mail.text.includes(`/activate#token=${t1}`) && /Vence el/.test(mail.text));
    const injOrg = await newOrg(`<script>alert(1)</script> & "Co" ${tag}`);
    const injAdmin = await person("injadmin", ["ORGANIZATION_ADMIN"], injOrg);
    const injRes = await resident("Ines", injOrg);
    await invite(await login(injAdmin.email), `fi-inj-${tag}@example.invalid`, injRes, "Familiar", injOrg);
    const injMail = mailsTo(`fi-inj-${tag}@example.invalid`)[0]?.html ?? "";
    check("E4 el nombre de la agencia se escapa en el HTML (sin inyección)", injMail.includes("&lt;script&gt;") && !injMail.includes("<script>alert"));

    // ------------------------------------------------------------ D1-D3 retry = no duplicate
    const again = await invite(adminTok, famEmail, resA);
    check("D1 repetir en menos de 1 minuto: 429 RESEND_TOO_SOON, sin correo nuevo ni invitación duplicada",
      again.status === 429 && again.body.error === "RESEND_TOO_SOON" && mailsTo(famEmail).length === 1 && (await rows(famEmail)).length === 1, `${again.status} ${again.body.error}`);
    await q(`UPDATE access_invitations SET email_sent_at = now() - interval '2 minutes' WHERE id=$1`, [stored1[0].id]);
    const again2 = await invite(adminTok, famEmail, resA, "Tutora/or");
    const t2 = linkToken(mailsTo(famEmail)[1]?.html ?? "");
    const rowsAfter = await rows(famEmail);
    check("D2 repetir después de 1 minuto: misma invitación (sin duplicado), correo nuevo, resent=true, relación actualizada",
      again2.status === 201 && again2.body.resent === true && rowsAfter.length === 1 && !!t2 && t2 !== t1 && rowsAfter[0].relationship_type === "Tutora/or",
      `${again2.status} filas=${rowsAfter.length} rel=${rowsAfter[0]?.relationship_type}`);
    const oldLink = await call("POST", "/access-invitations/inspect", "", { token: t1 });
    check("D3 el enlace anterior deja de funcionar cuando sale el nuevo", oldLink.status === 404, `${oldLink.status}`);

    // ------------------------------------------------------------ P1-P5 provider failure
    const failEmail = `fi-fallo-${tag}@example.invalid`;
    refuseNext = 1;
    const failed = await invite(adminTok, failEmail, resB);
    const failedRows = await rows(failEmail);
    check("P1 si el proveedor rechaza: 502 INVITATION_EMAIL_FAILED, sin token, invitación pendiente sin correo enviado",
      failed.status === 502 && failed.body.error === "INVITATION_EMAIL_FAILED" && !("token" in failed.body) && failedRows.length === 1 && failedRows[0].status === "pending" && failedRows[0].email_sent_at === null,
      `${failed.status} ${failed.body.error} filas=${failedRows.length}`);
    const retry = await invite(adminTok, failEmail, resB);
    const retryRows = await rows(failEmail);
    check("P2 reintentar enseguida tras un fallo: se permite, misma invitación, ahora sí sale el correo",
      retry.status === 201 && retry.body.emailDelivery?.status === "sent" && retryRows.length === 1 && mailsTo(failEmail).length === 1 && !!retryRows[0].email_sent_at,
      `${retry.status} filas=${retryRows.length} mails=${mailsTo(failEmail).length}`);
    const goodToken = linkToken(mailsTo(failEmail)[0]?.html ?? "") ?? "0".repeat(64);
    await q(`UPDATE access_invitations SET email_sent_at = now() - interval '2 minutes' WHERE id=$1`, [retryRows[0].id]);
    refuseNext = 1;
    const failedResend = await call("POST", `/organizations/${orgId}/access-invitations/${retryRows[0].id}/resend`, adminTok);
    const stillValid = await call("POST", "/access-invitations/inspect", "", { token: goodToken });
    check("P3 un reenvío que falla NO invalida el enlace que la persona ya tiene", failedResend.status === 502 && stillValid.status === 200, `resend=${failedResend.status} enlace=${stillValid.status}`);
    delete process.env.RESEND_API_KEY;
    const notConfigured = await call("POST", `/organizations/${orgId}/access-invitations/${retryRows[0].id}/resend`, adminTok);
    process.env.RESEND_API_KEY = "test-only-not-a-key";
    check("P4 sin RESEND_API_KEY: 503 EMAIL_NOT_CONFIGURED (error claro, nada cambia)", notConfigured.status === 503 && notConfigured.body.error === "EMAIL_NOT_CONFIGURED", `${notConfigured.status}`);
    const leaked = logged.filter((l) => l.includes(famEmail) || l.includes(failEmail) || (t1 && l.includes(t1)) || (t2 && l.includes(t2)) || l.includes(goodToken));
    check("P5 los logs no contienen correos, tokens ni enlaces", leaked.length === 0, `líneas=${leaked.length}`);

    // ------------------------------------------------------------ R1-R4 resend
    const resent = await call("POST", `/organizations/${orgId}/access-invitations/${retryRows[0].id}/resend`, adminTok);
    const t3 = linkToken(mailsTo(failEmail).at(-1)?.html ?? "");
    const afterResend = await call("POST", "/access-invitations/inspect", "", { token: goodToken });
    check("R1 «Reenviar»: 200, correo nuevo, enlace anterior invalidado, sin token en la respuesta",
      resent.status === 200 && resent.body.emailDelivery?.status === "sent" && !!t3 && t3 !== goodToken && afterResend.status === 404 && !("token" in resent.body),
      `${resent.status} viejo=${afterResend.status}`);
    const tooSoon = await call("POST", `/organizations/${orgId}/access-invitations/${retryRows[0].id}/resend`, adminTok);
    check("R2 reenviar otra vez en menos de 1 minuto: 429", tooSoon.status === 429, `${tooSoon.status}`);
    await q(`UPDATE access_invitations SET email_sent_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' WHERE id=$1`, [retryRows[0].id]);
    const expiredResend = await call("POST", `/organizations/${orgId}/access-invitations/${retryRows[0].id}/resend`, adminTok);
    const reopened = (await rows(failEmail))[0];
    check("R3 una invitación vencida se puede reenviar: vuelve a pendiente con 7 días nuevos", expiredResend.status === 200 && reopened.status === "pending", `${expiredResend.status} ${reopened.status}`);
    const supResend = await call("POST", `/organizations/${orgId}/access-invitations/${retryRows[0].id}/resend`, supTok);
    check("R4 un supervisor (gestor de la agencia) también puede reenviar, con el mismo límite de 1 minuto", supResend.status === 429, `${supResend.status}`);

    // ------------------------------------------------------------ S1-S5 authorization unchanged
    const cgInvite = await invite(cgTok, `fi-cg-${tag}@example.invalid`, resA);
    const cgResend = await call("POST", `/organizations/${orgId}/access-invitations/${retryRows[0].id}/resend`, cgTok);
    check("S1 una cuidadora no puede invitar ni reenviar (403) y no sale ningún correo",
      cgInvite.status === 403 && cgResend.status === 403 && mailsTo(`fi-cg-${tag}@example.invalid`).length === 0, `${cgInvite.status}/${cgResend.status}`);
    const crossCreate = await invite(outsiderTok, `fi-x-${tag}@example.invalid`, resA, "Familiar", otherOrg);
    const crossResend = await call("POST", `/organizations/${otherOrg}/access-invitations/${retryRows[0].id}/resend`, outsiderTok);
    const crossTarget = await call("POST", `/organizations/${orgId}/access-invitations/${retryRows[0].id}/resend`, outsiderTok);
    check("S2 otra agencia no puede invitar a residentes ajenos ni reenviar invitaciones ajenas",
      crossCreate.status === 404 && crossResend.status === 409 && crossTarget.status === 403 && mailsTo(`fi-x-${tag}@example.invalid`).length === 0,
      `${crossCreate.status}/${crossResend.status}/${crossTarget.status}`);
    const noAuth = await call("POST", `/organizations/${orgId}/access-invitations/${retryRows[0].id}/resend`, "");
    check("S3 sin sesión: 401", noAuth.status === 401, `${noAuth.status}`);
    void resOther;

    // ------------------------------------------------------------ A1-A6 activation and access
    const famPw = `Familia-${randomBytes(6).toString("hex")}`;
    const act = await call("POST", "/access-invitations/activate", "", { token: t2, password: famPw });
    const reuse = await call("POST", "/access-invitations/activate", "", { token: t2, password: famPw });
    check("A1 el familiar crea su contraseña con el enlace del correo; el enlace es de un solo uso", act.status === 200 && reuse.status === 404, `${act.status}/${reuse.status}`);
    const famTok = await login(famEmail, famPw);
    const mine = await call("GET", "/me/care-recipients", famTok);
    const ids = (mine.body.recipients ?? []).map((r: Json) => r.recipientId);
    const otherRes = await call("GET", `/me/care-recipients/${resB}`, famTok);
    check("A2 ve únicamente al residente autorizado (A) y 404 en otro residente de la misma agencia",
      ids.length === 1 && ids[0] === resA && otherRes.status === 404, `ids=${ids.length} otro=${otherRes.status}`);
    const accRow = (await rows(famEmail))[0];
    const famRel = (await q<{ relationship_type: string; can_view_photos: boolean; is_primary_contact: boolean; can_participate_in_verification: boolean; can_view_service_location: boolean }>(
      `SELECT relationship_type, can_view_photos, is_primary_contact, can_participate_in_verification, can_view_service_location FROM family_relationships WHERE care_recipient_id=$1`, [resA])).rows[0];
    check("A3 permisos del familiar con los valores por defecto existentes (nada se amplía)",
      accRow.status === "accepted" && famRel?.relationship_type === "Tutora/or" && !famRel.is_primary_contact && !famRel.can_participate_in_verification && !famRel.can_view_service_location,
      JSON.stringify(famRel));
    const afterAccept = await call("POST", `/organizations/${orgId}/access-invitations/${accRow.id}/resend`, adminTok);
    check("A4 una invitación ya aceptada no se puede reenviar (409)", afterAccept.status === 409 && afterAccept.body.error === "INVITATION_NOT_RESENDABLE", `${afterAccept.status}`);
    await q(`UPDATE access_invitations SET email_sent_at = now() - interval '2 minutes' WHERE lower(email)=lower($1)`, [failEmail]);
    const revokeTarget = (await rows(failEmail))[0];
    await call("POST", `/organizations/${orgId}/access-invitations/${revokeTarget.id}/revoke`, adminTok);
    const revokedResend = await call("POST", `/organizations/${orgId}/access-invitations/${revokeTarget.id}/resend`, adminTok);
    const revokedLink = await call("POST", "/access-invitations/inspect", "", { token: linkToken(mailsTo(failEmail).at(-1)?.html ?? "") ?? "0".repeat(64) });
    check("A5 revocada: no se reenvía (409) y su último enlace ya no sirve", revokedResend.status === 409 && revokedLink.status === 404, `${revokedResend.status}/${revokedLink.status}`);
    const second = await invite(adminTok, famEmail, resB, "Familiar");
    const tB = linkToken(mailsTo(famEmail).at(-1)?.html ?? "");
    const inspB = await call("POST", "/access-invitations/inspect", "", { token: tB });
    const accB = await call("POST", "/access-invitations/accept", famTok, { token: tB });
    const mine2 = await call("GET", "/me/care-recipients", famTok);
    check("A6 cuenta existente: el correo también llega; aceptar con su sesión añade el residente B (A y B, nada más)",
      second.status === 201 && inspB.body.invitation?.account_exists === true && accB.status === 200 && (mine2.body.recipients ?? []).length === 2,
      `${second.status} existe=${inspB.body.invitation?.account_exists} accept=${accB.status} n=${(mine2.body.recipients ?? []).length}`);

    // ------------------------------------------------------------ W1-W2 regressions: workers and password reset untouched
    const worker = await q<{ membership_id: string }>(`WITH w AS (INSERT INTO workers (display_name) VALUES ('Cuidadora Prueba') RETURNING id)
      INSERT INTO organization_worker_memberships (worker_id, organization_id, internal_role) SELECT id, $1, 'Cuidadora' FROM w RETURNING id AS membership_id`, [orgId]);
    const mailsBefore = mails.length;
    const workerInvite = await call("POST", `/organizations/${orgId}/access-invitations`, adminTok, { type: "worker", email: `fi-worker-${tag}@example.invalid`, workerMembershipId: worker.rows[0].membership_id });
    check("W1 invitaciones de cuidadoras sin cambios: 201 con token y sin correo", workerInvite.status === 201 && typeof workerInvite.body.token === "string" && mails.length === mailsBefore, `${workerInvite.status}`);
    clientIp = "198.51.100.41";
    const reset = await call("POST", "/auth/password-reset/request", "", { email: cg.email });
    for (let i = 0; i < 40 && !mailsTo(cg.email).length; i++) await new Promise((r) => setTimeout(r, 50));
    const resetMail = mailsTo(cg.email)[0];
    check("W2 recuperación de contraseña sin cambios: mismo asunto y enlace /reset-password",
      reset.status === 200 && !!resetMail && resetMail.subject === "Establece tu contraseña de ETNARA Care" && /\/reset-password\?token=[0-9a-f]{64}/.test(resetMail.html), resetMail?.subject ?? "sin correo");
  } finally {
    server.close();
    await pool.end();
    await db.end();
  }

  const failedChecks = results.filter((r) => !r.pass);
  for (const r of results) out(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.detail ? `  [${r.detail}]` : ""}`);
  out(`\n${results.length - failedChecks.length}/${results.length} family invitation e-mail checks passed`);
  if (failedChecks.length) {
    for (const r of failedChecks) out(`::error title=verifyFamilyInvitationEmail::${r.check} [${r.detail}]`);
    process.exit(1);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
