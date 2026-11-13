/**
 * Contrato SaaS v1.0 (153) — 9-nov-2026. Datos FICTICIOS, base desechable, ningún correo real.
 * App real por HTTP como app_runtime. Los 14 casos de la misión, más seguridad:
 *   borrador oficial no publicable ni aceptable (aprobación jurídica ligada a la huella), vista previa
 *   de Central, representantes designados (administradora técnica sin autoridad no firma), Orden de
 *   Suscripción solo de su agencia y con condiciones inalterables, límite de 10 fundadoras, evidencia
 *   de consentimiento (casilla, descarga previa, designación), reglas de acceso APAGADAS por defecto y,
 *   encendidas solo en esta prueba, sin tocar cuidadores, turnos en curso ni lecturas; suspensión y
 *   reactivación; reversión que se niega con evidencia oficial.
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
let adminUrl = serverUrl;
if (!serverUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(serverUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const errCode = (p: Promise<unknown>) => p.then(() => "ok", (e) => `${(e as { code?: string }).code ?? "?"}:${(e as Error).message}`);

const mails: Array<{ to: string; html: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) {
    const b = JSON.parse(String(init?.body ?? "{}"));
    mails.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, html: String(b.html ?? "") });
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";

async function main() {
  // Base PROPIA y desechable (las otras verificaciones del CI dejan contratos de prueba publicados).
  const own = `etnara_s153_${randomBytes(4).toString("hex")}`;
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  await srv.query(`CREATE DATABASE ${own}`);
  const ownUrl = new URL(serverUrl!); ownUrl.pathname = `/${own}`; adminUrl = ownUrl.toString();
  { const m = new pg.Client({ connectionString: adminUrl }); await m.connect(); const log = console.log; console.log = () => undefined;
    try { await applyPendingMigrations(m, join(process.cwd(), "migrations")); } finally { console.log = log; await m.end(); } }
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  if (Number((await q(`SELECT count(*) FROM contract_documents`)).rows[0].count) > 0) throw new Error("Requires a disposable database with an empty contract catalog");
  process.env.CONTRACTS_MODULE = "on";
  delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
  delete process.env.CONTRACTS_ENFORCEMENT;
  delete process.env.CONTRACTS_TEST_SIGNING;
  // Texto del PDF sin binarios del sistema (mismo lector que F3, scripts/lib/pdfText.ts; falla cerrado).
  const pdfText = (buf: Buffer) => pdfToText(buf);

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
    const res = await realFetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = Buffer.from(await res.arrayBuffer());
    let json: Json = {}; try { json = JSON.parse(raw.toString("utf8")); } catch { /* binario */ }
    return { status: res.status, body: json, raw };
  }

  // ---------------------------------------------------------------- agencias y personas ficticias
  const org = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgN = await org(`Agencia Nueva Ficticia ${tag}`), orgE = await org(`Agencia Existente Ficticia ${tag}`), orgX = await org(`Agencia Otra Ficticia ${tag}`);
  type P = { email: string; userId: string; token: string; membership: string; orgId: string };
  async function person(key: string, orgId: string, roles: string[]): Promise<P> {
    const email = `s153-${key}-${tag.toLowerCase()}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const membership = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [membership, orgId, roles]);
    return { email, userId, token: "", membership, orgId };
  }
  const N = { admin: await person("n-admin", orgN, ["ORGANIZATION_ADMIN"]), tech: await person("n-tecnico", orgN, ["ORGANIZATION_ADMIN"]) };
  const E = { admin: await person("e-admin", orgE, ["ORGANIZATION_ADMIN"]), sup: await person("e-sup", orgE, ["SUPERVISOR"]), worker: await person("e-cuidador", orgE, ["WORKER"]), family: await person("e-familia", orgE, ["FAMILY"]) };
  const X = { admin: await person("x-admin", orgX, ["ORGANIZATION_ADMIN"]) };
  const central = await person("central", orgX, []);
  await q(`DELETE FROM organization_memberships WHERE id=$1`, [central.membership]);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.userId]);
  // Agencia existente con datos: residente, cuidador y un turno en curso asignado.
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
  const P_ = "/platform/contracts", O = (o: string) => `/organizations/${o}/contracts`;
  const lastCode = (email: string) => [...mails].reverse().find((m) => m.to === email)?.html.match(/>(\d{6})</)?.[1] ?? null;
  const SIGN = { signerFullName: "Ana Ficticia Representante", signerTitle: "Presidenta (ficticia)", confirmAuthority: true, confirm: true };
  async function sign(p: P, o: string, versionId: string, h: string, signer: Json = SIGN) {
    const req = await call("POST", `${O(o)}/versions/${versionId}/signature-code`, p.token, { contentSha256: h, ...signer });
    if (req.status !== 201) return { req, acc: null as null | Awaited<ReturnType<typeof call>> };
    const acc = await call("POST", `${O(o)}/versions/${versionId}/accept`, p.token, { contentSha256: h, ...signer, challengeId: req.body.challengeId, code: lastCode(p.email) });
    return { req, acc };
  }

  // ================================================================ Borradores oficiales: nunca publicables ni firmables
  // (a) Texto de reemplazo/ficticio con forma de oficial: no se aprueba, no se publica, no se firma.
  const PLACEHOLDER = `CONTRATO GENERAL DE SUSCRIPCIÓN Y SERVICIOS — PLATAFORMA ETNARA CARE (TEXTO DE REEMPLAZO PARA PRUEBAS LOCALES)\nVersión 1.0 — BORRADOR.\n1. Cláusula de reemplazo ${tag}. 2. Cláusula de reemplazo. 18. Cláusula de reemplazo.\n`;
  // (b) Borrador con la marca del propio documento «NO UTILIZAR PARA FIRMAS» (como el contrato real v1.1).
  const MARKED = `CONTRATO GENERAL — ENSAYO ${tag}\nDOCUMENTO PARA REVISIÓN JURÍDICA Y VALIDACIÓN TÉCNICA — NO UTILIZAR PARA FIRMAS\n1. Cláusula de ensayo para la verificación local.\n2. Cláusula de ensayo.\n`;
  // (c) Borrador limpio (sin marcas) para probar la aprobación ligada a la huella; nunca se publica.
  const CLEAN = `CONTRATO GENERAL — ENSAYO DE APROBACIÓN ${tag}\n1. Cláusula de ensayo para la verificación local de la huella.\n2. Cláusula de ensayo.\n`;
  const SRC = randomBytes(64);
  const mkOfficial = async (suffix: string, body: string, src?: Buffer) => {
    const d = await call("POST", `${P_}/documents`, central.token, { code: `CONTRATO_GENERAL_${suffix}_${tag}`, title: `Contrato General de Suscripción y Servicios ${suffix}`, kind: "SERVICE_AGREEMENT", isTest: false, requiredForOperation: true });
    return call("POST", `${P_}/documents/${d.body.document?.id}/versions`, central.token, { versionLabel: "1.1", body, ...(src ? { sourceFileName: "ETNARA_Care_Contrato_Consolidado_v1_1.docx", sourceFileSha256: sha256(src) } : {}) });
  };
  const phV = (await mkOfficial("PH", PLACEHOLDER)).body.version ?? {};
  const mkV0 = await mkOfficial("MK", MARKED, SRC);
  const mkV = mkV0.body.version ?? {};
  const gv = (await mkOfficial("CL", CLEAN)).body.version ?? {};
  check("A1. Borrador oficial guardado íntegro: huella = SHA-256 del texto, nombre y SHA-256 del archivo fuente, «borrador» y «pendiente de aprobación jurídica»", mkV0.status === 201 && mkV.content_sha256 === sha256(MARKED) && mkV.source_file_sha256 === sha256(SRC) && mkV.legal_status === "pending_legal_approval" && mkV.status === "draft", [mkV0.status, mkV.legal_status]);
  const prev = await call("GET", `${P_}/versions/${mkV.id}`, central.token);
  check("A2. Central ve el borrador completo (vista previa); las agencias no lo ven", prev.status === 200 && prev.body.version?.body === MARKED && (await call("GET", `${O(orgN)}/versions/${mkV.id}`, N.admin.token)).status === 404 && (await call("GET", `${P_}/versions/${mkV.id}`, N.admin.token)).status === 403, prev.status);
  const phLegal = await call("POST", `${P_}/versions/${phV.id}/legal-approval`, central.token, { reference: "Referencia ficticia de prueba", contentSha256: phV.content_sha256 });
  const mkLegal = await call("POST", `${P_}/versions/${mkV.id}/legal-approval`, central.token, { reference: "Referencia ficticia de prueba", contentSha256: mkV.content_sha256 });
  check("A2b. Texto de reemplazo → no se aprueba (409 CONTRACT_PLACEHOLDER_TEXT_NOT_ALLOWED); texto marcado «NO UTILIZAR PARA FIRMAS» → no se aprueba (409 CONTRACT_DRAFT_MARKED_NOT_SIGNABLE)",
    phLegal.status === 409 && phLegal.body.error === "CONTRACT_PLACEHOLDER_TEXT_NOT_ALLOWED" && mkLegal.status === 409 && mkLegal.body.error === "CONTRACT_DRAFT_MARKED_NOT_SIGNABLE", [phLegal.body, mkLegal.body]);
  const pubOff = await call("POST", `${P_}/versions/${mkV.id}/publish`, central.token);
  process.env.CONTRACTS_OFFICIAL_PUBLISHING = "on";
  const pubMk = await call("POST", `${P_}/versions/${mkV.id}/publish`, central.token);
  const pubPh = await call("POST", `${P_}/versions/${phV.id}/publish`, central.token);
  const pubNoLegal = await call("POST", `${P_}/versions/${gv.id}/publish`, central.token);
  delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
  check("A3. Ningún borrador oficial se publica: sin interruptor (422); con el interruptor, el marcado (409 NOT_SIGNABLE), el de reemplazo (409 PLACEHOLDER) y el limpio sin aprobación (409 LEGAL_APPROVAL_REQUIRED)",
    pubOff.status === 422 && pubMk.body.error === "CONTRACT_DRAFT_MARKED_NOT_SIGNABLE" && pubPh.body.error === "CONTRACT_PLACEHOLDER_TEXT_NOT_ALLOWED" && pubNoLegal.status === 409 && pubNoLegal.body.error === "CONTRACT_LEGAL_APPROVAL_REQUIRED"
    && (await q(`SELECT count(*)::int n FROM contract_document_versions WHERE id = ANY($1) AND status='draft'`, [[mkV.id, phV.id, gv.id]])).rows[0].n === 3, [pubOff.status, pubMk.body, pubPh.body, pubNoLegal.body]);
  const legalWrong = await call("POST", `${P_}/versions/${gv.id}/legal-approval`, central.token, { reference: "Referencia ficticia de prueba", contentSha256: sha256("otro") });
  const legalAgency = await call("POST", `${P_}/versions/${gv.id}/legal-approval`, N.admin.token, { reference: "Referencia ficticia de prueba", contentSha256: gv.content_sha256 });
  check("A4. La aprobación jurídica exige la huella exacta (409) y solo la registra Central (agencia 403)", legalWrong.status === 409 && legalAgency.status === 403, [legalWrong.status, legalAgency.status]);
  await call("POST", `${P_}/versions/${gv.id}/legal-approval`, central.token, { reference: "Referencia ficticia de prueba (no es una aprobación real)", contentSha256: gv.content_sha256 });
  const approved = (await q(`SELECT legal_status, legal_approved_sha256 FROM contract_document_versions WHERE id=$1`, [gv.id])).rows[0];
  await call("PATCH", `${P_}/versions/${gv.id}`, central.token, { body: CLEAN + "Cambio en borrador.\n" });
  const reset = (await q(`SELECT legal_status, legal_approved_sha256 FROM contract_document_versions WHERE id=$1`, [gv.id])).rows[0];
  check("A5. La aprobación vale para ESA huella: al editar el borrador, la base la anula", approved.legal_status === "legally_approved" && approved.legal_approved_sha256 === gv.content_sha256 && reset.legal_status === "pending_legal_approval" && reset.legal_approved_sha256 === null, [approved, reset]);
  const suPub = await errCode(q(`UPDATE contract_document_versions SET status='published', published_by_user_id=$2 WHERE id=$1`, [gv.id, central.userId]));
  const suMk = await errCode(q(`UPDATE contract_document_versions SET legal_status='legally_approved', legal_approved_by_user_id=$2, legal_approval_reference='Referencia ficticia de prueba' WHERE id=$1`, [mkV.id, central.userId]));
  check("A6. Ni el superusuario publica un oficial sin aprobación vigente ni aprueba un texto marcado como no firmable", suPub.includes("CONTRACT_LEGAL_APPROVAL_REQUIRED") && suMk.includes("CONTRACT_DRAFT_MARKED_NOT_SIGNABLE"), [suPub, suMk]);

  // ================================================================ Documento de PRUEBA obligatorio + Órdenes de prueba
  const BANNER = "DOCUMENTO FICTICIO DE PRUEBA — sin valor legal. No es el contrato oficial de ETNARA Care.";
  const tdoc = await call("POST", `${P_}/documents`, central.token, { code: `TEST_CONTRATO_GENERAL_${tag}`, title: `[PRUEBA] Contrato General ficticio ${tag}`, kind: "SERVICE_AGREEMENT", isTest: true, requiredForOperation: true });
  const tbody1 = `${BANNER}\n\n1. Objeto (ficticio). 2. Plazo (ficticio). 18. Cláusula final (ficticia).\n`;
  const tv1 = (await call("POST", `${P_}/documents/${tdoc.body.document.id}/versions`, central.token, { versionLabel: "1.0", body: tbody1 })).body.version;
  await call("POST", `${P_}/versions/${tv1.id}/publish`, central.token);
  // Texto ficticio: sin CONTRACTS_TEST_SIGNING (estado de cualquier entorno real) nadie lo puede firmar.
  const tView = await call("GET", `${O(orgN)}/versions/${tv1.id}`, N.admin.token);
  const tCode = await call("POST", `${O(orgN)}/versions/${tv1.id}/signature-code`, N.admin.token, { contentSha256: sha256(tbody1), ...SIGN });
  check("T1. Documento ficticio publicado: con el interruptor de pruebas apagado se puede leer pero NO firmar (409 CONTRACT_TEST_DOCUMENT_NOT_SIGNABLE, sin código enviado)",
    tView.status === 200 && tView.body.version?.signer?.allowed === false && tView.body.version?.signer?.blockedReason === "TEST_DOCUMENT" && tCode.status === 409 && tCode.body.error === "CONTRACT_TEST_DOCUMENT_NOT_SIGNABLE" && mails.length === 0, [tView.body.version?.signer, tCode.body]);
  process.env.CONTRACTS_TEST_SIGNING = "on"; // solo en esta prueba local, para ejercitar el flujo con documentos ficticios
  // Orden individual: sin precio (por definir) para N; precio PROPUESTO distinto para E.
  const TERMS_N = { planName: "Plan de prueba A", features: ["Turnos y asistencia", "Residentes"], proposedMonthlyPriceUsd: null, promotions: [{ description: "Promoción ficticia de bienvenida", durationDays: 30 }], conditions: ["Condición particular ficticia"], foundingProgram: true };
  const TERMS_E = { planName: "Plan de prueba B", features: ["Turnos y asistencia", "Mensajería"], proposedMonthlyPriceUsd: 135.5, addOns: [{ name: "Complemento ficticio", proposedMonthlyPriceUsd: null }] };
  const ordN = await call("POST", `${P_}/organizations/${orgN}/subscription-orders`, central.token, { isTest: true, versionLabel: "1.0", requiredForOperation: true, terms: TERMS_N });
  const ordE = await call("POST", `${P_}/organizations/${orgE}/subscription-orders`, central.token, { isTest: true, versionLabel: "1.0", requiredForOperation: true, terms: TERMS_E });
  const ordAgency = await call("POST", `${P_}/organizations/${orgN}/subscription-orders`, N.admin.token, { isTest: true, versionLabel: "9", terms: TERMS_N });
  const ordNoTerms = await call("POST", `${P_}/organizations/${orgN}/subscription-orders`, central.token, { isTest: true, versionLabel: "8" });
  const on = ordN.body.order ?? {}, oe = ordE.body.order ?? {};
  const bodyN = (await q(`SELECT body, commercial_status FROM contract_document_versions WHERE id=$1`, [on.versionId])).rows[0] ?? {};
  const bodyE = (await q(`SELECT body FROM contract_document_versions WHERE id=$1`, [oe.versionId])).rows[0] ?? {};
  check("F1. Orden por agencia con condiciones individuales (plan, funcionalidades, precio, promociones, complementos, condiciones); sin precio predeterminado: la de N dice «POR DEFINIR Y ACEPTAR», la de E muestra su precio como PROPUESTA; ningún US$99; solo Central la crea; sin condiciones → 400",
    ordN.status === 201 && ordE.status === 201 && ordAgency.status === 403 && ordNoTerms.status === 400
    && on.commercialTerms?.pricing?.proposedMonthlyPriceUsd === null && oe.commercialTerms?.pricing?.proposedMonthlyPriceUsd === 135.5
    && bodyN.body.includes("Precio mensual: POR DEFINIR Y ACEPTAR") && bodyE.body.includes("US$135.50 al mes (PROPUESTA") && !/99/.test(bodyN.body + bodyE.body)
    && on.commercialTerms?.status === "proposal" && bodyN.commercial_status === "proposal" && on.commercialStatus === "proposal", [ordN.status, ordE.status, ordAgency.status, ordNoTerms.status]);
  check("F1b. Salvaguardas fijadas por el servidor: aceptación expresa obligatoria, sin cobro ni renovación automáticos, facturación desactivada; Fundadoras como configuración PENDIENTE DE APROBACIÓN DEFINITIVA",
    on.commercialTerms?.chargesRequireExpressAcceptance === true && on.commercialTerms?.automaticCharges === false && on.commercialTerms?.automaticRenewal === false && on.commercialTerms?.billingActivated === false
    && on.commercialTerms?.foundingProgram?.programStatus === "pending_definitive_approval" && bodyN.body.includes("PENDIENTE DE APROBACIÓN DEFINITIVA") && oe.commercialTerms?.foundingProgram === null, on.commercialTerms);
  const badTerms = [
    await errCode(q(`UPDATE contract_document_versions SET commercial_terms = commercial_terms || '{"billingActivated":true}'::jsonb WHERE id=$1`, [on.versionId])),
    await errCode(q(`UPDATE contract_document_versions SET commercial_terms = commercial_terms || '{"automaticCharges":true}'::jsonb WHERE id=$1`, [on.versionId])),
    await errCode(q(`UPDATE contract_document_versions SET commercial_terms = commercial_terms || '{"status":"final"}'::jsonb WHERE id=$1`, [on.versionId])),
  ];
  check("F1c. Ni el superusuario puede activar facturación, cobro automático o quitar el estado «propuesta» en una Orden", badTerms.every((x) => x.includes("CONTRACT_ORDER_TERMS_INVALID")), badTerms);
  const patchOrder = await call("PATCH", `${P_}/versions/${on.versionId}`, central.token, { body: "Texto escrito a mano para la Orden, que no debe aceptarse por esta vía." });
  const fp = await call("GET", `${P_}/founding-program`, central.token), fpAgency = await call("GET", `${P_}/founding-program`, N.admin.token);
  check("F1d. El texto de la Orden solo cambia por sus condiciones (422); el programa Fundadoras se consulta solo en Central y figura pendiente de aprobación definitiva",
    patchOrder.status === 422 && patchOrder.body.error === "CONTRACT_ORDER_EDIT_VIA_TERMS" && fp.status === 200 && fp.body.program?.status === "pending_definitive_approval" && fpAgency.status === 403, [patchOrder.status, fp.body.program?.status, fpAgency.status]);
  await call("POST", `${P_}/versions/${on.versionId}/publish`, central.token);
  await call("POST", `${P_}/versions/${oe.versionId}/publish`, central.token);
  const termsImm = await errCode(q(`UPDATE contract_document_versions SET commercial_terms = commercial_terms || '{"planName":"otro"}'::jsonb WHERE id=$1`, [on.versionId]));
  check("F2. Las condiciones de una Orden publicada no cambian (ni el superusuario)", termsImm.includes("IMMUTABLE"), termsImm);
  // Orden OFICIAL (borrador): aprobación comercial y jurídica de ESE texto; ajustar condiciones las anula.
  const offOrd = await call("POST", `${P_}/organizations/${orgX}/subscription-orders`, central.token, { isTest: false, versionLabel: "1.0", terms: { planName: "Plan propuesto X", features: ["Turnos"], proposedMonthlyPriceUsd: 120 } });
  const ov = offOrd.body.order ?? {};
  await call("POST", `${P_}/versions/${ov.versionId}/legal-approval`, central.token, { reference: "Referencia ficticia de prueba jurídica", contentSha256: ov.contentSha256 });
  process.env.CONTRACTS_OFFICIAL_PUBLISHING = "on";
  const pubNoCom = await call("POST", `${P_}/versions/${ov.versionId}/publish`, central.token);
  delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
  const comWrong = await call("POST", `${P_}/versions/${ov.versionId}/commercial-approval`, central.token, { reference: "Referencia ficticia de prueba comercial", contentSha256: sha256("otro") });
  const comAgency = await call("POST", `${P_}/versions/${ov.versionId}/commercial-approval`, X.admin.token, { reference: "Referencia ficticia de prueba comercial", contentSha256: ov.contentSha256 });
  const comOk = await call("POST", `${P_}/versions/${ov.versionId}/commercial-approval`, central.token, { reference: "Referencia ficticia de prueba comercial", contentSha256: ov.contentSha256 });
  const both = (await q(`SELECT legal_status, commercial_status FROM contract_document_versions WHERE id=$1`, [ov.versionId])).rows[0];
  const edited = await call("PUT", `${P_}/versions/${ov.versionId}/order-terms`, central.token, { planName: "Plan propuesto X", features: ["Turnos"], proposedMonthlyPriceUsd: 110 });
  const afterEdit = (await q(`SELECT legal_status, commercial_status, body FROM contract_document_versions WHERE id=$1`, [ov.versionId])).rows[0];
  const signOff = await errCode((async () => { await q("BEGIN"); try {
    await q(`UPDATE contract_document_versions SET legal_status='legally_approved', legal_approved_by_user_id=$2, legal_approval_reference='Referencia ficticia de prueba' WHERE id=$1`, [ov.versionId, central.userId]);
    await q(`INSERT INTO contract_signature_challenges (id,organization_id,document_version_id,user_id,code_hash) VALUES ($1,$2,$3,$4,repeat('f',64))`, [randomUUID(), orgX, ov.versionId, X.admin.userId]);
  } finally { await q("ROLLBACK"); } })());
  check("F4. Orden oficial: con aprobación jurídica pero sin la comercial no se publica (409 CONTRACT_COMMERCIAL_APPROVAL_REQUIRED); la comercial exige la huella exacta (409) y solo Central (403); ajustar condiciones regenera el texto y anula ambas aprobaciones",
    offOrd.status === 201 && pubNoCom.status === 409 && pubNoCom.body.error === "CONTRACT_COMMERCIAL_APPROVAL_REQUIRED" && comWrong.status === 409 && comAgency.status === 403 && comOk.status === 200
    && both.legal_status === "legally_approved" && both.commercial_status === "commercially_approved" && edited.status === 200
    && afterEdit.legal_status === "pending_legal_approval" && afterEdit.commercial_status === "proposal" && afterEdit.body.includes("US$110.00"), [offOrd.status, pubNoCom.body, comWrong.status, comAgency.status, comOk.status, comOk.body, both, afterEdit.legal_status, afterEdit.commercial_status]);
  check("F4b. Una Orden oficial sin publicar (le falta la aprobación comercial) no se puede firmar, ni insertando en la base", signOff.includes("CONTRACT_VERSION_NOT_ACCEPTABLE") || signOff.includes("CONTRACT_COMMERCIAL_APPROVAL_REQUIRED"), signOff);
  // Límite de 10 fundadoras (Órdenes oficiales en borrador inscritas en el programa; nada se publica)
  const extra: string[] = [];
  for (let i = 0; i < 10; i++) extra.push(await org(`Fundadora Ficticia ${i} ${tag}`));
  const founding: number[] = [];
  for (const o of extra) founding.push((await call("POST", `${P_}/organizations/${o}/subscription-orders`, central.token, { isTest: false, versionLabel: "1.0", terms: { planName: "Plan propuesto", features: ["Turnos"], foundingProgram: true } })).status);
  const eleventh = await call("POST", `${P_}/organizations/${orgN}/subscription-orders`, central.token, { isTest: false, versionLabel: "1.1", terms: { planName: "Plan propuesto", features: ["Turnos"], foundingProgram: true } });
  const notFounding = await call("POST", `${P_}/organizations/${orgN}/subscription-orders`, central.token, { isTest: false, versionLabel: "1.2", terms: { planName: "Plan propuesto", features: ["Turnos"] } });
  check("F3. Programa Agencias Fundadoras (propuesto): 10 Órdenes oficiales inscritas (borrador) y la undécima inscrita se rechaza (409 CONTRACT_FOUNDING_PROGRAM_FULL); una Orden sin el programa sí se crea; ninguna se publica", founding.every((s) => s === 201) && notFounding.status === 201 && eleventh.status === 409 && eleventh.body.error === "CONTRACT_FOUNDING_PROGRAM_FULL" && (await q(`SELECT count(*)::int n FROM contract_document_versions v JOIN contract_documents d ON d.id=v.document_id WHERE d.kind='SUBSCRIPTION_ORDER' AND NOT d.is_test AND v.status<>'draft'`)).rows[0].n === 0, [founding, eleventh.status]);

  // ================================================================ Caso 1: agencia nueva sin contrato
  const st1 = await call("GET", `${O(orgN)}/status`, N.admin.token);
  const listN = await call("GET", O(orgN), N.admin.token);
  check("1. Agencia nueva sin contrato: estado «no cumple» (2 obligatorios pendientes) y ve el Contrato General de prueba y SU Orden", st1.status === 200 && st1.body.status?.satisfied === false && st1.body.status?.pendingRequired === 2 && st1.body.status?.serverEnforcementEnabled === false && st1.body.status?.restricted === false
    && listN.body.contracts?.length === 2 && listN.body.contracts.some((c: Json) => c.id === on.versionId), [st1.body.status, listN.body.contracts?.length]);

  // Representantes designados por Central
  const desAgency = await call("POST", `${P_}/organizations/${orgN}/signatories`, N.admin.token, { userId: N.admin.userId, fullName: "Ana Ficticia Representante", title: "Presidenta (ficticia)", basis: "Resolución corporativa ficticia de prueba" });
  const desNonAdmin = await call("POST", `${P_}/organizations/${orgE}/signatories`, central.token, { userId: E.worker.userId, fullName: "Cuidador Ficticio Uno", title: "Cuidador", basis: "Intento de designar a quien no administra" });
  const desN = await call("POST", `${P_}/organizations/${orgN}/signatories`, central.token, { userId: N.admin.userId, fullName: "Ana Ficticia Representante", title: "Presidenta (ficticia)", basis: "Resolución corporativa ficticia de prueba" });
  const desE = await call("POST", `${P_}/organizations/${orgE}/signatories`, central.token, { userId: E.admin.userId, fullName: "Eva Ficticia Directora", title: "Directora ejecutiva (ficticia)", basis: "Formulario de alta ficticio" });
  check("S1. Solo Central designa (agencia 403), solo a administradoras activas (422)", desAgency.status === 403 && desNonAdmin.status === 422 && desN.status === 201 && desE.status === 201, [desAgency.status, desNonAdmin.status, desN.status, desE.status]);

  // ================================================================ Caso 3: administradora técnica sin autoridad
  const techV = await call("GET", `${O(orgN)}/versions/${tv1.id}`, N.tech.token);
  const techCode = await call("POST", `${O(orgN)}/versions/${tv1.id}/signature-code`, N.tech.token, { contentSha256: sha256(tbody1), ...SIGN });
  check("3. Administradora técnica (administra, pero no está designada): ve el contrato, no puede firmar (403 CONTRACT_SIGNATORY_NOT_DESIGNATED) y no se le envía código", techV.status === 200 && techV.body.version?.signer?.allowed === false && techCode.status === 403 && techCode.body.error === "CONTRACT_SIGNATORY_NOT_DESIGNATED" && !mails.some((m) => m.to === N.tech.email), [techV.body.version?.signer, techCode.status]);

  // ================================================================ Casos 4 y 5: descarga y casillas
  const dl = await call("GET", `${O(orgN)}/versions/${tv1.id}/document.pdf`, N.admin.token);
  const dlRows = (await q(`SELECT count(*)::int n FROM contract_document_downloads WHERE user_id=$1 AND document_version_id=$2 AND format='pdf'`, [N.admin.userId, tv1.id])).rows[0].n;
  check("4. Contrato descargable (PDF válido) y la descarga queda registrada para la evidencia", dl.status === 200 && dl.raw.subarray(0, 4).toString() === "%PDF" && dlRows === 1, [dl.status, dlRows]);
  const unchecked = [
    await call("POST", `${O(orgN)}/versions/${tv1.id}/signature-code`, N.admin.token, { contentSha256: sha256(tbody1), ...SIGN, confirm: false }),
    await call("POST", `${O(orgN)}/versions/${tv1.id}/signature-code`, N.admin.token, { contentSha256: sha256(tbody1), ...SIGN, confirmAuthority: false }),
    await call("POST", `${O(orgN)}/versions/${tv1.id}/signature-code`, N.admin.token, { contentSha256: sha256(tbody1), signerFullName: "Ana Ficticia Representante", signerTitle: "Presidenta" }),
  ];
  check("5. Casillas sin marcar → 400 y no se envía código", unchecked.every((r) => r.status === 400) && !mails.some((m) => m.to === N.admin.email), unchecked.map((r) => r.status));
  const vN = await call("GET", `${O(orgN)}/versions/${tv1.id}`, N.admin.token);
  check("5b. Textos de las casillas los fija el servidor (los de la misión)", vN.body.version?.acceptanceCheckboxText === "He leído el contrato completo, tuve oportunidad de descargarlo y acepto sus términos." && vN.body.version?.authorityDeclaration === "Declaro que tengo autoridad legal suficiente para representar y obligar contractualmente a esta agencia." && vN.body.version?.signer?.allowed === true && vN.body.version?.signer?.designation?.fullName === "Ana Ficticia Representante", vN.body.version?.signer);

  // ================================================================ Caso 6: código incorrecto y expirado
  const c6 = await call("POST", `${O(orgN)}/versions/${tv1.id}/signature-code`, N.admin.token, { contentSha256: sha256(tbody1), ...SIGN });
  const code6 = lastCode(N.admin.email);
  const wrong = await call("POST", `${O(orgN)}/versions/${tv1.id}/accept`, N.admin.token, { contentSha256: sha256(tbody1), ...SIGN, challengeId: c6.body.challengeId, code: code6 === "000000" ? "111111" : "000000" });
  await q(`SET session_replication_role = replica`);
  await q(`UPDATE contract_signature_challenges SET expires_at = now() - interval '1 minute', created_at = now() - interval '11 minutes' WHERE id=$1`, [c6.body.challengeId]);
  await q(`SET session_replication_role = origin`);
  const expired = await call("POST", `${O(orgN)}/versions/${tv1.id}/accept`, N.admin.token, { contentSha256: sha256(tbody1), ...SIGN, challengeId: c6.body.challengeId, code: code6 });
  check("6. Código incorrecto → 422; código expirado → 409 CONTRACT_CODE_EXPIRED; sin evidencia", c6.status === 201 && wrong.status === 422 && expired.status === 409 && expired.body.error === "CONTRACT_CODE_EXPIRED" && (await q(`SELECT count(*)::int n FROM organization_contract_acceptances WHERE organization_id=$1`, [orgN])).rows[0].n === 0, [c6.status, wrong.status, expired.body]);

  // ================================================================ Casos 7 y 8: aceptación válida y doble intento
  const c7 = await call("POST", `${O(orgN)}/versions/${tv1.id}/signature-code`, N.admin.token, { contentSha256: sha256(tbody1), ...SIGN });
  const code7 = lastCode(N.admin.email);
  const body7 = { contentSha256: sha256(tbody1), ...SIGN, challengeId: c7.body.challengeId, code: code7 };
  const race = await Promise.all([call("POST", `${O(orgN)}/versions/${tv1.id}/accept`, N.admin.token, body7), call("POST", `${O(orgN)}/versions/${tv1.id}/accept`, N.admin.token, body7)]);
  const ok7 = race.find((r) => r.status === 201);
  const ev = (await q(`SELECT * FROM organization_contract_acceptances WHERE id=$1`, [ok7?.body.acceptance?.id])).rows[0] ?? {};
  check("7. Aceptación válida con evidencia completa: agencia, representante y cargo, correo verificado, declaración, versión, huella, hora del servidor, id, casilla, método, descarga previa y designación",
    !!ok7 && ev.organization_id === orgN && ev.signer_full_name === "Ana Ficticia Representante" && ev.signer_title === "Presidenta (ficticia)" && ev.verified_email === N.admin.email
    && ev.authority_declaration === "Declaro que tengo autoridad legal suficiente para representar y obligar contractualmente a esta agencia." && ev.document_version_id === tv1.id && ev.content_sha256 === sha256(tbody1)
    && !!ev.accepted_at && !!ev.id && ev.acceptance_checkbox_text === "He leído el contrato completo, tuve oportunidad de descargarlo y acepto sus términos." && ev.consent_method === "CHECKBOXES_AND_EMAIL_CODE"
    && !!ev.document_downloaded_at && ev.signatory_designation_id === desN.body.signatory?.id, { status: race.map((r) => r.status) });
  const again = await sign(N.admin, orgN, tv1.id, sha256(tbody1));
  check("8. Doble intento de firma: con el mismo código a la vez, una 201 y otra 409; después, otra solicitud → 409 (ya aceptado); una sola evidencia", race.map((r) => r.status).sort().join(",") === "201,409" && again.req.status === 409 && again.req.body.error === "CONTRACT_ALREADY_ACCEPTED" && (await q(`SELECT count(*)::int n FROM organization_contract_acceptances WHERE organization_id=$1 AND document_version_id=$2`, [orgN, tv1.id])).rows[0].n === 1, [race.map((r) => r.status), again.req.status]);

  // ================================================================ Caso 11: acceso cruzado
  const xList = await call("GET", O(orgX), X.admin.token);
  const xGet = await call("GET", `${O(orgX)}/versions/${on.versionId}`, X.admin.token);
  const xOnN = await call("GET", `${O(orgN)}/versions/${on.versionId}`, X.admin.token);
  const desX = await call("POST", `${P_}/organizations/${orgX}/signatories`, central.token, { userId: X.admin.userId, fullName: "Xavier Ficticio Gerente", title: "Gerente (ficticio)", basis: "Formulario de alta ficticio" });
  const xCode = await call("POST", `${O(orgX)}/versions/${on.versionId}/signature-code`, X.admin.token, { contentSha256: on.contentSha256, ...SIGN });
  const xDb = await errCode((async () => { await q("BEGIN"); try {
    const id = randomUUID();
    await q(`INSERT INTO contract_signature_challenges (id,organization_id,document_version_id,user_id,code_hash) VALUES ($1,$2,$3,$4,repeat('f',64))`, [id, orgX, on.versionId, X.admin.userId]);
  } finally { await q("ROLLBACK"); } })());
  check("11. Acceso cruzado: la otra agencia no ve la Orden ajena (lista sin ella, 404), no entra por la ruta de N (403) ni puede firmarla (ni en la base: CONTRACT_VERSION_NOT_ACCEPTABLE)",
    !xList.body.contracts?.some((c: Json) => c.id === on.versionId) && xGet.status === 404 && xOnN.status === 403 && desX.status === 201 && [404, 409].includes(xCode.status) && xDb.includes("CONTRACT_VERSION_NOT_ACCEPTABLE"), [xGet.status, xOnN.status, xCode.status, xDb]);
  const xSig = await call("GET", `${O(orgX)}/signatories`, X.admin.token);
  check("11b. Cada agencia ve solo sus representantes designados", xSig.body.signatories?.length === 1 && xSig.body.signatories[0].user_id === X.admin.userId, xSig.body.signatories?.length);

  // ================================================================ Caso 9: agencia con contrato vigente
  const oN = await sign(N.admin, orgN, on.versionId, on.contentSha256);
  const st9 = await call("GET", `${O(orgN)}/status`, N.admin.token);
  check("9. Con el Contrato General y su Orden aceptados, la agencia queda «cumple» (0 pendientes)", oN.acc?.status === 201 && st9.body.status?.satisfied === true && st9.body.status?.pendingRequired === 0, [oN.acc?.status, st9.body.status]);

  // ================================================================ Caso 10: nueva versión
  const tbody2 = `${BANNER}\n\n1. Objeto (ficticio), versión 2 con cambios sustanciales.\n18. Cláusula final (ficticia).\n`;
  const tv2 = (await call("POST", `${P_}/documents/${tdoc.body.document.id}/versions`, central.token, { versionLabel: "2.0", body: tbody2 })).body.version;
  await call("POST", `${P_}/versions/${tv2.id}/publish`, central.token);
  const st10 = await call("GET", `${O(orgN)}/status`, N.admin.token);
  const hist10 = await call("GET", `${O(orgN)}/acceptances`, N.admin.token);
  const sN2 = await sign(N.admin, orgN, tv2.id, sha256(tbody2));
  const st10b = await call("GET", `${O(orgN)}/status`, N.admin.token);
  check("10. Nueva versión que exige aceptación: vuelve a «no cumple», la aceptación anterior se conserva; tras aceptar 2.0, «cumple» otra vez", st10.body.status?.satisfied === false && hist10.body.acceptances?.length === 2 && sN2.acc?.status === 201 && st10b.body.status?.satisfied === true && (await q(`SELECT count(*)::int n FROM organization_contract_acceptances WHERE organization_id=$1`, [orgN])).rows[0].n === 3, [st10.body.status?.satisfied, hist10.body.acceptances?.length, sN2.acc?.status, st10b.body.status?.satisfied]);

  // ================================================================ Caso 14: historial y constancias
  const hist = await call("GET", `${O(orgN)}/acceptances`, N.admin.token);
  const cert = await call("GET", `${O(orgN)}/acceptances/${ev.id}/certificate.pdf`, N.admin.token);
  const ct = cert.status === 200 ? await pdfText(cert.raw) : "";
  check("14. Historial con las 3 aceptaciones (casilla, método, descarga previa, designación) y constancia PDF con casilla, declaración, designación y descarga previa",
    hist.body.acceptances?.length === 3 && hist.body.acceptances.every((a: Json) => a.consent_method === "CHECKBOXES_AND_EMAIL_CODE" && a.designated_signatory === true)
    && cert.status === 200 && ct.includes("He leído el contrato completo, tuve oportunidad de descargarlo") && ct.includes("autoridad legal suficiente") && ct.includes("Representante designada por la organización ante ETNARA: sí") && ct.includes("Documento descargado antes de aceptar"), [hist.body.acceptances?.length, cert.status]);

  // ================================================================ Revocación de la designación
  const rev = await call("POST", `${P_}/organizations/${orgE}/signatories/${desE.body.signatory.id}/revoke`, central.token, { reason: "Cambio de representante (ficticio)" });
  const eCode = await call("POST", `${O(orgE)}/versions/${tv2.id}/signature-code`, E.admin.token, { contentSha256: sha256(tbody2), ...SIGN });
  const revImm = await errCode(q(`UPDATE organization_contract_signatories SET full_name='Otro Nombre' WHERE id=$1`, [desN.body.signatory.id]));
  check("S2. Con la designación revocada no se firma (403); las designaciones no se editan ni se borran", rev.status === 200 && eCode.status === 403 && eCode.body.error === "CONTRACT_SIGNATORY_NOT_DESIGNATED" && revImm.includes("IMMUTABLE") && (await errCode(q(`DELETE FROM organization_contract_signatories WHERE id=$1`, [desN.body.signatory.id])))
    .includes("IMMUTABLE"), [rev.status, eCode.status, revImm]);
  await call("POST", `${P_}/organizations/${orgE}/signatories`, central.token, { userId: E.admin.userId, fullName: "Eva Ficticia Directora", title: "Directora ejecutiva (ficticia)", basis: "Nueva designación ficticia" });

  // ================================================================ Caso 13 y reglas de acceso
  const POST_SHIFT = { careRecipientId: recipient, scheduledStart: new Date(Date.now() + 86_400_000).toISOString(), scheduledEnd: new Date(Date.now() + 90_000_000).toISOString() };
  const offShift = await call("POST", `/organizations/${orgE}/shifts`, E.admin.token, POST_SHIFT);
  check("R0. Reglas de acceso APAGADAS por defecto: aunque E no cumple, nada se bloquea por contrato", offShift.body.error !== "CONTRACT_ACCEPTANCE_REQUIRED", [offShift.status, offShift.body.error]);
  const short = await call("PUT", `${P_}/organizations/${orgE}/enforcement`, central.token, { mode: "restrict_new_operations", enforceFrom: new Date(Date.now() + 86_400_000).toISOString(), reason: "Aviso demasiado corto (prueba)" });
  const onlyE = await call("PUT", `${P_}/organizations/${orgE}/enforcement`, central.token, { mode: "contract_only", enforceFrom: new Date().toISOString(), reason: "No permitido con datos (prueba)" });
  const agencySets = await call("PUT", `${P_}/organizations/${orgE}/enforcement`, E.admin.token, { mode: "off", enforceFrom: null, reason: "Intento de la agencia" });
  const okE = await call("PUT", `${P_}/organizations/${orgE}/enforcement`, central.token, { mode: "restrict_new_operations", enforceFrom: new Date(Date.now() + 31 * 86_400_000).toISOString(), reason: "Transición con aviso de 31 días (prueba)" });
  check("R1. Transición: Central fija el modo (agencia 403); con datos exige ≥30 días de aviso (422) y no permite «solo contrato» (422)", short.status === 422 && short.body.error === "CONTRACT_ENFORCEMENT_NOTICE_TOO_SHORT" && onlyE.status === 422 && onlyE.body.error === "CONTRACT_ENFORCEMENT_MODE_NOT_ALLOWED" && agencySets.status === 403 && okE.status === 200 && okE.body.enforcement?.serverEnforcementEnabled === false, [short.status, onlyE.status, agencySets.status, okE.status]);
  // Solo en esta prueba: adelantar la fecha (simula que pasaron los 31 días) y encender el interruptor global.
  await q(`UPDATE organization_contract_enforcement SET enforce_from = now() - interval '1 minute' WHERE organization_id=$1`, [orgE]);
  const nOnly = await call("PUT", `${P_}/organizations/${orgX}/enforcement`, central.token, { mode: "notice", enforceFrom: null, reason: "Solo aviso (prueba)" });
  const newOrg = await org(`Agencia Recién Creada ${tag}`);
  const NA = await person("na-admin", newOrg, ["ORGANIZATION_ADMIN"]);
  NA.token = (await call("POST", "/auth/login", "", { email: NA.email, password })).body.token; await call("POST", "/me/active-organization", NA.token, { organizationId: newOrg });
  const coNew = await call("PUT", `${P_}/organizations/${newOrg}/enforcement`, central.token, { mode: "contract_only", enforceFrom: new Date(Date.now() - 1000).toISOString(), reason: "Agencia nueva sin datos (prueba)" });
  process.env.CONTRACTS_ENFORCEMENT = "on";
  const eStatus = await call("GET", `${O(orgE)}/status`, E.admin.token);
  const blocked = await call("POST", `/organizations/${orgE}/shifts`, E.admin.token, POST_SHIFT);
  const supBlocked = await call("POST", `/organizations/${orgE}/team/invitations`, E.sup.token, { email: "nadie@example.invalid" });
  const readOk = await call("GET", `/organizations/${orgE}/shifts`, E.admin.token);
  const contractOk = await call("GET", `${O(orgE)}/versions/${tv2.id}/document.txt`, E.admin.token);
  const checkIn = await call("POST", `/organizations/${orgE}/shifts/${shift}/check-in`, E.worker.token, { verificationMethodCode: "CAREGIVER_SESSION" });
  const myShifts = await call("GET", `/organizations/${orgE}/me/shifts`, E.worker.token);
  const famRead = await call("GET", `/organizations/${orgE}/contracts`, E.family.token);
  check("13. Encendido (solo en la prueba) en «restringir operación nueva»: crear turnos o invitar → 403 CONTRACT_ACCEPTANCE_REQUIRED; leer turnos, el contrato y el turno en curso del cuidador siguen (no 403 por contrato)",
    eStatus.body.status?.restricted === true && blocked.status === 403 && blocked.body.error === "CONTRACT_ACCEPTANCE_REQUIRED" && supBlocked.status === 403 && supBlocked.body.error === "CONTRACT_ACCEPTANCE_REQUIRED"
    && readOk.body.error !== "CONTRACT_ACCEPTANCE_REQUIRED" && readOk.status < 500 && contractOk.status === 200
    && checkIn.body.error !== "CONTRACT_ACCEPTANCE_REQUIRED" && checkIn.status < 500 && myShifts.status === 200 && famRead.body.error !== "CONTRACT_ACCEPTANCE_REQUIRED", [blocked.status, readOk.status, checkIn.status, myShifts.status]);
  const naBlocked = await call("POST", `/organizations/${newOrg}/team/invitations`, NA.token, { email: "nadie@example.invalid" });
  const naContracts = await call("GET", O(newOrg), NA.token);
  check("13b. Agencia recién creada sin datos en «solo contrato»: cualquier escritura fuera de contratos → 403; puede consultar sus contratos", coNew.status === 200 && naBlocked.status === 403 && naBlocked.body.error === "CONTRACT_ACCEPTANCE_REQUIRED" && naContracts.status === 200, [coNew.status, naBlocked.status, naContracts.status]);
  const xWrite = await call("POST", `/organizations/${orgX}/team/invitations`, X.admin.token, { email: "nadie@example.invalid" });
  const nWrite = await call("POST", `/organizations/${orgN}/shifts`, N.admin.token, POST_SHIFT);
  check("13c. No se afecta a otras agencias: X (solo aviso) y N (sin regla, cumple) no reciben bloqueos por contrato", nOnly.status === 200 && xWrite.body.error !== "CONTRACT_ACCEPTANCE_REQUIRED" && nWrite.body.error !== "CONTRACT_ACCEPTANCE_REQUIRED", [xWrite.status, nWrite.status]);
  // E acepta lo pendiente (incluida su Orden) y deja de estar restringida
  const eG = await sign(E.admin, orgE, tv2.id, sha256(tbody2), { ...SIGN, signerFullName: "Eva Ficticia Directora", signerTitle: "Directora ejecutiva (ficticia)" });
  const eO = await sign(E.admin, orgE, ordE.body.order.versionId, ordE.body.order.contentSha256, { ...SIGN, signerFullName: "Eva Ficticia Directora", signerTitle: "Directora ejecutiva (ficticia)" });
  const after = await call("POST", `/organizations/${orgE}/shifts`, E.admin.token, POST_SHIFT);
  check("13d. Al aceptar lo pendiente (firma permitida aun restringida), la restricción desaparece sola", eG.acc?.status === 201 && eO.acc?.status === 201 && after.body.error !== "CONTRACT_ACCEPTANCE_REQUIRED", [eG.req.status, eG.acc?.status, eO.acc?.status, after.status]);
  delete process.env.CONTRACTS_ENFORCEMENT;

  // ================================================================ Caso 12: suspensión y reactivación
  await q(`UPDATE organizations SET status='suspended' WHERE id=$1`, [orgN]);
  const susp = [await call("GET", O(orgN), N.admin.token), await call("GET", `${O(orgN)}/acceptances`, N.admin.token), await call("POST", `${O(orgN)}/versions/${tv2.id}/signature-code`, N.admin.token, { contentSha256: sha256(tbody2), ...SIGN })];
  await q(`UPDATE organizations SET status='active' WHERE id=$1`, [orgN]);
  const react = await call("GET", `${O(orgN)}/acceptances`, N.admin.token);
  const st12 = await call("GET", `${O(orgN)}/status`, N.admin.token);
  check("12. Suspendida: no consulta ni firma (403); reactivada: historial intacto (3) y sigue «cumple»", susp.every((r) => r.status === 403) && react.body.acceptances?.length === 3 && st12.body.status?.satisfied === true, [susp.map((r) => r.status), react.body.acceptances?.length]);

  // ================================================================ Integridad y auditoría
  const allA = (await q(`SELECT a.content_sha256 a, v.content_sha256 v, v.body FROM organization_contract_acceptances a JOIN contract_document_versions v ON v.id=a.document_version_id`)).rows;
  check("I1. Integridad: toda evidencia = huella de su versión = SHA-256 del texto aceptado", allA.length > 0 && allA.every((r) => r.a === r.v && r.v === sha256(r.body)), allA.length);
  const evImm = [await errCode(q(`UPDATE organization_contract_acceptances SET signer_title='x' WHERE id=$1`, [ev.id])), await errCode(q(`DELETE FROM contract_document_downloads`)), await errCode(q(`DELETE FROM organization_contract_signatories`))];
  check("I2. Evidencia, descargas y designaciones protegidas contra alteraciones (también el superusuario)", evImm.every((x) => x.includes("IMMUTABLE")), evImm);
  const actions = (await q(`SELECT action FROM audit_log WHERE action LIKE 'CONTRACT\\_%' GROUP BY 1`)).rows.map((r) => r.action);
  const need = ["CONTRACT_LEGAL_APPROVAL_RECORDED", "CONTRACT_COMMERCIAL_APPROVAL_RECORDED", "CONTRACT_SUBSCRIPTION_ORDER_TERMS_EDITED", "CONTRACT_SIGNATORY_DESIGNATED", "CONTRACT_SIGNATORY_REVOKED", "CONTRACT_SUBSCRIPTION_ORDER_DRAFTED", "CONTRACT_ENFORCEMENT_SET", "CONTRACT_VERSION_ACCEPTED", "CONTRACT_SIGNATURE_CODE_FAILED"];
  check("I3. Auditoría de aprobación jurídica, designación y revocación, Órdenes, reglas de acceso, firmas e intentos fallidos", need.every((a) => actions.includes(a)), actions);
  check("I4. Ningún correo salió a otra dirección que la cuenta de quien firma; ninguno a la administradora técnica", mails.length > 0 && mails.every((m) => [N.admin, E.admin, X.admin].some((p) => p.email === m.to)), mails.length);

  // ================================================================ Reversión
  const ROLLBACK_SQL = readFileSync(new URL("../ops/153_contract_saas_v1.rollback.sql", import.meta.url), "utf8");
  const counts = async () => (await q(`SELECT (SELECT count(*) FROM contract_documents)::int d, (SELECT count(*) FROM organization_contract_acceptances)::int a, (SELECT count(*) FROM organization_contract_signatories)::int s`)).rows[0];
  const b0 = await counts();
  const dry = await errCode(q(ROLLBACK_SQL.replace(/COMMIT;\s*$/, "ROLLBACK;")));
  await q("ROLLBACK").catch(() => undefined);
  check("RB1. Solo con evidencia de prueba, la reversión de 153 se ejecuta (ensayo deshecho; datos intactos)", dry === "ok" && JSON.stringify(await counts()) === JSON.stringify(b0), dry);
  // Evidencia oficial ficticia (documento no marcado como prueba, aprobado y publicado SOLO en esta base desechable).
  const fd = (await q<{ id: string }>(`INSERT INTO contract_documents (code,title,kind,is_test,created_by_user_id) VALUES ($1,'Documento ficticio no marcado (prueba de reversión)','OTHER',false,$2) RETURNING id`, [`FICTICIO_RB153_${tag}`, central.userId])).rows[0].id;
  const fv = (await q<{ id: string; content_sha256: string }>(`INSERT INTO contract_document_versions (document_id,version_label,body,content_sha256,is_test,created_by_user_id) VALUES ($1,'1.0','Texto ficticio sin valor legal, usado solo para comprobar que la reversión se niega.',repeat('0',64),false,$2) RETURNING id, content_sha256`, [fd, central.userId])).rows[0];
  await q(`UPDATE contract_document_versions SET legal_status='legally_approved', legal_approved_by_user_id=$2, legal_approval_reference='Referencia ficticia de prueba' WHERE id=$1`, [fv.id, central.userId]);
  await q(`UPDATE contract_document_versions SET status='published', published_by_user_id=$2 WHERE id=$1`, [fv.id, central.userId]);
  const b1 = await counts();
  const refused = await errCode(q(ROLLBACK_SQL));
  await q("ROLLBACK").catch(() => undefined);
  check("RB2. Con evidencia oficial (versión oficial aprobada y publicada), la reversión de 153 se NIEGA y no borra nada", refused.includes("CONTRACT_ROLLBACK_REFUSED_OFFICIAL_EVIDENCE") && JSON.stringify(await counts()) === JSON.stringify(b1), refused);

  server.close(); await pool.end(); await db.end();
  await srv.query(`DROP DATABASE ${own} WITH (FORCE)`); await srv.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` | ${r.detail}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error("VERIFY_ERROR", e); process.exit(1); });
