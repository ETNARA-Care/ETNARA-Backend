/**
 * Módulo contractual, Etapas 1 y 2 (152) — 9-nov-2026. Datos y documentos FICTICIOS, base desechable.
 * Ningún correo real: el proveedor de correo se simula dentro del proceso (como verifyPasswordRecovery).
 *
 * App real por HTTP como app_runtime (RLS + triggers). Etapa 1: interruptor, marcas de prueba, huella
 * calculada por la base, borradores invisibles, permisos de Central (administra, nunca acepta),
 * contrato oficial no publicable, inmutabilidad, representante autorizada, aislamiento, auditoría,
 * concurrencia y reversión que se niega con evidencia oficial.
 * Etapa 2: código de verificación al correo de la cuenta (destino fijado por la base, solo huella
 * guardada, límites de envío, intentos, vencimiento, un solo uso, fallo de entrega), firma ligada al
 * código, descargas (documento PDF/texto y constancia), consulta de Central, versiones que exigen o
 * no nueva aceptación, y sesiones abiertas que pierden el permiso a mitad del flujo.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const errCode = (p: Promise<unknown>) => p.then(() => "ok", (e) => `${(e as { code?: string }).code ?? "?"}:${(e as Error).message}`);

// ---------------------------------------------------------------- proveedor de correo simulado (en el proceso)
const mails: Array<{ to: string; subject: string; html: string }> = [];
let mailMode: "ok" | "fail" = "ok";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) {
    if (mailMode === "fail") return new Response("{}", { status: 500 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, subject: String(body.subject ?? ""), html: String(body.html ?? "") });
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  // El catálogo es global y la evidencia es inalterable: la prueba necesita una base sin documentos contractuales.
  if (Number((await q(`SELECT count(*) FROM contract_documents`)).rows[0].count) > 0) throw new Error("Requires a disposable database with an empty contract catalog");
  process.env.CONTRACTS_MODULE = "off";
  delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
  const rt = new pg.Client({ connectionString: u.toString() });
  await rt.connect();
  const asRuntime = async <T>(userId: string, orgId: string, superadmin: boolean, fn: () => Promise<T>) => {
    await rt.query("BEGIN");
    try {
      await rt.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`, [userId, orgId, String(superadmin)]);
      return await fn();
    } finally { await rt.query("ROLLBACK"); }
  };
  const pdfDir = mkdtempSync(join(tmpdir(), "contracts-pdf-"));
  const pdfText = (buf: Buffer) => { const f = join(pdfDir, `${randomUUID()}.pdf`); writeFileSync(f, buf); return execFileSync("pdftotext", ["-layout", f, "-"]).toString("utf8"); };

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toUpperCase();

  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await realFetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), "User-Agent": "verificador-contratos/2.0" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = Buffer.from(await res.arrayBuffer());
    let json: Json = {};
    try { json = JSON.parse(raw.toString("utf8")); } catch { /* binario o vacío */ }
    return { status: res.status, body: json, raw, headers: res.headers };
  }

  // ---------------------------------------------------------------- personas y agencias ficticias
  const org = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgA = await org(`Agencia Ficticia A ${tag}`), orgB = await org(`Agencia Ficticia B ${tag}`);
  type P = { email: string; userId: string; token: string; membership: string; orgId: string };
  async function person(key: string, orgId: string, roles: string[]): Promise<P> {
    const email = `ct-${key}-${tag.toLowerCase()}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const membership = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [membership, orgId, roles]);
    return { email, userId, token: "", membership, orgId };
  }
  const A = {
    admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]), admin2: await person("a-admin2", orgA, ["ORGANIZATION_ADMIN"]),
    sup: await person("a-sup", orgA, ["SUPERVISOR"]), worker: await person("a-worker", orgA, ["WORKER"]), family: await person("a-family", orgA, ["FAMILY"]),
    revoked: await person("a-revoked", orgA, ["ORGANIZATION_ADMIN"]), midRevoke: await person("a-midrevoke", orgA, ["ORGANIZATION_ADMIN"]),
    midDemote: await person("a-middemote", orgA, ["ORGANIZATION_ADMIN"]),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]) };
  const central = await person("central", orgB, []);
  await q(`DELETE FROM organization_memberships WHERE id=$1`, [central.membership]);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.userId]);
  for (const p of [...Object.values(A), ...Object.values(B), central]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${p.email} ${r.status}`);
    p.token = r.body.token;
    if (p !== central) await call("POST", "/me/active-organization", p.token, { organizationId: p.orgId });
  }
  await q(`UPDATE organization_memberships SET status='revoked' WHERE id=$1`, [A.revoked.membership]);

  const P_ = "/platform/contracts";
  const O = (o: string) => `/organizations/${o}/contracts`;
  const BANNER = "DOCUMENTO FICTICIO DE PRUEBA — sin valor legal. No es el contrato oficial de ETNARA Care.";
  const body1 = `${BANNER}\n\n1. Objeto (ficticio). Texto de prueba para verificar versiones y aceptación.\n2. Duración (ficticia). Treinta días.\n`;
  const SIGN = { signerFullName: "Ana Ficticia Prueba", signerTitle: "Presidenta (ficticia)", confirmAuthority: true, confirm: true };
  const lastCode = (email: string) => { const m = [...mails].reverse().find((x) => x.to === email); return m?.html.match(/>(\d{6})</)?.[1] ?? null; };
  /** Firma completa: pide el código, lo lee del correo simulado y acepta. */
  async function sign(p: P, o: string, versionId: string, contentSha256: string, signer = SIGN) {
    const req = await call("POST", `${O(o)}/versions/${versionId}/signature-code`, p.token, { contentSha256, ...signer });
    if (req.status !== 201) return { req, acc: null };
    const acc = await call("POST", `${O(o)}/versions/${versionId}/accept`, p.token, { contentSha256, ...signer, challengeId: req.body.challengeId, code: lastCode(p.email) });
    return { req, acc };
  }
  /** Código ya consumido creado por mantenimiento (superusuario), para las pruebas directas en la base. */
  async function suChallenge(o: string, versionId: string, userId: string) {
    const id = randomUUID();
    await q(`INSERT INTO contract_signature_challenges (id,organization_id,document_version_id,user_id,code_hash) VALUES ($1,$2,$3,$4,repeat('f',64))`, [id, o, versionId, userId]);
    await q(`UPDATE contract_signature_challenges SET delivery_status='sent' WHERE id=$1`, [id]);
    await q(`UPDATE contract_signature_challenges SET consumed_at=now() WHERE id=$1`, [id]);
    return id;
  }

  // ================================================================ ETAPA 1 (adaptada)
  const off = [await call("GET", P_, central.token), await call("GET", O(orgA), A.admin.token)];
  check("1. CONTRACTS_MODULE apagado (valor por defecto): las rutas responden 404", off.every((r) => r.status === 404), off.map((r) => r.status));
  process.env.CONTRACTS_MODULE = "on";
  // 153: firmar documentos de PRUEBA exige este interruptor (solo pruebas locales).
  process.env.CONTRACTS_TEST_SIGNING = "on";

  const badTest = await call("POST", `${P_}/documents`, central.token, { code: `MSA_${tag}`, title: "[PRUEBA] Acuerdo", kind: "SERVICE_AGREEMENT", isTest: true });
  const badOfficial = await call("POST", `${P_}/documents`, central.token, { code: `TEST_MSA_${tag}`, title: "Acuerdo de servicio", kind: "SERVICE_AGREEMENT", isTest: false });
  check("2. Marcas: un documento de prueba exige código TEST_ y título «[PRUEBA]»; uno oficial no puede usarlas (422)", badTest.status === 422 && badOfficial.status === 422, [badTest.status, badOfficial.status]);
  const doc = await call("POST", `${P_}/documents`, central.token, { code: `TEST_MSA_${tag}`, title: `[PRUEBA] Acuerdo de servicio ficticio ${tag}`, kind: "SERVICE_AGREEMENT", isTest: true });
  const docId = doc.body.document?.id;
  check("2b. Central crea el documento de prueba (201, is_test)", doc.status === 201 && doc.body.document.is_test === true, doc.status);
  const noBanner = await call("POST", `${P_}/documents/${docId}/versions`, central.token, { versionLabel: "0.9", body: "Texto sin la marca de prueba al inicio, que la base debe rechazar siempre." });
  check("2c. Una versión de prueba sin «DOCUMENTO FICTICIO DE PRUEBA» al inicio se rechaza (422)", noBanner.status === 422 && noBanner.body.error === "CONTRACT_TEST_BANNER_REQUIRED", noBanner.body);

  const v1 = await call("POST", `${P_}/documents/${docId}/versions`, central.token, { versionLabel: "1.0", body: body1 });
  const v1Id = v1.body.version?.id;
  check("3. Borrador: huella SHA-256 = la del texto (la calcula la base)", v1.status === 201 && v1.body.version.content_sha256 === sha256(body1) && v1.body.version.status === "draft" && v1.body.version.requires_new_acceptance === true, v1.body.version?.content_sha256);
  const forged = await errCode(q(`UPDATE contract_document_versions SET content_sha256=repeat('a',64) WHERE id=$1`, [v1Id]));
  const forgedRow = (await q(`SELECT content_sha256 FROM contract_document_versions WHERE id=$1`, [v1Id])).rows[0];
  check("3b. Ni el superusuario fija una huella falsa: la base la recalcula", forged === "ok" && forgedRow.content_sha256 === sha256(body1), forgedRow.content_sha256);

  const listDraft = await call("GET", O(orgA), A.admin.token);
  const getDraft = await call("GET", `${O(orgA)}/versions/${v1Id}`, A.admin.token);
  const pdfDraft = await call("GET", `${O(orgA)}/versions/${v1Id}/document.pdf`, A.admin.token);
  check("4. La agencia no ve ni descarga borradores (lista vacía, 404)", listDraft.body.contracts?.length === 0 && getDraft.status === 404 && pdfDraft.status === 404, [listDraft.body.contracts?.length, getDraft.status, pdfDraft.status]);

  const notCentral = [
    await call("POST", `${P_}/documents`, A.admin.token, { code: `TEST_X_${tag}`, title: "[PRUEBA] X", kind: "OTHER", isTest: true }),
    await call("POST", `${P_}/documents/${docId}/versions`, A.admin.token, { versionLabel: "9", body: body1 }),
    await call("PATCH", `${P_}/versions/${v1Id}`, B.admin.token, { body: body1 + "x" }),
    await call("POST", `${P_}/versions/${v1Id}/publish`, A.admin.token),
    await call("GET", P_, A.sup.token), await call("GET", `${P_}/overview`, A.admin.token),
  ];
  check("5. Las agencias no administran ni consultan Central (403)", notCentral.every((r) => r.status === 403 && r.body.error === "PLATFORM_ACCESS_DENIED"), notCentral.map((r) => r.status));
  const rtInsert = await errCode(asRuntime(A.admin.userId, orgA, true, () => rt.query(`INSERT INTO contract_documents (code,title,kind,is_test,created_by_user_id) VALUES ($1,'[PRUEBA] Falso','OTHER',true,$2)`, [`TEST_F_${tag}`, A.admin.userId])));
  check("5b. Fingir «is_superadmin» en la base no permite crear documentos (RLS)", /^42501/.test(rtInsert), rtInsert);

  const body1b = body1 + "3. Cláusula añadida en el borrador (ficticia).\n";
  const ed = await call("PATCH", `${P_}/versions/${v1Id}`, central.token, { body: body1b });
  check("6. Central edita el borrador; la huella se recalcula", ed.status === 200 && ed.body.version.content_sha256 === sha256(body1b), ed.body.version?.content_sha256);

  const pub = await call("POST", `${P_}/versions/${v1Id}/publish`, central.token);
  check("7. Central publica la versión de prueba (hora del servidor)", pub.status === 200 && pub.body.version.status === "published" && Math.abs(Date.parse(pub.body.version.published_at) - Date.now()) < 60_000, pub.body.version?.status);
  const off1 = await call("POST", `${P_}/documents`, central.token, { code: `MSA_OFICIAL_${tag}`, title: "Acuerdo de servicio (borrador interno)", kind: "SERVICE_AGREEMENT", isTest: false });
  const offV = await call("POST", `${P_}/documents/${off1.body.document?.id}/versions`, central.token, { versionLabel: "1.0", body: "Borrador interno de un documento no marcado como prueba. No se publica en esta etapa." });
  const offPub = await call("POST", `${P_}/versions/${offV.body.version?.id}/publish`, central.token);
  check("7b. Contrato oficial NO publicable (422 CONTRACT_OFFICIAL_PUBLISHING_DISABLED; sigue en borrador)", offPub.status === 422 && offPub.body.error === "CONTRACT_OFFICIAL_PUBLISHING_DISABLED" && (await q(`SELECT status FROM contract_document_versions WHERE id=$1`, [offV.body.version?.id])).rows[0].status === "draft", offPub.status);

  const patchPub = await call("PATCH", `${P_}/versions/${v1Id}`, central.token, { body: body1b + "cambio" });
  const imm = [
    await errCode(q(`UPDATE contract_document_versions SET body=body||' cambio' WHERE id=$1`, [v1Id])),
    await errCode(q(`UPDATE contract_document_versions SET requires_new_acceptance=false WHERE id=$1`, [v1Id])),
    await errCode(q(`DELETE FROM contract_document_versions WHERE id=$1`, [v1Id])),
    await errCode(q(`TRUNCATE contract_document_versions CASCADE`)),
    await errCode(q(`UPDATE contract_documents SET title='[PRUEBA] otro' WHERE id=$1`, [docId])),
  ];
  check("8. Lo publicado es inalterable: Central no lo edita (409); ni el superusuario cambia texto, «exige nueva aceptación», ni borra o vacía", patchPub.status === 409 && imm.every((x) => x.includes("IMMUTABLE")), [patchPub.status, imm]);

  // ================================================================ ETAPA 2: ver y descargar antes de aceptar
  const listA = await call("GET", O(orgA), A.admin.token);
  const getA = await call("GET", `${O(orgA)}/versions/${v1Id}`, A.admin.token);
  const DECL = (await q<{ t: string }>(`SELECT public.app_contract_authority_declaration() t`)).rows[0].t;
  check("9. La administración ve la versión vigente «pending», con texto completo, versión, huella y declaración de autoridad", listA.body.contracts?.length === 1 && listA.body.contracts[0].acceptance === "pending" && listA.body.contracts[0].isNewVersion === false && getA.body.version?.body === body1b && getA.body.version?.version_label === "1.0" && getA.body.version?.authorityDeclaration === DECL, [listA.body.contracts?.[0]?.acceptance, getA.status]);
  const dPdf = await call("GET", `${O(orgA)}/versions/${v1Id}/document.pdf`, A.admin.token);
  const dTxt = await call("GET", `${O(orgA)}/versions/${v1Id}/document.txt`, A.admin.token);
  const dPdfText = dPdf.status === 200 ? pdfText(dPdf.raw) : "";
  check("9b. Descarga previa a la aceptación: PDF (título, versión, huella, aviso de prueba) y texto exacto cuya SHA-256 = la huella",
    dPdf.status === 200 && dPdf.raw.subarray(0, 4).toString() === "%PDF" && dPdf.headers.get("x-content-sha256") === sha256(body1b) && dPdfText.includes("DOCUMENTO FICTICIO DE PRUEBA") && dPdfText.includes(sha256(body1b)) && dPdfText.includes("Versión 1.0")
    && dTxt.status === 200 && sha256(dTxt.raw) === sha256(body1b) && /attachment/.test(dTxt.headers.get("content-disposition") ?? ""), [dPdf.status, dTxt.status]);
  const dlDenied = [await call("GET", `${O(orgA)}/versions/${v1Id}/document.pdf`, A.worker.token), await call("GET", `${O(orgA)}/versions/${v1Id}/document.txt`, A.family.token), await call("GET", `${O(orgA)}/versions/${v1Id}/document.pdf`, B.admin.token), await call("GET", `${O(orgA)}/versions/${v1Id}/document.pdf`, central.token)];
  check("9c. Cuidadores, familiares, otra agencia y Central no descargan por la ruta de la agencia (403)", dlDenied.every((r) => r.status === 403), dlDenied.map((r) => r.status));

  // ================================================================ ETAPA 2: código al correo
  const h1 = sha256(body1b);
  const codeDenied = [
    await call("POST", `${O(orgA)}/versions/${v1Id}/signature-code`, A.sup.token, { contentSha256: h1, ...SIGN }),
    await call("POST", `${O(orgA)}/versions/${v1Id}/signature-code`, A.worker.token, { contentSha256: h1, ...SIGN }),
    await call("POST", `${O(orgA)}/versions/${v1Id}/signature-code`, A.family.token, { contentSha256: h1, ...SIGN }),
    await call("POST", `${O(orgA)}/versions/${v1Id}/signature-code`, A.revoked.token, { contentSha256: h1, ...SIGN }),
    await call("POST", `${O(orgA)}/versions/${v1Id}/signature-code`, B.admin.token, { contentSha256: h1, ...SIGN }),
    await call("POST", `${O(orgA)}/versions/${v1Id}/signature-code`, central.token, { contentSha256: h1, ...SIGN }),
  ];
  check("10. Solo una administradora activa de la agencia pide el código: supervisión, cuidadores, familiares, membresía revocada, otra agencia y Central → 403", codeDenied.every((r) => r.status === 403) && mails.length === 0, codeDenied.map((r) => r.status));
  const formBad = [
    await call("POST", `${O(orgA)}/versions/${v1Id}/signature-code`, A.admin.token, { contentSha256: h1, ...SIGN, confirmAuthority: false }),
    await call("POST", `${O(orgA)}/versions/${v1Id}/signature-code`, A.admin.token, { contentSha256: h1, ...SIGN, confirm: undefined }),
    await call("POST", `${O(orgA)}/versions/${v1Id}/signature-code`, A.admin.token, { contentSha256: h1, ...SIGN, signerFullName: "Ana" }),
    await call("POST", `${O(orgA)}/versions/${v1Id}/signature-code`, A.admin.token, { contentSha256: h1, ...SIGN, signerTitle: " " }),
  ];
  const wrongText = await call("POST", `${O(orgA)}/versions/${v1Id}/signature-code`, A.admin.token, { contentSha256: sha256(body1), ...SIGN });
  check("10b. Casillas desmarcadas, un solo nombre o sin cargo → 400; huella de otro texto → 409; nada se envía", formBad.every((r) => r.status === 400) && wrongText.status === 409 && wrongText.body.error === "CONTRACT_CONTENT_MISMATCH" && mails.length === 0, [formBad.map((r) => r.status), wrongText.status]);

  const c1 = await call("POST", `${O(orgA)}/versions/${v1Id}/signature-code`, A.admin.token, { contentSha256: h1, ...SIGN });
  const mail1 = mails[mails.length - 1];
  const code1 = lastCode(A.admin.email);
  const ch1 = (await q(`SELECT * FROM contract_signature_challenges WHERE id=$1`, [c1.body.challengeId])).rows[0] ?? {};
  check("11. Código enviado al correo de la cuenta (no a uno elegido por la app): 6 dígitos, el asunto no lo muestra, la respuesta enmascara el correo",
    c1.status === 201 && mails.length === 1 && mail1.to === A.admin.email && /^\d{6}$/.test(code1 ?? "") && !mail1.subject.includes(code1 ?? "x") && c1.body.emailMasked !== A.admin.email && /^c•+@example\.invalid$/.test(c1.body.emailMasked) && ch1.email === A.admin.email && ch1.delivery_status === "sent", { status: c1.status, masked: c1.body.emailMasked });
  check("11b. En la base solo queda la huella del código (nunca el código)", ch1.code_hash && ch1.code_hash !== code1 && !JSON.stringify(ch1).includes(`"${code1}"`) && Math.abs(new Date(ch1.expires_at).getTime() - Date.now() - 10 * 60_000) < 60_000, ch1.code_hash?.length);
  const resend = await call("POST", `${O(orgA)}/versions/${v1Id}/signature-code`, A.admin.token, { contentSha256: h1, ...SIGN });
  check("11c. Reenvío antes de 60 s → 429 con Retry-After", resend.status === 429 && resend.body.error === "CONTRACT_CODE_RESEND_TOO_SOON" && Number(resend.headers.get("retry-after")) > 0, [resend.status, resend.headers.get("retry-after")]);

  const acc = (extra: Json, who = A.admin, ver = v1Id, h = h1) => call("POST", `${O(orgA)}/versions/${ver}/accept`, who.token, { contentSha256: h, ...SIGN, ...extra });
  const noCode = await acc({});
  const wrong = await acc({ challengeId: c1.body.challengeId, code: code1 === "000000" ? "111111" : "000000" });
  const attemptsAfter = (await q(`SELECT attempts FROM contract_signature_challenges WHERE id=$1`, [c1.body.challengeId])).rows[0].attempts;
  const otherUser = await acc({ challengeId: c1.body.challengeId, code: code1 }, A.admin2);
  const audFail = (await q(`SELECT count(*)::int n FROM audit_log WHERE action='CONTRACT_SIGNATURE_CODE_FAILED' AND entity_id=$1`, [c1.body.challengeId])).rows[0].n;
  check("12. Sin código → 400; código equivocado → 422 (quedan 4 intentos, el intento queda guardado y auditado); el código de otra persona no sirve", noCode.status === 400 && wrong.status === 422 && wrong.body.error === "CONTRACT_CODE_INVALID" && wrong.body.attemptsLeft === 4 && attemptsAfter === 1 && audFail === 1 && otherUser.status === 422 && otherUser.body.error === "CONTRACT_CODE_INVALID", [noCode.status, wrong.status, wrong.body.attemptsLeft, attemptsAfter, otherUser.status]);

  // Firma válida y evidencia
  const t0 = Date.now();
  const ok1 = await acc({ challengeId: c1.body.challengeId, code: code1 });
  const ev = ok1.body.acceptance ?? {};
  const evRow = (await q(`SELECT * FROM organization_contract_acceptances WHERE id=$1`, [ev.id])).rows[0] ?? {};
  check("13. Firma con el código: 201 y evidencia con versión, huella, agencia, cuenta, rol, hora del servidor, representante, declaración y verificación EMAIL_CODE al correo de la cuenta",
    ok1.status === 201 && evRow.document_version_id === v1Id && evRow.content_sha256 === h1 && evRow.organization_id === orgA && evRow.accepted_by_user_id === A.admin.userId
    && evRow.accepted_by_login === A.admin.email && evRow.accepted_role === "ORGANIZATION_ADMIN" && Math.abs(new Date(evRow.accepted_at).getTime() - t0) < 60_000
    && evRow.signer_full_name === "Ana Ficticia Prueba" && evRow.signer_title === "Presidenta (ficticia)" && evRow.authority_declaration === DECL
    && evRow.verification_method === "EMAIL_CODE" && evRow.verified_email === A.admin.email && evRow.verification_challenge_id === c1.body.challengeId
    && String(evRow.acceptance_statement).startsWith("Yo, Ana Ficticia Prueba, Presidenta (ficticia) de «Agencia Ficticia A") && ev.verified_email !== A.admin.email, { status: ok1.status, err: ok1.body.error });
  const replay = await acc({ challengeId: c1.body.challengeId, code: code1 });
  check("13b. El mismo código no se reutiliza y la versión no se acepta dos veces (409)", replay.status === 409 && ["CONTRACT_ALREADY_ACCEPTED", "CONTRACT_CODE_ALREADY_USED"].includes(replay.body.error), replay.body);
  check("13c. Auditoría de la solicitud del código y de la aceptación", (await q(`SELECT count(*)::int n FROM audit_log WHERE action IN ('CONTRACT_SIGNATURE_CODE_REQUESTED','CONTRACT_VERSION_ACCEPTED') AND organization_id=$1 AND actor_user_id=$2`, [orgA, A.admin.userId])).rows[0].n === 2);

  // Constancia
  const cert = await call("GET", `${O(orgA)}/acceptances/${ev.id}/certificate.pdf`, A.admin.token);
  const certText = cert.status === 200 ? pdfText(cert.raw) : "";
  if (process.env.CONTRACTS_DEBUG_PDF) console.log(certText);
  check("14. Constancia PDF: organización, documento, versión, huella, representante y cargo, cuenta que firmó, verificación por código, fecha y declaraciones",
    cert.status === 200 && certText.includes("Constancia de aceptación electrónica") && certText.includes(`Agencia Ficticia A ${tag}`) && certText.includes(h1) && certText.includes("Ana Ficticia Prueba, Presidenta (ficticia)")
    && certText.includes("código de un solo uso") && certText.includes(A.admin.email) && certText.includes("hora de Puerto Rico") && certText.includes("CONSTANCIA DE PRUEBA") && certText.includes(DECL.slice(0, 40)), cert.status);
  const certDenied = [await call("GET", `${O(orgA)}/acceptances/${ev.id}/certificate.pdf`, A.worker.token), await call("GET", `${O(orgB)}/acceptances/${ev.id}/certificate.pdf`, B.admin.token), await call("GET", `${O(orgA)}/acceptances/${ev.id}/certificate.pdf`, B.admin.token)];
  check("14b. La constancia solo la descarga la administración de la agencia: cuidador 403, otra agencia por su ruta 404 y por la de A 403", certDenied[0].status === 403 && certDenied[1].status === 404 && certDenied[2].status === 403, certDenied.map((r) => r.status));

  // Evidencia y códigos inalterables
  const evImm = [
    await errCode(q(`UPDATE organization_contract_acceptances SET accepted_at='2020-01-01' WHERE id=$1`, [ev.id])),
    await errCode(q(`DELETE FROM organization_contract_acceptances WHERE id=$1`, [ev.id])),
    await errCode(q(`TRUNCATE organization_contract_acceptances`)),
    await errCode(q(`UPDATE contract_signature_challenges SET consumed_at=NULL WHERE id=$1`, [c1.body.challengeId])),
    await errCode(q(`UPDATE contract_signature_challenges SET email='otra@example.invalid' WHERE id=$1`, [c1.body.challengeId])),
    await errCode(q(`DELETE FROM contract_signature_challenges WHERE id=$1`, [c1.body.challengeId])),
  ];
  const rtUpd = await errCode(asRuntime(A.admin.userId, orgA, false, () => rt.query(`UPDATE organization_contract_acceptances SET user_agent='x' WHERE id=$1`, [ev.id])));
  check("15. Aceptaciones anteriores y códigos usados no se modifican ni borran (superusuario: trigger; app: sin permiso)", evImm.every((x) => x.includes("IMMUTABLE")) && /^42501/.test(rtUpd), [evImm, rtUpd]);

  // Instantáneas y verificación no falsificables
  const fakeSnap = await errCode(asRuntime(A.admin2.userId, orgA, false, () => rt.query(`INSERT INTO organization_contract_acceptances (organization_id,document_version_id,content_sha256,accepted_by_user_id,signer_full_name,signer_title,acceptance_statement,verification_challenge_id,verified_email,verification_method) VALUES ($1,$2,$3,$4,'Nombre Ficticio','Cargo ficticio','Declaración ficticia de prueba',$5,'otra@x','EMAIL_CODE')`, [orgA, v1Id, h1, A.admin2.userId, randomUUID()])));
  const noChallenge = await errCode(q(`INSERT INTO organization_contract_acceptances (organization_id,document_version_id,content_sha256,accepted_by_user_id,signer_full_name,signer_title,acceptance_statement,verification_challenge_id) VALUES ($1,$2,$3,$4,'Nombre Ficticio','Cargo ficticio','Declaración ficticia de prueba',$5)`, [orgB, v1Id, h1, B.admin.userId, randomUUID()]));
  const unconsumed = randomUUID();
  await q(`INSERT INTO contract_signature_challenges (id,organization_id,document_version_id,user_id,code_hash) VALUES ($1,$2,$3,$4,repeat('e',64))`, [unconsumed, orgB, v1Id, B.admin.userId]);
  await q(`UPDATE contract_signature_challenges SET delivery_status='sent' WHERE id=$1`, [unconsumed]);
  const notConsumed = await errCode(q(`INSERT INTO organization_contract_acceptances (organization_id,document_version_id,content_sha256,accepted_by_user_id,signer_full_name,signer_title,acceptance_statement,verification_challenge_id) VALUES ($1,$2,$3,$4,'Nombre Ficticio','Cargo ficticio','Declaración ficticia de prueba',$5)`, [orgB, v1Id, h1, B.admin.userId, unconsumed]));
  const otherOwner = await errCode(q(`INSERT INTO organization_contract_acceptances (organization_id,document_version_id,content_sha256,accepted_by_user_id,signer_full_name,signer_title,acceptance_statement,verification_challenge_id) VALUES ($1,$2,$3,$4,'Nombre Ficticio','Cargo ficticio','Declaración ficticia de prueba',$5)`, [orgA, v1Id, h1, A.admin2.userId, c1.body.challengeId]));
  check("16. Sin un código consumido de esa misma persona, agencia y versión no hay evidencia (ni por mantenimiento): la app no escribe verificación ni instantáneas (42501)",
    /^42501/.test(fakeSnap) && noChallenge.includes("CONTRACT_IDENTITY_NOT_VERIFIED") && notConsumed.includes("CONTRACT_IDENTITY_NOT_VERIFIED") && otherOwner.includes("CONTRACT_IDENTITY_NOT_VERIFIED"), [fakeSnap, noChallenge, notConsumed, otherOwner]);
  const suForge = await errCode((async () => {
    await q("BEGIN");
    try {
      const chal = await suChallenge(orgB, v1Id, B.admin.userId);
      const r = await q(`INSERT INTO organization_contract_acceptances (organization_id,document_version_id,content_sha256,accepted_by_user_id,signer_full_name,signer_title,acceptance_statement,organization_name,accepted_by_login,accepted_role,accepted_at,is_test,authority_declaration,verification_challenge_id,verified_email,verification_method) VALUES ($1,$2,$3,$4,'Nombre Ficticio','Cargo ficticio','Declaración ficticia de prueba','Otra agencia','otra@persona','ORGANIZATION_ADMIN','2020-01-01',false,'Declaración alterada',$5,'otra@persona','EMAIL_CODE') RETURNING organization_name, accepted_by_login, accepted_at, is_test, authority_declaration, verified_email`, [orgB, v1Id, h1, B.admin.userId, chal]);
      const x = r.rows[0];
      if (x.organization_name !== `Agencia Ficticia B ${tag}` || x.accepted_by_login !== B.admin.email || new Date(x.accepted_at).getFullYear() < 2026 || x.is_test !== true || x.authority_declaration !== DECL || x.verified_email !== B.admin.email) throw Object.assign(new Error("SNAPSHOT_NOT_FORCED"), { code: "X" });
      throw Object.assign(new Error("forced-ok"), { code: "OK" });
    } finally { await q("ROLLBACK"); }
  })());
  const oneWord = await errCode((async () => { await q("BEGIN"); try { const chal = await suChallenge(orgB, v1Id, B.admin.userId); await q(`INSERT INTO organization_contract_acceptances (organization_id,document_version_id,content_sha256,accepted_by_user_id,signer_full_name,signer_title,acceptance_statement,verification_challenge_id) VALUES ($1,$2,$3,$4,'Ana','Presidenta','Declaración ficticia de prueba',$5)`, [orgB, v1Id, h1, B.admin.userId, chal]); } finally { await q("ROLLBACK"); } })());
  const nonAdmin = await errCode(q(`INSERT INTO contract_signature_challenges (id,organization_id,document_version_id,user_id,code_hash) VALUES ($1,$2,$3,$4,repeat('d',64))`, [randomUUID(), orgA, v1Id, A.worker.userId]));
  check("16b. Incluso por mantenimiento la base fija agencia, cuenta, hora, prueba, declaración y correo verificado; exige nombre y apellido (23514) y no crea códigos para quien no es administradora",
    suForge === "OK:forced-ok" && /^23514/.test(oneWord) && nonAdmin.includes("CONTRACT_ACCEPTANCE_ADMIN_REQUIRED"), [suForge, oneWord, nonAdmin]);
  const centralCode = await errCode(asRuntime(central.userId, orgA, true, () => rt.query(`INSERT INTO contract_signature_challenges (id,organization_id,document_version_id,user_id,code_hash) VALUES ($1,$2,$3,$4,repeat('c',64))`, [randomUUID(), orgA, v1Id, A.admin.userId])));
  const centralSees = await asRuntime(central.userId, "", true, async () => (await rt.query(`SELECT count(*)::int n FROM contract_signature_challenges`)).rows[0].n);
  check("16c. Central no crea códigos a nombre de una administradora ni ve los códigos (RLS)", /^42501/.test(centralCode) && centralSees === 0, [centralCode, centralSees]);

  // ================================================================ Aislamiento
  const bList = await call("GET", `${O(orgB)}/acceptances`, B.admin.token);
  const bOnA = [await call("GET", `${O(orgA)}/acceptances`, B.admin.token), await call("GET", O(orgA), B.admin.token)];
  const bDb = await asRuntime(B.admin.userId, orgB, false, async () => ({
    acc: (await rt.query(`SELECT count(*)::int n FROM organization_contract_acceptances`)).rows[0].n,
    chal: (await rt.query(`SELECT count(*)::int n FROM contract_signature_challenges`)).rows[0].n,
  }));
  const bOwnChal = (await q(`SELECT count(*)::int n FROM contract_signature_challenges WHERE user_id=$1`, [B.admin.userId])).rows[0].n;
  const allChal = (await q(`SELECT count(*)::int n FROM contract_signature_challenges`)).rows[0].n;
  check("17. B ve solo lo suyo (0 aceptaciones; solo sus propios códigos, ninguno de A) y no consulta A (403)", bList.body.acceptances?.length === 0 && bOnA.every((r) => r.status === 403) && bDb.acc === 0 && bDb.chal === bOwnChal && allChal > bOwnChal, [bList.body.acceptances?.length, bOnA.map((r) => r.status), bDb, bOwnChal, allChal]);

  // ================================================================ Central: consulta
  const ovw = await call("GET", `${P_}/overview`, central.token);
  const oA = ovw.body.organizations?.find((o: Json) => o.organizationId === orgA), oB = ovw.body.organizations?.find((o: Json) => o.organizationId === orgB);
  check("18. Central: A «accepted» con versión 1.0, fecha y representante; B «pending»", ovw.status === 200 && oA?.contracts[0]?.state === "accepted" && oA.contracts[0].accepted?.versionLabel === "1.0" && oA.contracts[0].accepted?.signerFullName === "Ana Ficticia Prueba" && oA.contracts[0].accepted?.signerTitle === "Presidenta (ficticia)" && !!oA.contracts[0].accepted?.acceptedAt && oB?.contracts[0]?.state === "pending", [oA?.contracts?.[0]?.state, oB?.contracts?.[0]?.state]);
  const cAcc = await call("GET", `${P_}/versions/${v1Id}/acceptances`, central.token);
  const cKeys = Object.keys(cAcc.body.acceptances?.[0] ?? {}).sort().join(",");
  check("18b. A Central solo le llegan metadatos (sin IP, navegador ni correo verificado)", cKeys === "accepted_at,accepted_by_login,accepted_role,content_sha256,is_test,organization_id,organization_name,signer_full_name,signer_title,verification_method", cKeys);

  // ================================================================ Versiones
  const body2 = `${BANNER}\n\n1. Objeto (ficticio), versión 2 con cambios sustanciales.\n2. Duración (ficticia). Sesenta días.\n`;
  const v2 = await call("POST", `${P_}/documents/${docId}/versions`, central.token, { versionLabel: "2.0", body: body2 });
  const v2Id = v2.body.version?.id, h2 = sha256(body2);
  await call("POST", `${P_}/versions/${v2Id}/publish`, central.token);
  const listA2 = await call("GET", O(orgA), A.admin.token);
  const row2 = listA2.body.contracts?.[0] ?? {};
  check("19. Versión nueva que exige aceptación: A la ve «pending» como versión nueva, con su aceptación anterior (1.0) a la vista", row2.id === v2Id && row2.acceptance === "pending" && row2.isNewVersion === true && row2.previousAcceptance?.versionLabel === "1.0", row2);
  const oldAcc = await call("POST", `${O(orgA)}/versions/${v1Id}/signature-code`, A.admin2.token, { contentSha256: h1, ...SIGN });
  check("19b. La versión retirada ya no se firma (409 CONTRACT_VERSION_NOT_ACCEPTABLE) y su evidencia sigue intacta", oldAcc.status === 409 && oldAcc.body.error === "CONTRACT_VERSION_NOT_ACCEPTABLE" && (await q(`SELECT count(*)::int n FROM organization_contract_acceptances WHERE id=$1 AND content_sha256=$2`, [ev.id, h1])).rows[0].n === 1, oldAcc.body);

  // Código vencido, demasiados intentos, entrega fallida
  const cE = await call("POST", `${O(orgA)}/versions/${v2Id}/signature-code`, A.admin2.token, { contentSha256: h2, ...SIGN });
  const codeE = lastCode(A.admin2.email);
  await q(`SET session_replication_role = replica`); // solo esta prueba: envejecer el código sin pasar por el trigger
  await q(`UPDATE contract_signature_challenges SET expires_at = now() - interval '1 minute', created_at = now() - interval '11 minutes' WHERE id=$1`, [cE.body.challengeId]);
  await q(`SET session_replication_role = origin`);
  const expired = await acc({ challengeId: cE.body.challengeId, code: codeE }, A.admin2, v2Id, h2);
  check("20. Código vencido (10 min) → 409 CONTRACT_CODE_EXPIRED", expired.status === 409 && expired.body.error === "CONTRACT_CODE_EXPIRED", expired.body);
  const cT = await call("POST", `${O(orgA)}/versions/${v2Id}/signature-code`, A.admin2.token, { contentSha256: h2, ...SIGN });
  const codeT = lastCode(A.admin2.email);
  const bad5: number[] = [];
  for (let i = 0; i < 5; i++) bad5.push((await acc({ challengeId: cT.body.challengeId, code: codeT === "123456" ? "654321" : "123456" }, A.admin2, v2Id, h2)).status);
  const after5 = await acc({ challengeId: cT.body.challengeId, code: codeT }, A.admin2, v2Id, h2);
  check("20b. Tras 5 códigos equivocados, ni el correcto sirve (409 CONTRACT_CODE_TOO_MANY_ATTEMPTS)", cE.status === 201 && cT.status === 201 && bad5.every((s) => s === 422) && after5.status === 409 && after5.body.error === "CONTRACT_CODE_TOO_MANY_ATTEMPTS", [cE.status, cT.status, bad5, after5.body]);
  mailMode = "fail";
  const cF = await call("POST", `${O(orgA)}/versions/${v2Id}/signature-code`, A.midRevoke.token, { contentSha256: h2, ...SIGN });
  mailMode = "ok";
  const fRow = (await q(`SELECT delivery_status FROM contract_signature_challenges WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [A.midRevoke.userId])).rows[0];
  check("20c. Si el correo no sale: 503 CONTRACT_CODE_DELIVERY_FAILED y ese código queda inservible", cF.status === 503 && cF.body.error === "CONTRACT_CODE_DELIVERY_FAILED" && fRow?.delivery_status === "failed", [cF.status, fRow?.delivery_status]);
  const prevKey = process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY;
  const cN = await call("POST", `${O(orgA)}/versions/${v2Id}/signature-code`, A.midDemote.token, { contentSha256: h2, ...SIGN });
  process.env.RESEND_API_KEY = prevKey;
  check("20d. Sin proveedor de correo configurado no se firma (503), nunca se omite la verificación", cN.status === 503, cN.status);

  // Sesiones abiertas que pierden el permiso a mitad del flujo
  await q(`SET session_replication_role = replica`);
  await q(`UPDATE contract_signature_challenges SET created_at = created_at - interval '2 minutes' WHERE user_id = ANY($1)`, [[A.midRevoke.userId, A.midDemote.userId]]);
  await q(`SET session_replication_role = origin`);
  const mR = await call("POST", `${O(orgA)}/versions/${v2Id}/signature-code`, A.midRevoke.token, { contentSha256: h2, ...SIGN });
  const mD = await call("POST", `${O(orgA)}/versions/${v2Id}/signature-code`, A.midDemote.token, { contentSha256: h2, ...SIGN });
  await q(`UPDATE organization_memberships SET status='revoked' WHERE id=$1`, [A.midRevoke.membership]);
  await q(`DELETE FROM user_roles WHERE organization_membership_id=$1`, [A.midDemote.membership]);
  await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='WORKER'`, [A.midDemote.membership, orgA]);
  const mR2 = await acc({ challengeId: mR.body.challengeId, code: lastCode(A.midRevoke.email) }, A.midRevoke, v2Id, h2);
  const mD2 = await acc({ challengeId: mD.body.challengeId, code: lastCode(A.midDemote.email) }, A.midDemote, v2Id, h2);
  check("21. Sesión abierta: con el código ya recibido, si pierde la membresía o el rol de administradora antes de firmar → 403 y sin evidencia", mR.status === 201 && mD.status === 201 && mR2.status === 403 && mD2.status === 403 && (await q(`SELECT count(*)::int n FROM organization_contract_acceptances WHERE accepted_by_user_id = ANY($1)`, [[A.midRevoke.userId, A.midDemote.userId]])).rows[0].n === 0, [mR.status, mD.status, mR2.status, mD2.status]);

  // Concurrencia: el mismo código correcto enviado dos veces a la vez
  const cC = await call("POST", `${O(orgA)}/versions/${v2Id}/signature-code`, A.admin.token, { contentSha256: h2, ...SIGN });
  const codeC = lastCode(A.admin.email);
  const race = await Promise.all([acc({ challengeId: cC.body.challengeId, code: codeC }, A.admin, v2Id, h2), acc({ challengeId: cC.body.challengeId, code: codeC }, A.admin, v2Id, h2)]);
  const raceRows = (await q(`SELECT count(*)::int n FROM organization_contract_acceptances WHERE organization_id=$1 AND document_version_id=$2`, [orgA, v2Id])).rows[0].n;
  check("22. El mismo código enviado dos veces a la vez: una firma (201), la otra 409, una sola evidencia", race.map((r) => r.status).sort().join(",") === "201,409" && raceRows === 1, race.map((r) => [r.status, r.body.error]));

  // Versión que NO exige nueva aceptación
  const body3 = `${BANNER}\n\n1. Objeto (ficticio), versión 2.1: solo corrección de erratas.\n2. Duración (ficticia). Sesenta días.\n`;
  const v3 = await call("POST", `${P_}/documents/${docId}/versions`, central.token, { versionLabel: "2.1", body: body3, requiresNewAcceptance: false });
  await call("POST", `${P_}/versions/${v3.body.version?.id}/publish`, central.token);
  const listA3 = await call("GET", O(orgA), A.admin.token), listB3 = await call("GET", O(orgB), B.admin.token);
  const ovw3 = await call("GET", `${P_}/overview`, central.token);
  const oA3 = ovw3.body.organizations?.find((o: Json) => o.organizationId === orgA)?.contracts[0], oB3 = ovw3.body.organizations?.find((o: Json) => o.organizationId === orgB)?.contracts[0];
  check("23. Versión que no exige nueva aceptación (2.1): A queda «covered» por 2.0; B, que nunca aceptó, «pending»; Central lo refleja",
    v3.body.version?.requires_new_acceptance === false && listA3.body.contracts?.[0]?.acceptance === "covered" && listB3.body.contracts?.[0]?.acceptance === "pending" && oA3?.state === "covered" && oA3?.accepted?.versionLabel === "2.0" && oB3?.state === "pending", [listA3.body.contracts?.[0]?.acceptance, listB3.body.contracts?.[0]?.acceptance, oA3?.state, oB3?.state]);
  const histA = await call("GET", `${O(orgA)}/acceptances`, A.admin.token);
  check("23b. Historial de A: conserva todas sus aceptaciones (1.0 y 2.0, ambas retiradas) con representante y método de verificación", histA.body.acceptances?.length === 2 && histA.body.acceptances.every((a: Json) => a.version_status === "retired" && a.verification_method === "EMAIL_CODE" && a.signer_full_name), histA.body.acceptances?.map((a: Json) => a.version_label));
  const bSign = await sign(B.admin, orgB, v3.body.version?.id, sha256(body3));
  check("23c. B firma la 2.1 con su propio código (flujo completo de punta a punta)", bSign.req.status === 201 && bSign.acc?.status === 201, [bSign.req.status, bSign.acc?.status]);

  // Retiro y sin bloqueos
  const cur = (await q(`SELECT id FROM contract_document_versions WHERE document_id=$1 AND status='published'`, [docId])).rows[0].id;
  const ret = await call("POST", `${P_}/versions/${cur}/retire`, central.token);
  const repub = await call("POST", `${P_}/versions/${cur}/publish`, central.token);
  const listA4 = await call("GET", O(orgA), A.admin.token);
  check("24. Central retira la versión vigente; no se vuelve a publicar (409); la agencia no tiene pendientes (sin bloqueos)", ret.status === 200 && repub.status === 409 && listA4.body.contracts?.length === 0, [ret.status, repub.status]);

  // Integridad global y auditoría
  const allV = (await q(`SELECT body, content_sha256 FROM contract_document_versions`)).rows;
  const allA = (await q(`SELECT a.content_sha256 a, v.content_sha256 v, c.consumed_at, c.user_id = a.accepted_by_user_id same FROM organization_contract_acceptances a JOIN contract_document_versions v ON v.id=a.document_version_id JOIN contract_signature_challenges c ON c.id=a.verification_challenge_id`)).rows;
  check("25. Integridad: toda huella = SHA-256 de su texto; toda evidencia = huella de su versión y está ligada a un código consumido de la misma persona", allV.every((r) => r.content_sha256 === sha256(r.body)) && allA.length > 0 && allA.every((r) => r.a === r.v && r.consumed_at && r.same), [allV.length, allA.length]);
  const actions = (await q(`SELECT action FROM audit_log WHERE action LIKE 'CONTRACT\\_%' GROUP BY 1`)).rows.map((r) => r.action);
  const need = ["CONTRACT_DOCUMENT_CREATED", "CONTRACT_VERSION_DRAFTED", "CONTRACT_VERSION_DRAFT_EDITED", "CONTRACT_VERSION_PUBLISHED", "CONTRACT_VERSION_RETIRED", "CONTRACT_SIGNATURE_CODE_REQUESTED", "CONTRACT_SIGNATURE_CODE_FAILED", "CONTRACT_VERSION_ACCEPTED"];
  check("25b. Auditoría de cada paso (crear, borrador, edición, publicación, retiro, código pedido y fallido, aceptación)", need.every((a) => actions.includes(a)), actions);
  check("25c. Ningún correo salió a otra dirección que la de la cuenta de quien firma (todos simulados en el proceso)", mails.length > 0 && mails.every((m) => [...Object.values(A), ...Object.values(B)].some((p) => p.email === m.to)), mails.length);

  // ================================================================ Reversión y evidencia oficial
  const ROLLBACK_SQL = readFileSync(new URL("../ops/152_contract_documents.rollback.sql", import.meta.url), "utf8");
  const counts = async () => (await q(`SELECT (SELECT count(*) FROM contract_documents)::int d, (SELECT count(*) FROM contract_document_versions)::int v, (SELECT count(*) FROM organization_contract_acceptances)::int a, (SELECT count(*) FROM contract_signature_challenges)::int c`)).rows[0];
  const before26 = await counts();
  const dry = await errCode(q(ROLLBACK_SQL.replace(/COMMIT;\s*$/, "ROLLBACK;")));
  await q("ROLLBACK").catch(() => undefined);
  const has153 = (await q(`SELECT 1 FROM schema_migrations WHERE filename='153_contract_saas_v1.sql'`)).rowCount === 1;
  check(has153 ? "26. Con 153 aplicada, la reversión de 152 se detiene y pide revertir 153 primero (datos intactos)" : "26. Con evidencia solo de prueba, la reversión ordinaria se ejecuta (ensayo deshecho; datos intactos)",
    (has153 ? dry.includes("CONTRACT_ROLLBACK_REVERT_153_FIRST") : dry === "ok") && JSON.stringify(await counts()) === JSON.stringify(before26), dry);
  const offDoc = (await q<{ id: string }>(`INSERT INTO contract_documents (code,title,kind,is_test,created_by_user_id) VALUES ($1,'Documento ficticio no marcado (prueba de reversión)','OTHER',false,$2) RETURNING id`, [`FICTICIO_REVERSION_${tag}`, central.userId])).rows[0].id;
  const offVer = (await q<{ id: string }>(`INSERT INTO contract_document_versions (document_id,version_label,body,content_sha256,is_test,created_by_user_id) VALUES ($1,'1.0','Texto ficticio sin valor legal, usado solo para comprobar que la reversión se niega.',repeat('0',64),false,$2) RETURNING id`, [offDoc, central.userId])).rows[0].id;
  // Con 153 aplicada, un documento oficial solo se publica con aprobación jurídica registrada (aquí ficticia).
  if ((await q(`SELECT 1 FROM information_schema.columns WHERE table_name='contract_document_versions' AND column_name='legal_status'`)).rowCount) {
    await q(`UPDATE contract_document_versions SET legal_status='legally_approved', legal_approved_by_user_id=$2, legal_approval_reference='Referencia ficticia de prueba' WHERE id=$1`, [offVer, central.userId]);
    // …y solo firma la representante designada por la agencia (ficticia).
    await q(`INSERT INTO organization_contract_signatories (organization_id,user_id,full_name,title,basis,designated_by_user_id) VALUES ($1,$2,'Nombre Ficticio Representante','Cargo ficticio','Designación ficticia de prueba de reversión',$3)`, [orgB, B.admin.userId, central.userId]);
  }
  await q(`UPDATE contract_document_versions SET status='published', published_by_user_id=$2 WHERE id=$1`, [offVer, central.userId]);
  const offHash = (await q(`SELECT content_sha256 FROM contract_document_versions WHERE id=$1`, [offVer])).rows[0].content_sha256;
  const offChal = await suChallenge(orgB, offVer, B.admin.userId);
  await q(`INSERT INTO organization_contract_acceptances (organization_id,document_version_id,content_sha256,accepted_by_user_id,signer_full_name,signer_title,acceptance_statement,verification_challenge_id) VALUES ($1,$2,$3,$4,'Nombre Ficticio','Cargo ficticio','Declaración ficticia de prueba de reversión',$5)`, [orgB, offVer, offHash, B.admin.userId, offChal]);
  const before26b = await counts();
  const refused = await errCode(q(ROLLBACK_SQL));
  await q("ROLLBACK").catch(() => undefined);
  check("26b. Con evidencia oficial, la reversión ordinaria se NIEGA y no borra nada", refused.includes("CONTRACT_ROLLBACK_REFUSED_OFFICIAL_EVIDENCE") && JSON.stringify(await counts()) === JSON.stringify(before26b) && (await q(`SELECT count(*)::int n FROM schema_migrations WHERE filename='152_contract_documents.sql'`)).rows[0].n === 1, refused);

  // ---------------------------------------------------------------- resultado
  server.close(); await pool.end(); await rt.end(); await db.end(); rmSync(pdfDir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` | ${r.detail}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error("VERIFY_ERROR", e); process.exit(1); });
