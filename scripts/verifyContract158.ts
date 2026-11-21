/**
 * Herramientas de Central para contratos (158), sobre el interruptor por agencia (157). 21-nov-2026. Datos FICTICIOS, base PROPIA desechable,
 * ningún correo real (Resend interceptado). App real por HTTP como app_runtime.
 * Una agencia tipo Casa Demo con el interruptor encendido y otra con él apagado. Comprueba que el
 * interruptor solo decide QUÉ agencias usan el módulo y que no salta ningún control global
 * (CONTRACTS_MODULE, aprobación jurídica, publicación oficial, representante designada, código,
 * firmas de prueba, CONTRACTS_ENFORCEMENT); que apagarlo impide nuevas aceptaciones (también en la
 * base) sin borrar contratos ni constancias; aislamiento y auditoría.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const serverUrl = process.env.MIGRATIONS_DATABASE_URL;
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
  if (!/^https?:\/\/127\.0\.0\.1:/.test(url)) throw new Error(`Salida de red bloqueada en la prueba: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";

async function main() {
  const own = `etnara_c158_${randomBytes(4).toString("hex")}`;
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
  delete process.env.CONTRACTS_TEST_SIGNING;

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
    return { status: res.status, body: json, raw };
  }
  const org = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgA = await org(`Casa Demo Ficticia ${tag}`), orgB = await org(`Agencia Apagada Ficticia ${tag}`);
  type P = { email: string; userId: string; token: string; membership: string; orgId: string };
  async function person(key: string, orgId: string, roles: string[]): Promise<P> {
    const email = `c158-${key}-${tag.toLowerCase()}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const membership = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [membership, orgId, roles]);
    return { email, userId, token: "", membership, orgId };
  }
  const A = { rep: await person("a-rep", orgA, ["ORGANIZATION_ADMIN"]), tech: await person("a-tecnico", orgA, ["ORGANIZATION_ADMIN"]), worker: await person("a-cuidador", orgA, ["WORKER"]) };
  const B = { rep: await person("b-rep", orgB, ["ORGANIZATION_ADMIN"]), worker: await person("b-cuidador", orgB, ["WORKER"]) };
  const inactive = await person("a-admin-inactiva", orgA, ["ORGANIZATION_ADMIN"]);
  const central = await person("central", orgB, []);
  await q(`DELETE FROM organization_memberships WHERE id=$1`, [central.membership]);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.userId]);
  for (const p of [...Object.values(A), ...Object.values(B), central]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${p.email} ${r.status}`);
    p.token = r.body.token;
    if (p !== central) await call("POST", "/me/active-organization", p.token, { organizationId: p.orgId });
  }
  const P_ = "/platform/contracts", O = (o: string) => `/organizations/${o}/contracts`, T = (o: string) => `/organizations/${o}/role-terms`;
  const F = (o: string) => `/platform/organizations/${o}/features/CONTRACTS`;
  const lastCode = (email: string) => [...mails].reverse().find((m) => m.to === email)?.html.match(/>(\d{6})</)?.[1] ?? null;
  const SIGN = { signerFullName: "Ana Ficticia Representante", signerTitle: "Presidenta (ficticia)", confirmAuthority: true, confirm: true };


  // ---------------------------------------------------------------- ambas agencias con «Contratos» encendido
  await call("PUT", F(orgA), central.token, { enabled: true, reason: "Ensayo Central 158 (ficticio)" });
  await call("PUT", F(orgB), central.token, { enabled: true, reason: "Ensayo Central 158 (ficticio)" });
  await q(`UPDATE organization_memberships SET status='revoked' WHERE id=$1`, [inactive.membership]);
  const BANNER = "DOCUMENTO FICTICIO DE PRUEBA — PRUEBA — SIN VALOR CONTRACTUAL. No es el contrato oficial de ETNARA Care.";
  const tbody = [BANNER, "PRIMERA. Cláusula ficticia de ensayo.", "SEGUNDA. Cláusula ficticia de ensayo."].join("\n") + "\n";
  const auditN = async (action: string, org: string | null) => (await q(`SELECT count(*)::int n FROM audit_log WHERE action=$1 AND organization_id IS NOT DISTINCT FROM $2`, [action, org])).rows[0].n;

  // ---------------------------------------------------------------- C0: exclusivo de Central
  const agElig = await call("GET", `${P_}/organizations/${orgA}/eligible-signatories`, A.rep.token);
  const agDoc = await call("POST", `${P_}/documents`, A.rep.token, { code: `TEST_AG_${tag}`, title: `[PRUEBA] Intento ${tag}`, kind: "SERVICE_AGREEMENT", isTest: true, organizationId: orgA });
  const agDesig = await call("POST", `${P_}/organizations/${orgA}/signatories`, A.rep.token, { userId: A.rep.userId, fullName: "Ana Ficticia Representante", title: "Presidenta (ficticia)", basis: "Intento de la propia agencia" });
  check("C0. Solo Central: una administradora de agencia no lista elegibles, no crea documentos ni designa (403)",
    [agElig, agDoc, agDesig].every((r) => r.status === 403), [agElig.status, agDoc.status, agDesig.status]);

  // ---------------------------------------------------------------- C1: elegibles
  const elig = await call("GET", `${P_}/organizations/${orgA}/eligible-signatories`, central.token);
  const eligEmails = (elig.body.eligible ?? []).map((e: Json) => e.email).sort();
  check("C1. Elegibles = solo administradoras ACTIVAS de esa agencia (ni cuidadores, ni inactivas, ni otra agencia); solo cuenta y correo",
    elig.status === 200 && JSON.stringify(eligEmails) === JSON.stringify([A.rep.email, A.tech.email].sort())
    && (elig.body.eligible ?? []).every((e: Json) => Object.keys(e).sort().join() === "email,userId"), [elig.status, eligEmails]);

  // ---------------------------------------------------------------- C2/C3: documento de prueba dirigido a una agencia
  const docA = await call("POST", `${P_}/documents`, central.token, { code: `TEST_ENSAYO_${tag}`, title: `[PRUEBA] Ensayo ${tag} — SIN VALOR CONTRACTUAL`, kind: "SERVICE_AGREEMENT", isTest: true, organizationId: orgA });
  check("C2. Central crea un documento de prueba limitado a Casa Demo (201) y queda auditado con esa agencia",
    docA.status === 201 && docA.body.document?.organization_id === orgA && (await auditN("CONTRACT_DOCUMENT_CREATED", orgA)) === 1, [docA.status, docA.body]);
  const offScoped = await call("POST", `${P_}/documents`, central.token, { code: `CONTRATO_AG_${tag}`, title: `Contrato oficial dirigido ${tag}`, kind: "SERVICE_AGREEMENT", isTest: false, organizationId: orgA });
  const dbScoped = await errCode(q(`INSERT INTO contract_documents (code,title,kind,is_test,organization_id,created_by_user_id) VALUES ($1,$2,'SERVICE_AGREEMENT',false,$3,$4)`, [`CONTRATO_DB_${tag}`, `Oficial dirigido ${tag}`, orgA, central.userId]));
  const badOrg = await call("POST", `${P_}/documents`, central.token, { code: `TEST_NOORG_${tag}`, title: `[PRUEBA] Sin agencia ${tag}`, kind: "SERVICE_AGREEMENT", isTest: true, organizationId: randomUUID() });
  const badMark = await call("POST", `${P_}/documents`, central.token, { code: `ENSAYO_${tag}`, title: `Ensayo sin marcas ${tag}`, kind: "SERVICE_AGREEMENT", isTest: true, organizationId: orgA });
  check("C3. Un documento OFICIAL no puede dirigirse a una agencia (API 422 y base 23514); agencia inexistente 404; sin marcas de prueba 422",
    offScoped.status === 422 && offScoped.body.error === "CONTRACT_SCOPE_TEST_ONLY" && dbScoped.startsWith("23514") && badOrg.status === 404 && badMark.status === 422,
    [offScoped.status, offScoped.body.error, dbScoped, badOrg.status, badMark.status]);
  const verA = (await call("POST", `${P_}/documents/${docA.body.document?.id}/versions`, central.token, { versionLabel: "1.0", body: tbody })).body.version;
  const pubA = await call("POST", `${P_}/versions/${verA?.id}/publish`, central.token);
  const badBody = await call("POST", `${P_}/documents/${docA.body.document?.id}/versions`, central.token, { versionLabel: "1.1", body: "Texto sin la marca obligatoria de documento ficticio de prueba en el inicio." });
  check("C3b. Publicar el documento de prueba no requiere aprobación jurídica ni publicación oficial (200); un texto sin la marca DOCUMENTO FICTICIO se rechaza",
    pubA.status === 200 && pubA.body.version?.status === "published" && badBody.status >= 400, [pubA.status, badBody.status, badBody.body.error]);

  // ---------------------------------------------------------------- C4: aislamiento entre agencias (ambas encendidas)
  const aL = await call("GET", O(orgA), A.rep.token), bL = await call("GET", O(orgB), B.rep.token);
  const bV = await call("GET", `${O(orgB)}/versions/${verA.id}`, B.rep.token), bPdf = await call("GET", `${O(orgB)}/versions/${verA.id}/document.pdf`, B.rep.token);
  const ov = await call("GET", `${P_}/overview`, central.token);
  const ovA = (ov.body.organizations ?? []).find((o: Json) => o.organizationId === orgA), ovB = (ov.body.organizations ?? []).find((o: Json) => o.organizationId === orgB);
  check("C4. Aislamiento: con «Contratos» encendido en las dos, solo Casa Demo ve el documento; la otra no lo lista ni lo abre (404); el estado de Central lo refleja",
    (aL.body.contracts ?? []).some((c: Json) => c.id === verA.id) && !(bL.body.contracts ?? []).some((c: Json) => c.id === verA.id) && bV.status === 404 && bPdf.status === 404
    && ovA?.contracts.some((c: Json) => c.versionId === verA.id && c.state === "pending") && !ovB?.contracts.some((c: Json) => c.versionId === verA.id),
    [aL.status, bL.status, bV.status, bPdf.status]);

  // ---------------------------------------------------------------- C5: representantes
  const desW = await call("POST", `${P_}/organizations/${orgA}/signatories`, central.token, { userId: A.worker.userId, fullName: "Cuidador Ficticio Uno", title: "Cuidador", basis: "No debería poder designarse" });
  const desB = await call("POST", `${P_}/organizations/${orgA}/signatories`, central.token, { userId: B.rep.userId, fullName: "Otra Agencia Ficticia", title: "Presidenta", basis: "No pertenece a esta agencia" });
  const desA = await call("POST", `${P_}/organizations/${orgA}/signatories`, central.token, { userId: A.rep.userId, fullName: "Ana Ficticia Representante", title: "Presidenta (ficticia)", basis: "Designación de ensayo (cuenta de prueba)" });
  const desDup = await call("POST", `${P_}/organizations/${orgA}/signatories`, central.token, { userId: A.rep.userId, fullName: "Ana Ficticia Representante", title: "Presidenta (ficticia)", basis: "Designación de ensayo (cuenta de prueba)" });
  const sigList = await call("GET", `${P_}/organizations/${orgA}/signatories`, central.token), sigListB = await call("GET", `${P_}/organizations/${orgB}/signatories`, central.token);
  check("C5. Central designa a la representante (201, auditado); no a un cuidador ni a alguien de otra agencia (422); no duplica (409); cada agencia ve solo las suyas",
    desA.status === 201 && desW.status === 422 && desB.status === 422 && desDup.status === 409 && (sigList.body.signatories ?? []).length === 1 && (sigListB.body.signatories ?? []).length === 0
    && (await auditN("CONTRACT_SIGNATORY_DESIGNATED", orgA)) === 1, [desA.status, desW.status, desB.status, desDup.status]);

  // ---------------------------------------------------------------- C6: firma de prueba (solo con CONTRACTS_TEST_SIGNING)
  const noTS = await call("POST", `${O(orgA)}/versions/${verA.id}/signature-code`, A.rep.token, { contentSha256: verA.content_sha256, ...SIGN });
  process.env.CONTRACTS_TEST_SIGNING = "on";
  const techTry = await call("POST", `${O(orgA)}/versions/${verA.id}/signature-code`, A.tech.token, { contentSha256: verA.content_sha256, ...SIGN });
  const bTry = await call("POST", `${O(orgB)}/versions/${verA.id}/signature-code`, B.rep.token, { contentSha256: verA.content_sha256, ...SIGN });
  const req = await call("POST", `${O(orgA)}/versions/${verA.id}/signature-code`, A.rep.token, { contentSha256: verA.content_sha256, ...SIGN });
  const acc = await call("POST", `${O(orgA)}/versions/${verA.id}/accept`, A.rep.token, { contentSha256: verA.content_sha256, ...SIGN, challengeId: req.body.challengeId, code: lastCode(A.rep.email) });
  delete process.env.CONTRACTS_TEST_SIGNING;
  const accId = acc.body.acceptance?.id;
  check("C6. Sin firmas de prueba no se firma; con ellas: la administradora no designada no firma (403), la otra agencia tampoco (≠201), la representante sí (201, marcada como prueba) con un único correo a su cuenta",
    noTS.status >= 400 && techTry.status === 403 && bTry.status !== 201 && acc.status === 201 && acc.body.acceptance?.is_test === true && mails.length === 1 && mails[0].to === A.rep.email,
    [noTS.status, techTry.status, bTry.status, req.status, acc.status, mails.map((m) => m.to)]);

  // ---------------------------------------------------------------- C7: consulta de estado y aceptaciones en Central
  const list = await call("GET", P_, central.token);
  const dA = (list.body.documents ?? []).find((d: Json) => d.id === docA.body.document?.id);
  const accs = await call("GET", `${P_}/versions/${verA.id}/acceptances`, central.token);
  const ov2 = await call("GET", `${P_}/overview`, central.token);
  const ovA2 = (ov2.body.organizations ?? []).find((o: Json) => o.organizationId === orgA);
  check("C7. Central consulta: el documento muestra su agencia y 1 aceptación; la lista de aceptaciones trae firmante, método y huella; el estado pasa a «aceptado»",
    dA?.organization_id === orgA && dA?.organization_name?.startsWith("Casa Demo") && dA?.versions?.[0]?.acceptances === 1
    && (accs.body.acceptances ?? []).length === 1 && accs.body.acceptances[0].verification_method === "EMAIL_CODE" && accs.body.acceptances[0].content_sha256 === verA.content_sha256
    && ovA2?.contracts.some((c: Json) => c.versionId === verA.id && c.state === "accepted"), [dA, accs.body, ovA2]);

  // ---------------------------------------------------------------- C8: retirar sin borrar evidencias
  const shortReason = await call("POST", `${P_}/versions/${verA.id}/retire`, central.token, { reason: "x" });
  const agRetire = await call("POST", `${P_}/versions/${verA.id}/retire`, A.rep.token, { reason: "Intento de la agencia" });
  const ret = await call("POST", `${P_}/versions/${verA.id}/retire`, central.token, { reason: "Fin del ensayo de firma en Casa Demo" });
  const reRet = await call("POST", `${P_}/versions/${verA.id}/retire`, central.token, { reason: "Fin del ensayo de firma en Casa Demo" });
  const auditRet = (await q(`SELECT new_value FROM audit_log WHERE action='CONTRACT_VERSION_RETIRED' AND entity_id=$1 AND organization_id=$2`, [verA.id, orgA])).rows;
  const aL2 = await call("GET", O(orgA), A.rep.token), hist = await call("GET", `${O(orgA)}/acceptances`, A.rep.token);
  const cert = await call("GET", `${O(orgA)}/acceptances/${accId}/certificate.pdf`, A.rep.token);
  const nRows = (await q(`SELECT (SELECT count(*) FROM contract_document_versions WHERE id=$1)::int v, (SELECT count(*) FROM organization_contract_acceptances WHERE document_version_id=$1)::int a`, [verA.id])).rows[0];
  check("C8. Retirar: motivo corto 400, agencia 403; Central retira (200) con motivo auditado; no se puede retirar dos veces; deja de estar vigente pero versión, aceptación y constancia siguen",
    shortReason.status === 400 && agRetire.status === 403 && ret.status === 200 && ret.body.version?.status === "retired" && reRet.status === 409
    && auditRet.length === 1 && auditRet[0].new_value?.reason === "Fin del ensayo de firma en Casa Demo"
    && !(aL2.body.contracts ?? []).some((c: Json) => c.id === verA.id) && (hist.body.acceptances ?? []).some((h: Json) => h.id === accId && h.version_status === "retired")
    && cert.status === 200 && cert.raw.subarray(0, 4).toString() === "%PDF" && nRows.v === 1 && nRows.a === 1,
    [shortReason.status, agRetire.status, ret.status, reRet.status, auditRet, nRows]);
  const delTry = await errCode(q(`DELETE FROM contract_documents WHERE id=$1`, [docA.body.document?.id]));
  check("C8b. El documento retirado sigue siendo inmutable (no se puede borrar)", delTry.includes("IMMUTABLE"), delTry);

  // ---------------------------------------------------------------- C9: revocar representante
  const revShort = await call("POST", `${P_}/organizations/${orgA}/signatories/${desA.body.signatory?.id}/revoke`, central.token, { reason: "x" });
  const rev = await call("POST", `${P_}/organizations/${orgA}/signatories/${desA.body.signatory?.id}/revoke`, central.token, { reason: "Fin del ensayo de firma" });
  const rev2 = await call("POST", `${P_}/organizations/${orgA}/signatories/${desA.body.signatory?.id}/revoke`, central.token, { reason: "Fin del ensayo de firma" });
  const revOther = await call("POST", `${P_}/organizations/${orgB}/signatories/${desA.body.signatory?.id}/revoke`, central.token, { reason: "Agencia equivocada" });
  check("C9. Revocar con motivo (200, auditado); sin motivo suficiente 400; una sola vez; desde otra agencia no (404/409); la aceptación anterior se conserva",
    revShort.status === 400 && rev.status === 200 && rev2.status >= 400 && revOther.status >= 400 && (await auditN("CONTRACT_SIGNATORY_REVOKED", orgA)) === 1
    && (await q(`SELECT count(*)::int n FROM organization_contract_acceptances WHERE id=$1`, [accId])).rows[0].n === 1, [revShort.status, rev.status, rev2.status, revOther.status]);

  // ---------------------------------------------------------------- C10: compatibilidad
  const gdoc = await call("POST", `${P_}/documents`, central.token, { code: `TEST_GENERAL_${tag}`, title: `[PRUEBA] General ${tag}`, kind: "SERVICE_AGREEMENT", isTest: true });
  const gver = (await call("POST", `${P_}/documents/${gdoc.body.document?.id}/versions`, central.token, { versionLabel: "1.0", body: tbody })).body.version;
  await call("POST", `${P_}/versions/${gver?.id}/publish`, central.token);
  const gA = await call("GET", O(orgA), A.rep.token), gB = await call("GET", O(orgB), B.rep.token);
  const gRet = await call("POST", `${P_}/versions/${gver?.id}/retire`, central.token);
  check("C10. Compatibilidad: un documento de prueba sin agencia sigue siendo general (lo ven ambas) y retirar sin motivo sigue funcionando",
    gdoc.status === 201 && gdoc.body.document?.organization_id === null && (gA.body.contracts ?? []).some((c: Json) => c.id === gver.id) && (gB.body.contracts ?? []).some((c: Json) => c.id === gver.id) && gRet.status === 200,
    [gdoc.status, gA.status, gB.status, gRet.status]);

  // ---------------------------------------------------------------- C11: interruptor por agencia sigue mandando
  await call("PUT", F(orgA), central.token, { enabled: false, reason: "Fin del ensayo Central 158 (ficticio)" });
  const offL = await call("GET", O(orgA), A.rep.token), offHist = await call("GET", `${O(orgA)}/acceptances`, A.rep.token);
  const centralStill = await call("GET", `${P_}/versions/${verA.id}/acceptances`, central.token);
  check("C11. Con «Contratos» apagado: la agencia no ve contratos (404) pero conserva su historial en solo lectura; Central sigue viendo la evidencia",
    offL.status === 404 && offHist.status === 200 && (offHist.body.acceptances ?? []).length === 1 && (centralStill.body.acceptances ?? []).length === 1, [offL.status, offHist.status, centralStill.status]);

  // ---------------------------------------------------------------- C12: reversión
  const rb = await errCode(q((await import("node:fs")).readFileSync(join(process.cwd(), "ops/158_contracts_central_admin.rollback.sql"), "utf8")));
  await q("ROLLBACK").catch(() => undefined);
  check("C12. La reversión de 158 se niega si ya existen documentos de prueba dirigidos a una agencia (evidencia)", rb.includes("ROLLBACK_158_REFUSED"), rb);
  check("M1. Ningún correo real: solo el código ficticio interceptado de Casa Demo", mails.length === 1 && mails.every((m) => m.to.endsWith("@example.invalid")), mails.length);

  server.close(); await pool.end().catch(() => undefined); await db.end();
  await srv.query(`DROP DATABASE ${own} WITH (FORCE)`).catch(() => undefined); await srv.end();
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 600)}`}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`TOTAL ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 600)}`}`); console.error(e); process.exit(2); });
