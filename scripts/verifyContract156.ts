/**
 * Contrato Oficial v1.1 — integración (156). 21-nov-2026. Datos FICTICIOS, base PROPIA desechable,
 * ningún correo real (Resend interceptado). App real por HTTP como app_runtime.
 * Las 16 pruebas de la Fase 7 de la misión, más las de 156: Word original inmutable y descargable,
 * aprobación jurídica con datos completos ligada a las huellas del texto y del Word, publicación
 * bloqueada sin ella, términos por función solo con líneas íntegras del contrato, aceptación
 * individual por función, historial sin sobrescritura, reglas de acceso y facturación apagadas,
 * y reversión que se niega con evidencia oficial.
 *
 * Opcional, solo local (los archivos NO están en el repositorio): OFFICIAL_TXT_PATH y OFFICIAL_DOCX_PATH
 * con el texto y el Word del Contrato Oficial v1.1 → comprueba huellas, reproducción íntegra (texto,
 * PDF y Word), aprobación verificada y términos tomados del Anexo E, siempre en la base desechable.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";
import { pdfToText } from "./lib/pdfText.js";

const serverUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!serverUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(serverUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const errCode = (p: Promise<unknown>) => p.then(() => "ok", (e) => `${(e as { code?: string }).code ?? "?"}:${(e as Error).message}`);
const fakeDocx = (n = 4096) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(n)]);

const mails: Array<{ to: string; html: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) {
    const b = JSON.parse(String(init?.body ?? "{}"));
    mails.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, html: String(b.html ?? "") });
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (!/^https?:\/\/127\.0\.0\.1:/.test(url)) throw new Error(`Salida de red bloqueada en la prueba: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";

async function main() {
  const own = `etnara_c156_${randomBytes(4).toString("hex")}`;
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  await srv.query(`CREATE DATABASE ${own}`);
  const ownUrl = new URL(serverUrl!); ownUrl.pathname = `/${own}`; const adminUrl = ownUrl.toString();
  { const m = new pg.Client({ connectionString: adminUrl }); await m.connect(); const log = console.log; console.log = () => undefined;
    try { await applyPendingMigrations(m, join(process.cwd(), "migrations")); } finally { console.log = log; await m.end(); } }
  const db = new pg.Client({ connectionString: adminUrl }); await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  process.env.CONTRACTS_MODULE = "on";
  delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
  delete process.env.CONTRACTS_ENFORCEMENT;
  process.env.CONTRACTS_TEST_SIGNING = "on"; // solo en esta base desechable

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toUpperCase();
  async function call(method: string, path: string, token: string, body?: Json | Buffer, headers: Record<string, string> = {}) {
    const isBuf = Buffer.isBuffer(body);
    const res = await realFetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": isBuf ? "application/octet-stream" : "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : isBuf ? new Uint8Array(body) : JSON.stringify(body) });
    const raw = Buffer.from(await res.arrayBuffer());
    let json: Json = {}; try { json = JSON.parse(raw.toString("utf8")); } catch { /* binario */ }
    return { status: res.status, body: json, raw, headers: res.headers };
  }

  // ---------------------------------------------------------------- agencias y personas ficticias
  const org = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgN = await org(`Agencia Nueva Ficticia ${tag}`), orgE = await org(`Agencia Existente Ficticia ${tag}`), orgX = await org(`Agencia Otra Ficticia ${tag}`);
  type P = { email: string; userId: string; token: string; membership: string; orgId: string };
  async function person(key: string, orgId: string, roles: string[]): Promise<P> {
    const email = `c156-${key}-${tag.toLowerCase()}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const membership = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [membership, orgId, roles]);
    return { email, userId, token: "", membership, orgId };
  }
  const N = { rep: await person("n-rep", orgN, ["ORGANIZATION_ADMIN"]), tech: await person("n-tecnico", orgN, ["ORGANIZATION_ADMIN"]), worker: await person("n-cuidador", orgN, ["WORKER"]), family: await person("n-familia", orgN, ["FAMILY"]), sup: await person("n-sup", orgN, ["SUPERVISOR"]) };
  const E = { rep: await person("e-rep", orgE, ["ORGANIZATION_ADMIN"]), worker: await person("e-cuidador", orgE, ["WORKER"]) };
  const X = { rep: await person("x-rep", orgX, ["ORGANIZATION_ADMIN"]) };
  const central = await person("central", orgX, []);
  await q(`DELETE FROM organization_memberships WHERE id=$1`, [central.membership]);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.userId]);
  // Agencia existente con un turno en curso asignado (caso 14).
  const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,'Cuidador Ficticio') RETURNING id`, [E.worker.userId])).rows[0].id;
  const owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [workerId, orgE])).rows[0].id;
  const recipient = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status) VALUES ($1,'Residente','Ficticia','active') RETURNING id`, [orgE])).rows[0].id;
  const shift = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '10 minutes',now()+interval '4 hours','confirmed') RETURNING id`, [orgE, recipient])).rows[0].id;
  await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,response_status,responded_at) VALUES ($1,$2,$3,'accepted',now())`, [orgE, shift, owm]);
  for (const p of [...Object.values(N), ...Object.values(E), ...Object.values(X), central]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${p.email} ${r.status}`);
    p.token = r.body.token;
    if (p !== central) await call("POST", "/me/active-organization", p.token, { organizationId: p.orgId });
  }
  const P_ = "/platform/contracts", O = (o: string) => `/organizations/${o}/contracts`, T = (o: string) => `/organizations/${o}/role-terms`;
  const lastCode = (email: string) => [...mails].reverse().find((m) => m.to === email)?.html.match(/>(\d{6})</)?.[1] ?? null;
  const SIGN = { signerFullName: "Ana Ficticia Representante", signerTitle: "Presidenta (ficticia)", confirmAuthority: true, confirm: true };
  async function sign(p: P, o: string, versionId: string, h: string, signer: Json = SIGN, code?: string) {
    const req = await call("POST", `${O(o)}/versions/${versionId}/signature-code`, p.token, { contentSha256: h, ...signer });
    if (req.status !== 201) return { req, acc: null as null | Awaited<ReturnType<typeof call>> };
    const acc = await call("POST", `${O(o)}/versions/${versionId}/accept`, p.token, { contentSha256: h, ...signer, challengeId: req.body.challengeId, code: code ?? lastCode(p.email) });
    return { req, acc };
  }
  const designate = (o: string, p: P) => call("POST", `${P_}/organizations/${o}/signatories`, central.token, { userId: p.userId, fullName: "Ana Ficticia Representante", title: "Presidenta (ficticia)", basis: "Resolución corporativa ficticia de prueba" });

  // Texto oficial de ENSAYO (no marcado como prueba, sin valor legal; nunca sale de esta base).
  const ANNEX = ["ANEXO E — TÉRMINOS INDIVIDUALES POR FUNCIÓN",
    "E.1. Cláusula de ensayo uno sobre la entrega de términos antes del primer uso.",
    "E.2. Cláusula de ensayo para la administración.", "E.3. Cláusula de ensayo para cuidadores.", "E.4. Cláusula de ensayo para familiares.",
    "E.5. Cláusula de ensayo común a toda persona usuaria.", "E.6. Cláusula de ensayo sobre cambios de rol.", "E.7. Cláusula de ensayo sobre evidencia.", "E.8. Cláusula de ensayo sobre representación."];
  const OFFICIAL = (n: string) => [`CONTRATO GENERAL — ENSAYO LOCAL DE INTEGRACIÓN ${tag} ${n}`, "PRIMERA. Cláusula de ensayo uno para la verificación local.", "DECIMOCTAVA. Cláusula de ensayo final.", "ANEXO A — ORDEN DE SUSCRIPCIÓN", "A.1. Plantilla de ensayo.", ...ANNEX].join("\n") + "\n";

  // ================================================================ Word original y aprobación verificada
  const doc = await call("POST", `${P_}/documents`, central.token, { code: `CONTRATO_GENERAL_ENSAYO_${tag}`, title: `Contrato General de ensayo ${tag}`, kind: "SERVICE_AGREEMENT", isTest: false, requiredForOperation: true });
  const docId = doc.body.document?.id;
  const body1 = OFFICIAL("v1");
  const v1 = (await call("POST", `${P_}/documents/${docId}/versions`, central.token, { versionLabel: "1.1", body: body1 })).body.version;
  const word = fakeDocx(), wordName = `Contrato_Ensayo_${tag}.docx`;
  const notDocx = await call("POST", `${P_}/versions/${v1.id}/source-file`, central.token, Buffer.concat([Buffer.from("NOZIP"), randomBytes(500)]), { "X-File-Name": wordName });
  const badName = await call("POST", `${P_}/versions/${v1.id}/source-file`, central.token, word, { "X-File-Name": "contrato.pdf" });
  const byAgency = await call("POST", `${P_}/versions/${v1.id}/source-file`, N.rep.token, word, { "X-File-Name": wordName });
  const up = await call("POST", `${P_}/versions/${v1.id}/source-file`, central.token, word, { "X-File-Name": wordName });
  const again = await call("POST", `${P_}/versions/${v1.id}/source-file`, central.token, fakeDocx(), { "X-File-Name": wordName });
  check("S1. Word original: no ZIP o nombre no .docx → 422; solo Central lo carga (agencia 403); se guarda con su SHA-256 calculado por la base; una segunda carga se rechaza",
    notDocx.status === 422 && badName.status === 422 && byAgency.status === 403 && up.status === 201 && up.body.sourceFile?.sha256 === sha256(word) && again.status === 409,
    [notDocx.status, badName.status, byAgency.status, up.status, again.status, again.body.error]);
  const suUpd = await errCode(q(`UPDATE contract_source_files SET content = $2 WHERE document_version_id = $1`, [v1.id, fakeDocx()]));
  const suDel = await errCode(q(`DELETE FROM contract_source_files WHERE document_version_id = $1`, [v1.id]));
  const suTrunc = await errCode(q(`TRUNCATE contract_source_files`));
  const suSwap = await errCode(q(`UPDATE contract_document_versions SET source_file_sha256 = $2 WHERE id = $1`, [v1.id, sha256("otro")]));
  check("S2. Inmutable incluso para el superusuario: no se modifica, borra, vacía ni se cambia la huella declarada",
    suUpd.includes("CONTRACT_SOURCE_FILE_IMMUTABLE") && suDel.includes("CONTRACT_SOURCE_FILE_IMMUTABLE") && suTrunc.includes("CONTRACT_HISTORY_IMMUTABLE") && suSwap.includes("CONTRACT_SOURCE_FILE_IMMUTABLE"), [suUpd, suDel, suTrunc, suSwap]);

  // Aprobación sin datos completos: se registra, pero NO permite publicar un contrato general oficial.
  await call("POST", `${P_}/versions/${v1.id}/legal-approval`, central.token, { reference: "Referencia libre de ensayo sin datos completos", contentSha256: v1.content_sha256 });
  process.env.CONTRACTS_OFFICIAL_PUBLISHING = "on";
  const pubFree = await call("POST", `${P_}/versions/${v1.id}/publish`, central.token);
  delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
  const LEGAL = { approverName: "Lcda. Abogada Ficticia de Ensayo", approvedOn: "2026-11-20", documentReference: `Aprobación ficticia de ensayo ${tag}` };
  const wrongFile = await call("POST", `${P_}/versions/${v1.id}/legal-approval`, central.token, { ...LEGAL, contentSha256: v1.content_sha256, sourceFileSha256: sha256("otro archivo") });
  const future = await call("POST", `${P_}/versions/${v1.id}/legal-approval`, central.token, { ...LEGAL, approvedOn: "2099-01-01", contentSha256: v1.content_sha256, sourceFileSha256: sha256(word) });
  const pipe = await call("POST", `${P_}/versions/${v1.id}/legal-approval`, central.token, { ...LEGAL, approverName: "Nombre | inyectado", contentSha256: v1.content_sha256, sourceFileSha256: sha256(word) });
  const okLegal = await call("POST", `${P_}/versions/${v1.id}/legal-approval`, central.token, { ...LEGAL, contentSha256: v1.content_sha256, sourceFileSha256: sha256(word) });
  check("S3. Publicar exige la aprobación con datos completos (409 REFERENCE_INCOMPLETE con una referencia libre); la verificada rechaza otro Word (422), una fecha futura (422) o datos con «|» (400)",
    pubFree.status === 409 && pubFree.body.error === "CONTRACT_LEGAL_APPROVAL_REFERENCE_INCOMPLETE" && wrongFile.status === 422 && future.status === 422 && pipe.status === 400, [pubFree.body, wrongFile.status, future.status, pipe.status]);
  check("S4. Aprobación verificada: la base liga la aprobación a la huella del texto y a la del Word; la referencia queda con nombre, fecha y documento tal como se escribieron",
    okLegal.status === 200 && okLegal.body.version?.legal_approved_sha256 === v1.content_sha256 && okLegal.body.version?.legal_approved_source_sha256 === sha256(word)
    && okLegal.body.version?.legal_approval_reference === `Aprobado por: ${LEGAL.approverName} | Fecha: ${LEGAL.approvedOn} | Referencia: ${LEGAL.documentReference}`, okLegal.body);
  const pubNoSwitch = await call("POST", `${P_}/versions/${v1.id}/publish`, central.token);
  process.env.CONTRACTS_OFFICIAL_PUBLISHING = "on";
  const pub1 = await call("POST", `${P_}/versions/${v1.id}/publish`, central.token);
  delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
  check("S5. Sin CONTRACTS_OFFICIAL_PUBLISHING no se publica (422); con el interruptor (solo en esta base) y la aprobación verificada, sí", pubNoSwitch.status === 422 && pub1.status === 200, [pubNoSwitch.status, pub1.status, pub1.body]);
  // Otro contrato oficial sin Word: con aprobación completa (por SQL, ficticia) tampoco se publica.
  const doc2 = await call("POST", `${P_}/documents`, central.token, { code: `CONTRATO_SIN_WORD_${tag}`, title: `Contrato sin Word ${tag}`, kind: "SERVICE_AGREEMENT", isTest: false });
  const v2nw = (await call("POST", `${P_}/documents/${doc2.body.document?.id}/versions`, central.token, { versionLabel: "1.0", body: OFFICIAL("sin-word") })).body.version;
  await q(`UPDATE contract_document_versions SET legal_status='legally_approved', legal_approved_by_user_id=$2, legal_approval_reference=$3 WHERE id=$1`, [v2nw.id, central.userId, `Aprobado por: ${LEGAL.approverName} | Fecha: 2026-11-20 | Referencia: ensayo`]);
  const suPubNoWord = await errCode(q(`UPDATE contract_document_versions SET status='published', published_by_user_id=$2 WHERE id=$1`, [v2nw.id, central.userId]));
  check("S6. Ni el superusuario publica un contrato general oficial sin su Word original guardado (CONTRACT_SOURCE_FILE_REQUIRED)", suPubNoWord.includes("CONTRACT_SOURCE_FILE_REQUIRED"), suPubNoWord);

  // ================================================================ Fase 7: agencia
  const st0 = await call("GET", O(orgN), N.rep.token);
  const pending0 = (st0.body.contracts ?? st0.body.items ?? []).find((c: Json) => c.id === v1.id || c.version_id === v1.id || c.document_id === docId);
  const terms0 = await call("GET", T(orgN), N.rep.token);
  check("01. Agencia nueva sin contrato: el contrato vigente aparece «pendiente»", st0.status === 200 && pending0?.acceptance === "pending", st0.body);
  const view = await call("GET", `${O(orgN)}/versions/${v1.id}`, N.rep.token);
  const pdf = await call("GET", `${O(orgN)}/versions/${v1.id}/document.pdf`, N.rep.token);
  const txt = await call("GET", `${O(orgN)}/versions/${v1.id}/document.txt`, N.rep.token);
  const dx = await call("GET", `${O(orgN)}/versions/${v1.id}/document.docx`, N.rep.token);
  // El PDF parte las líneas largas (p. ej., tras «/»): se compara sin espacios ni saltos.
  const noWs = (x: string) => x.replace(/\s+/g, "");
  const pdfTxt = noWs(await pdfToText(pdf.raw).catch(() => ""));
  const allLinesInPdf = body1.split("\n").filter((l) => l.trim()).every((l) => pdfTxt.includes(noWs(l)));
  const dl = (await q(`SELECT array_agg(format ORDER BY format) f FROM contract_document_downloads WHERE organization_id=$1 AND document_version_id=$2`, [orgN, v1.id])).rows[0].f;
  check("05. Descargable: PDF con todo el texto, texto exacto (misma huella) y Word original byte a byte (misma huella SHA-256); cada descarga queda registrada",
    view.body.version?.sourceFile?.sha256 === sha256(word) && pdf.status === 200 && allLinesInPdf && txt.raw.toString("utf8") === body1 && sha256(txt.raw) === v1.content_sha256
    && dx.status === 200 && dx.raw.equals(word) && dx.headers.get("x-content-sha256") === sha256(word) && JSON.stringify(dl) === JSON.stringify(["docx", "pdf", "txt"]),
    { pdf: pdf.status, allLinesInPdf, txt: sha256(txt.raw) === v1.content_sha256, docx: dx.status, eq: dx.raw.equals(word), dl });
  const noDesig = await sign(N.tech, orgN, v1.id, v1.content_sha256);
  await designate(orgN, N.rep);
  const techAfter = await sign(N.tech, orgN, v1.id, v1.content_sha256);
  check("04. Administradora técnica sin autoridad contractual no firma lo oficial (403 NOT_DESIGNATED), ni antes ni después de designar a otra", noDesig.req.status === 403 && techAfter.req.status === 403, [noDesig.req.body, techAfter.req.body]);
  const noBoxes = await call("POST", `${O(orgN)}/versions/${v1.id}/signature-code`, N.rep.token, { contentSha256: v1.content_sha256, ...SIGN, confirm: false, confirmAuthority: false });
  check("06. Sin marcar las casillas (llegan desmarcadas) no se puede ni pedir el código (400)", noBoxes.status === 400, noBoxes.status);
  const badCode = await sign(N.rep, orgN, v1.id, v1.content_sha256, SIGN, "000000");
  const noChallenge = await call("POST", `${O(orgN)}/versions/${v1.id}/accept`, N.rep.token, { contentSha256: v1.content_sha256, ...SIGN, challengeId: randomUUID(), code: "123456" });
  check("07. Identidad no verificada: código equivocado o inexistente → no se acepta", badCode.acc !== null && badCode.acc.status >= 400 && noChallenge.status >= 400, [badCode.acc?.status, badCode.acc?.body, noChallenge.status]);
  // Misma verificación (un envío por minuto): el código correcto del mismo desafío.
  const good = { req: badCode.req, acc: await call("POST", `${O(orgN)}/versions/${v1.id}/accept`, N.rep.token, { contentSha256: v1.content_sha256, ...SIGN, challengeId: badCode.req.body.challengeId, code: lastCode(N.rep.email) }) };
  const cert = good.acc?.body.acceptance?.id ? await call("GET", `${O(orgN)}/acceptances/${good.acc.body.acceptance.id}/certificate.pdf`, N.rep.token) : null;
  check("03/08. Representante designada: aceptación correcta (201) con código del correo de su cuenta y constancia PDF descargable", good.acc?.status === 201 && cert?.status === 200 && cert.raw.subarray(0, 4).toString() === "%PDF", [good.req.status, good.acc?.status, good.acc?.body, cert?.status]);
  const dup = await sign(N.rep, orgN, v1.id, v1.content_sha256);
  const suDup = await errCode(q(`INSERT INTO organization_contract_acceptances (organization_id,document_version_id,content_sha256,accepted_by_user_id,signer_full_name,signer_title,acceptance_statement,verification_challenge_id) SELECT organization_id,document_version_id,content_sha256,accepted_by_user_id,signer_full_name,signer_title,acceptance_statement,verification_challenge_id FROM organization_contract_acceptances WHERE organization_id=$1`, [orgN]));
  check("09. Firma duplicada: la segunda se rechaza (409 ALREADY_ACCEPTED) y la base tampoco admite otra fila", (dup.req.status === 409 || dup.acc?.status === 409) && suDup !== "ok", [dup.req.status, dup.req.body, dup.acc?.status, suDup]);
  const st1 = await call("GET", O(orgN), N.rep.token);
  check("02. Agencia con contrato vigente: «aceptado»", (st1.body.contracts ?? []).find((c: Json) => c.document_id === docId)?.acceptance === "accepted", st1.body);

  // 10. Cambio de versión contractual: versión 1.2 (exige nueva aceptación) → pendiente; la 1.1 se conserva.
  const body2 = OFFICIAL("v2");
  const v2 = (await call("POST", `${P_}/documents/${docId}/versions`, central.token, { versionLabel: "1.2", body: body2 })).body.version;
  const word2 = fakeDocx();
  await call("POST", `${P_}/versions/${v2.id}/source-file`, central.token, word2, { "X-File-Name": `Contrato_Ensayo_${tag}_v12.docx` });
  await call("POST", `${P_}/versions/${v2.id}/legal-approval`, central.token, { ...LEGAL, contentSha256: v2.content_sha256, sourceFileSha256: sha256(word2) });
  await call("POST", `${P_}/versions/${v1.id}/retire`, central.token);
  process.env.CONTRACTS_OFFICIAL_PUBLISHING = "on";
  const pub2 = await call("POST", `${P_}/versions/${v2.id}/publish`, central.token);
  delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
  const st2 = await call("GET", O(orgN), N.rep.token);
  const c2 = (st2.body.contracts ?? []).find((c: Json) => c.document_id === docId);
  const re = await sign(N.rep, orgN, v2.id, v2.content_sha256);
  const hist = await call("GET", `${O(orgN)}/acceptances`, N.rep.token);
  check("10. Cambio de versión: la 1.2 queda «pendiente» con la anterior a la vista; al aceptarla, el historial conserva ambas (sin sobrescribir)",
    pub2.status === 200 && c2?.acceptance === "pending" && c2?.isNewVersion === true && re.acc?.status === 201 && (hist.body.acceptances ?? []).length === 2, [pub2.status, c2?.acceptance, re.acc?.status, (hist.body.acceptances ?? []).length]);

  // 11. Constancias y Word de otra agencia.
  const accId = good.acc?.body.acceptance?.id;
  const xCert = await call("GET", `${O(orgN)}/acceptances/${accId}/certificate.pdf`, X.rep.token);
  const xCert2 = await call("GET", `${O(orgX)}/acceptances/${accId}/certificate.pdf`, X.rep.token);
  const xHist = await call("GET", `${O(orgN)}/acceptances`, X.rep.token);
  const xTerms = await call("GET", `${T(orgN)}/acceptances`, X.rep.token);
  check("11. Otra agencia no ve constancias, historial ni aceptaciones individuales ajenas (403/404)",
    [xCert.status, xCert2.status, xHist.status, xTerms.status].every((s) => s === 403 || s === 404), [xCert.status, xCert2.status, xHist.status, xTerms.status]);

  // ================================================================ términos por función
  const invented = await call("POST", `${P_}/role-terms`, central.token, { role: "CAREGIVER", versionLabel: "0.9", title: "Términos de ensayo", body: `${ANNEX[0]}\n\nE.3. Cláusula de ensayo para cuidadores.\n\nLínea nueva que no está en el contrato.\n`, sourceContractVersionId: v2.id });
  const altered = await call("POST", `${P_}/role-terms`, central.token, { role: "CAREGIVER", versionLabel: "0.9", title: "Términos de ensayo", body: `${ANNEX[0]}\n\nE.3. Cláusula de ensayo para cuidadores, con un cambio.\n`, sourceContractVersionId: v2.id });
  check("R1. Términos por función: la base rechaza cualquier línea inventada o alterada que no esté íntegra en el contrato (422 TEXT_NOT_IN_CONTRACT)",
    invented.status === 422 && invented.body.error === "ROLE_TERMS_TEXT_NOT_IN_CONTRACT" && altered.status === 422, [invented.body, altered.body]);
  const drafts = await call("POST", `${P_}/role-terms/drafts-from-annex`, central.token, { sourceContractVersionId: v2.id, versionLabel: "1.0" });
  const byRole = Object.fromEntries((drafts.body.roleTerms ?? []).map((t: Json) => [t.role, t]));
  const expect = (line: string) => [ANNEX[0], ANNEX[1], line, ANNEX[5], ANNEX[6], ANNEX[7], ANNEX[8]].join("\n\n") + "\n";
  check("R2. Borradores desde el Anexo E: Administración (E.2), Cuidadores (E.3), Familiares (E.4), cada uno con E.1 y E.5–E.8, literales y en borrador pendiente",
    drafts.status === 201 && byRole.ADMINISTRATION?.body === expect(ANNEX[2]) && byRole.CAREGIVER?.body === expect(ANNEX[3]) && byRole.FAMILY?.body === expect(ANNEX[4])
    && Object.values(byRole).every((t: Json) => t.status === "draft" && t.legal_status === "pending_legal_approval" && t.is_test === false), drafts.body);
  process.env.CONTRACTS_OFFICIAL_PUBLISHING = "on";
  const termsNoLegal = await call("POST", `${P_}/role-terms/${byRole.CAREGIVER.id}/publish`, central.token);
  delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
  const termsNoSwitch = await call("POST", `${P_}/role-terms/${byRole.CAREGIVER.id}/publish`, central.token);
  // Fuente sin aprobación jurídica: los términos no se publican aunque tengan su confirmación.
  const unapproved = (await call("POST", `${P_}/documents/${doc2.body.document?.id}/versions`, central.token, { versionLabel: "2.0", body: OFFICIAL("sin-aprobar") })).body.version;
  const fromUnapproved = await call("POST", `${P_}/role-terms`, central.token, { role: "FAMILY", versionLabel: "0.1", title: "Términos de ensayo", body: expect(ANNEX[4]), sourceContractVersionId: unapproved.id });
  await call("POST", `${P_}/role-terms/${fromUnapproved.body.roleTerms?.id}/legal-approval`, central.token, { reference: "Confirmación jurídica ficticia de ensayo", contentSha256: fromUnapproved.body.roleTerms?.content_sha256 });
  process.env.CONTRACTS_OFFICIAL_PUBLISHING = "on";
  const pubUnapproved = await call("POST", `${P_}/role-terms/${fromUnapproved.body.roleTerms?.id}/publish`, central.token);
  delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
  check("R3. Publicar términos oficiales exige: interruptor (422), su confirmación jurídica sobre esa huella (409 LEGAL_APPROVAL_REQUIRED) y un contrato fuente aprobado (409 SOURCE_NOT_APPROVED)",
    termsNoSwitch.status === 422 && termsNoLegal.status === 409 && termsNoLegal.body.error === "CONTRACT_LEGAL_APPROVAL_REQUIRED" && pubUnapproved.status === 409 && pubUnapproved.body.error === "ROLE_TERMS_SOURCE_NOT_APPROVED",
    [termsNoSwitch.status, termsNoLegal.body, pubUnapproved.body]);
  for (const role of ["ADMINISTRATION", "CAREGIVER", "FAMILY"]) {
    await call("POST", `${P_}/role-terms/${byRole[role].id}/legal-approval`, central.token, { reference: "Confirmación jurídica ficticia de ensayo", contentSha256: byRole[role].content_sha256 });
    process.env.CONTRACTS_OFFICIAL_PUBLISHING = "on";
    await call("POST", `${P_}/role-terms/${byRole[role].id}/publish`, central.token);
    delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
  }
  const suEdit = await errCode(q(`UPDATE role_terms_versions SET body = body || 'x' WHERE id=$1`, [byRole.CAREGIVER.id]));
  check("R4. Términos publicados: inalterables incluso para el superusuario", suEdit.includes("ROLE_TERMS_IMMUTABLE"), suEdit);

  // 12. Cuidador / 13. Familiar / supervisora.
  const wContracts = await call("GET", O(orgN), N.worker.token);
  const wTerms = await call("GET", T(orgN), N.worker.token);
  const wItem = (wTerms.body.items ?? [])[0];
  const wWrong = await call("POST", `${T(orgN)}/${byRole.ADMINISTRATION.id}/accept`, N.worker.token, { contentSha256: byRole.ADMINISTRATION.content_sha256, confirm: true });
  const wNoBox = await call("POST", `${T(orgN)}/${wItem?.id}/accept`, N.worker.token, { contentSha256: wItem?.content_sha256 });
  const wPdf = await call("GET", `${T(orgN)}/${wItem?.id}/document.pdf`, N.worker.token);
  const wOk = await call("POST", `${T(orgN)}/${wItem?.id}/accept`, N.worker.token, { contentSha256: wItem?.content_sha256, confirm: true });
  const wDup = await call("POST", `${T(orgN)}/${wItem?.id}/accept`, N.worker.token, { contentSha256: wItem?.content_sha256, confirm: true });
  check("12. Cuidador: no ve el contrato empresarial (403); ve y descarga solo los términos de Cuidadores; no acepta los de Administración (403); sin casilla 400; acepta (201) una sola vez (409)",
    wContracts.status === 403 && (wTerms.body.items ?? []).length === 1 && wItem?.role === "CAREGIVER" && wPdf.status === 200 && wWrong.status === 403 && wNoBox.status === 400 && wOk.status === 201 && wDup.status === 409,
    [wContracts.status, (wTerms.body.items ?? []).map((i: Json) => i.role), wWrong.status, wNoBox.status, wOk.status, wDup.status]);
  const fContracts = await call("GET", O(orgN), N.family.token);
  const fTerms = await call("GET", T(orgN), N.family.token);
  const fItem = (fTerms.body.items ?? [])[0];
  const fWrong = await call("POST", `${T(orgN)}/${byRole.CAREGIVER.id}/accept`, N.family.token, { contentSha256: byRole.CAREGIVER.content_sha256, confirm: true });
  const fOk = await call("POST", `${T(orgN)}/${fItem?.id}/accept`, N.family.token, { contentSha256: fItem?.content_sha256, confirm: true });
  const fHist = await call("GET", `${T(orgN)}/acceptances`, N.family.token);
  check("13. Familiar: no ve el contrato (403); solo los términos de Familiares; no acepta otros (403); acepta los suyos y solo ve su propia aceptación",
    fContracts.status === 403 && fItem?.role === "FAMILY" && (fTerms.body.items ?? []).length === 1 && fWrong.status === 403 && fOk.status === 201
    && (fHist.body.acceptances ?? []).length === 1 && fHist.body.acceptances[0].user_id === N.family.userId, [fContracts.status, fItem?.role, fWrong.status, fOk.status, (fHist.body.acceptances ?? []).length]);
  const sTerms = await call("GET", T(orgN), N.sup.token);
  const aHist = await call("GET", `${T(orgN)}/acceptances`, N.rep.token);
  const cTerms = await call("POST", `${T(orgN)}/${byRole.ADMINISTRATION.id}/accept`, central.token, { contentSha256: byRole.ADMINISTRATION.content_sha256, confirm: true });
  check("R5. Supervisora recibe los de Administración; la administración ve las aceptaciones de su agencia (2); Central no acepta en nombre de nadie",
    (sTerms.body.items ?? [])[0]?.role === "ADMINISTRATION" && (aHist.body.acceptances ?? []).length === 2 && cTerms.status >= 400, [(sTerms.body.items ?? []).map((i: Json) => i.role), (aHist.body.acceptances ?? []).length, cTerms.status]);
  // Versión nueva de términos: pendiente otra vez, la anterior se conserva.
  const cg2 = await call("POST", `${P_}/role-terms`, central.token, { role: "CAREGIVER", versionLabel: "1.1", title: "Términos individuales por función — Cuidadores", body: byRole.CAREGIVER.body.replace(`\n\n${ANNEX[6]}`, ""), sourceContractVersionId: v2.id });
  await call("POST", `${P_}/role-terms/${cg2.body.roleTerms?.id}/legal-approval`, central.token, { reference: "Confirmación jurídica ficticia de ensayo", contentSha256: cg2.body.roleTerms?.content_sha256 });
  await call("POST", `${P_}/role-terms/${byRole.CAREGIVER.id}/retire`, central.token);
  process.env.CONTRACTS_OFFICIAL_PUBLISHING = "on";
  const pubCg2 = await call("POST", `${P_}/role-terms/${cg2.body.roleTerms?.id}/publish`, central.token);
  delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
  const wTerms2 = await call("GET", T(orgN), N.worker.token);
  const wOk2 = await call("POST", `${T(orgN)}/${cg2.body.roleTerms?.id}/accept`, N.worker.token, { contentSha256: cg2.body.roleTerms?.content_sha256, confirm: true });
  const wHist = await call("GET", `${T(orgN)}/acceptances`, N.worker.token);
  check("R6. Versión nueva de términos: vuelve a quedar pendiente; al aceptarla el historial conserva las dos versiones",
    pubCg2.status === 200 && (wTerms2.body.items ?? [])[0]?.accepted === false && wOk2.status === 201 && (wHist.body.acceptances ?? []).length === 2, [pubCg2.status, wTerms2.body.items, wOk2.status, (wHist.body.acceptances ?? []).length]);

  // 14. Agencia con turnos activos.
  await designate(orgE, E.rep);
  const eSign = await sign(E.rep, orgE, v2.id, v2.content_sha256);
  const eStatus = await call("GET", `${O(orgE)}/status`, E.rep.token);
  const shiftAfter = (await q(`SELECT status FROM shifts WHERE id=$1`, [shift])).rows[0].status;
  check("14. Agencia con un turno en curso: firma normalmente; las reglas de acceso siguen apagadas (servidor sin CONTRACTS_ENFORCEMENT, modo «off») y el turno no cambia",
    eSign.acc?.status === 201 && eStatus.body.status?.serverEnforcementEnabled === false && eStatus.body.status?.mode === "off" && eStatus.body.status?.restricted === false && shiftAfter === "confirmed",
    [eSign.acc?.status, eStatus.body, shiftAfter]);

  // 15. Cancelación (retiro) y conservación de evidencias.
  await call("POST", `${P_}/versions/${v2.id}/retire`, central.token);
  const histAfter = await call("GET", `${O(orgN)}/acceptances`, N.rep.token);
  const certAfter = await call("GET", `${O(orgN)}/acceptances/${accId}/certificate.pdf`, N.rep.token);
  const dxAfter = await call("GET", `${O(orgN)}/versions/${v1.id}/document.docx`, N.rep.token);
  const suDelAcc = await errCode(q(`DELETE FROM organization_contract_acceptances WHERE organization_id=$1`, [orgN]));
  const suDelTerms = await errCode(q(`DELETE FROM user_role_terms_acceptances WHERE organization_id=$1`, [orgN]));
  const suUpdTerms = await errCode(q(`UPDATE user_role_terms_acceptances SET accepted_at = now() WHERE organization_id=$1`, [orgN]));
  check("15. Retiro del contrato: historial, constancias y Word anterior siguen disponibles; ninguna evidencia se borra ni se modifica (tampoco por el superusuario)",
    (histAfter.body.acceptances ?? []).length === 2 && certAfter.status === 200 && dxAfter.raw.equals(word)
    && suDelAcc.includes("IMMUTABLE") && suDelTerms.includes("ROLE_TERMS_ACCEPTANCE_IMMUTABLE") && suUpdTerms.includes("ROLE_TERMS_ACCEPTANCE_IMMUTABLE"), [histAfter.status, certAfter.status, suDelAcc, suDelTerms, suUpdTerms]);

  // 16. Sin facturación.
  const autoCharge = await errCode(q(`SELECT public.app_contract_order_terms_valid('{"status":"proposal","chargesRequireExpressAcceptance":true,"automaticCharges":true,"automaticRenewal":false,"billingActivated":false}'::jsonb) AS ok`).then((r) => { if (!r.rows[0].ok) throw new Error("rechazada"); }));
  const billingRows = (await q(`SELECT (SELECT count(*) FROM billing_settings)::int + (SELECT count(*) FROM billing_clients)::int AS n`)).rows[0].n;
  const features = (await q(`SELECT count(*)::int n FROM organization_features WHERE enabled AND feature_code IN ('FINANZAS','FACTURACION')`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  check("16. Aceptar contratos o términos no activa facturación: no se crean ajustes ni clientes de facturación, ningún módulo de cobro se enciende y las condiciones con cobro automático se rechazan",
    billingRows === 0 && features === 0 && autoCharge !== "ok", { billingRows, features, autoCharge });
  check("M1. Ningún correo real: todos los envíos quedaron interceptados en la prueba", mails.length > 0 && mails.every((m) => m.to.endsWith("@example.invalid")), mails.length);

  // ================================================================ reversión
  const ROLLBACK_SQL = readFileSync(join(process.cwd(), "ops/156_contract_source_files_role_terms.rollback.sql"), "utf8");
  const refused = await errCode(q(ROLLBACK_SQL));
  await q("ROLLBACK").catch(() => undefined);
  const stillThere = (await q(`SELECT (SELECT count(*) FROM contract_source_files)::int AS f, (SELECT count(*) FROM user_role_terms_acceptances)::int AS a`)).rows[0];
  check("RB1. Con evidencia oficial, la reversión de 156 se NIEGA y no borra nada", refused.includes("CONTRACT_ROLLBACK_REFUSED_OFFICIAL_EVIDENCE") && stillThere.f >= 2 && stillThere.a >= 3, [refused, stillThere]);

  // ================================================================ opcional: Contrato Oficial v1.1 real (solo local)
  if (process.env.OFFICIAL_TXT_PATH && process.env.OFFICIAL_DOCX_PATH) {
    const offTxt = readFileSync(process.env.OFFICIAL_TXT_PATH, "utf8"), offDocx = readFileSync(process.env.OFFICIAL_DOCX_PATH);
    const od = await call("POST", `${P_}/documents`, central.token, { code: "CONTRATO_GENERAL_ETNARA_CARE", title: "Contrato General de Suscripción y Servicios — ETNARA Care", kind: "SERVICE_AGREEMENT", isTest: false, requiredForOperation: true });
    const ov = (await call("POST", `${P_}/documents/${od.body.document?.id}/versions`, central.token, { versionLabel: "1.1", body: offTxt })).body.version;
    const oUp = await call("POST", `${P_}/versions/${ov.id}/source-file`, central.token, offDocx, { "X-File-Name": "ETNARA_Care_Contrato_Oficial_v1_1.docx" });
    check("O1. Oficial v1.1: huella del texto 15da7a74…6f2bde98b y del Word 72de4076…6c2a21d0, iguales a las registradas",
      ov.content_sha256 === "15da7a7496e2b6c9df158f015cf730888bfbc70927d87d6939f1efd9d6bb8f51" && oUp.body.sourceFile?.sha256 === "72de40762d4c91ddb289c991672e956bd59a86d641d25c1a384692c16c2a21d0", [ov.content_sha256, oUp.body.sourceFile?.sha256]);
    const oLegal = await call("POST", `${P_}/versions/${ov.id}/legal-approval`, central.token, {
      // Los datos reales de la aprobación no se guardan en el repositorio: llegan por variables locales.
      approverName: process.env.OFFICIAL_APPROVER ?? "Lcda. Abogada Ficticia de Ensayo", approvedOn: process.env.OFFICIAL_APPROVED_ON ?? "2026-11-20",
      documentReference: process.env.OFFICIAL_REFERENCE ?? "Referencia ficticia de ensayo local",
      contentSha256: ov.content_sha256, sourceFileSha256: oUp.body.sourceFile?.sha256 });
    check("O2. Aprobación verificada contra ambas huellas (solo en esta base desechable)", oLegal.status === 200 && oLegal.body.version?.legal_approved_source_sha256 === oUp.body.sourceFile?.sha256, oLegal.body);
    const oTerms = await call("POST", `${P_}/role-terms/drafts-from-annex`, central.token, { sourceContractVersionId: ov.id, versionLabel: "1.1-anexo-e" });
    const offLines = new Set(offTxt.split("\n").map((l) => l.trim()));
    const allVerbatim = (oTerms.body.roleTerms ?? []).length === 3 && (oTerms.body.roleTerms ?? []).every((t: Json) => t.body.split("\n").filter((l: string) => l.trim()).every((l: string) => offLines.has(l.trim())));
    check("O3. Términos por función del Oficial v1.1: tres borradores, todas sus líneas literales del Anexo E", oTerms.status === 201 && allVerbatim, oTerms.body.roleTerms?.map((t: Json) => [t.role, t.body.split("\n").filter((l: string) => l.trim()).map((l: string) => l.slice(0, 5))]));
    process.env.CONTRACTS_OFFICIAL_PUBLISHING = "on";
    const oPub = await call("POST", `${P_}/versions/${ov.id}/publish`, central.token);
    delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
    await designate(orgX, X.rep);
    const oPdf = await call("GET", `${O(orgX)}/versions/${ov.id}/document.pdf`, X.rep.token);
    const oPdfTxt = noWs(await pdfToText(oPdf.raw).catch(() => ""));
    const missing = offTxt.split("\n").map((l) => l.trim()).filter((l) => l && !oPdfTxt.includes(noWs(l)));
    const oDx = await call("GET", `${O(orgX)}/versions/${ov.id}/document.docx`, X.rep.token);
    const oTx = await call("GET", `${O(orgX)}/versions/${ov.id}/document.txt`, X.rep.token);
    check("O4. Reproducción íntegra (base desechable): el PDF contiene todas las líneas del texto, el texto descargado es idéntico y el Word descargado es el original byte a byte",
      oPub.status === 200 && missing.length === 0 && oTx.raw.toString("utf8") === offTxt && oDx.raw.equals(offDocx), { pub: oPub.status, missing: missing.slice(0, 3), n: missing.length });
  }

  server.close(); await pool.end().catch(() => undefined); await db.end();
  await srv.query(`DROP DATABASE ${own} WITH (FORCE)`).catch(() => undefined); await srv.end();
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 600)}`}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`TOTAL ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 600)}`}`); console.error(e); process.exit(2); });
