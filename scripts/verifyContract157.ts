/**
 * Interruptor «Contratos» por agencia (157). 21-nov-2026. Datos FICTICIOS, base PROPIA desechable,
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
  const own = `etnara_c157_${randomBytes(4).toString("hex")}`;
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
    const email = `c157-${key}-${tag.toLowerCase()}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const membership = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [membership, orgId, roles]);
    return { email, userId, token: "", membership, orgId };
  }
  const A = { rep: await person("a-rep", orgA, ["ORGANIZATION_ADMIN"]), tech: await person("a-tecnico", orgA, ["ORGANIZATION_ADMIN"]), worker: await person("a-cuidador", orgA, ["WORKER"]) };
  const B = { rep: await person("b-rep", orgB, ["ORGANIZATION_ADMIN"]), worker: await person("b-cuidador", orgB, ["WORKER"]) };
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

  // ---------------------------------------------------------------- estado inicial: apagado en todas
  const listFeat = await call("GET", `/platform/organizations/${orgA}/features`, central.token);
  const offA = await call("GET", O(orgA), A.rep.token);
  check("K0. «Contratos» aparece entre los interruptores de Central y está APAGADO por defecto: la agencia recibe 404 FEATURE_NOT_ENABLED",
    (listFeat.body.features ?? []).some((f: Json) => f.code === "CONTRACTS" && f.enabled === false) && offA.status === 404 && offA.body.error === "FEATURE_NOT_ENABLED", [listFeat.body.features, offA.status, offA.body]);
  const byAgency = await call("PUT", F(orgA), A.rep.token, { enabled: true, reason: "Intento de la propia agencia" });
  const noReason = await call("PUT", F(orgA), central.token, { enabled: true });
  const onA = await call("PUT", F(orgA), central.token, { enabled: true, reason: "Ensayo de contratos solo en Casa Demo (ficticio)" });
  check("K1. Solo Central lo enciende (agencia 403), con motivo obligatorio (400), y queda registrado",
    byAgency.status === 403 && noReason.status === 400 && onA.status === 200
    && (await q(`SELECT count(*)::int n FROM organization_feature_events WHERE organization_id=$1 AND feature_code='CONTRACTS' AND enabled AND reason LIKE 'Ensayo%'`, [orgA])).rows[0].n === 1, [byAgency.status, noReason.status, onA.status]);
  const meA = await call("GET", "/me", A.rep.token), meB = await call("GET", "/me", B.rep.token);
  const featsOf = (me: Json, o: string) => ((me.body.organizations ?? me.body.memberships ?? []) as Json[]).find((x) => (x.id ?? x.organizationId) === o)?.features ?? me.body.activeOrganization?.features ?? [];
  check("K2. /me: la agencia encendida trae CONTRACTS entre sus funciones; la apagada no", featsOf(meA, orgA).includes("CONTRACTS") && !featsOf(meB, orgB).includes("CONTRACTS"), [featsOf(meA, orgA), featsOf(meB, orgB)]);

  // ---------------------------------------------------------------- documento de prueba publicado (general)
  const BANNER = "DOCUMENTO FICTICIO DE PRUEBA — sin valor legal. No es el contrato oficial de ETNARA Care.";
  const ANNEX = ["ANEXO E — TÉRMINOS INDIVIDUALES POR FUNCIÓN", "E.1. Cláusula ficticia uno.", "E.2. Cláusula ficticia de administración.", "E.3. Cláusula ficticia de cuidadores.", "E.4. Cláusula ficticia de familiares.", "E.5. Cláusula ficticia común.", "E.6. Cláusula ficticia de cambios.", "E.7. Cláusula ficticia de evidencia.", "E.8. Cláusula ficticia de representación."];
  const tbody = [BANNER, "PRIMERA. Cláusula ficticia.", ...ANNEX].join("\n") + "\n";
  const td = await call("POST", `${P_}/documents`, central.token, { code: `TEST_CONTRATO_${tag}`, title: `[PRUEBA] Contrato ficticio ${tag}`, kind: "SERVICE_AGREEMENT", isTest: true, requiredForOperation: true });
  const tv = (await call("POST", `${P_}/documents/${td.body.document?.id}/versions`, central.token, { versionLabel: "1.0", body: tbody })).body.version;
  await call("POST", `${P_}/versions/${tv.id}/publish`, central.token);
  const drafts = await call("POST", `${P_}/role-terms/drafts-from-annex`, central.token, { sourceContractVersionId: tv.id, versionLabel: "1.0" });
  for (const t of drafts.body.roleTerms ?? []) await call("POST", `${P_}/role-terms/${t.id}/publish`, central.token);

  const aList = await call("GET", O(orgA), A.rep.token), bList = await call("GET", O(orgB), B.rep.token);
  const bView = await call("GET", `${O(orgB)}/versions/${tv.id}`, B.rep.token);
  const bPdf = await call("GET", `${O(orgB)}/versions/${tv.id}/document.pdf`, B.rep.token);
  const bCode = await call("POST", `${O(orgB)}/versions/${tv.id}/signature-code`, B.rep.token, { contentSha256: tv.content_sha256, ...SIGN });
  const bTerms = await call("GET", T(orgB), B.worker.token);
  const bStatus = await call("GET", `${O(orgB)}/status`, B.rep.token);
  check("K3. Agencia apagada: no ve la lista, el documento, el PDF, el estado ni los términos, y no puede pedir código (todo 404 FEATURE_NOT_ENABLED)",
    aList.status === 200 && (aList.body.contracts ?? []).length === 1
    && [bList, bView, bPdf, bCode, bTerms, bStatus].every((r) => r.status === 404 && r.body.error === "FEATURE_NOT_ENABLED"), [aList.status, bList.status, bView.status, bPdf.status, bCode.status, bTerms.status, bStatus.status]);
  const outsider = await call("GET", O(orgA), B.rep.token);
  check("K4. Aislamiento: quien no pertenece a la agencia recibe 403 (no 404), sin revelar si tiene el interruptor", outsider.status === 403, [outsider.status, outsider.body]);

  // ---------------------------------------------------------------- controles globales intactos
  const testNoSwitch = await call("POST", `${O(orgA)}/versions/${tv.id}/signature-code`, A.rep.token, { contentSha256: tv.content_sha256, ...SIGN });
  check("K5. El interruptor no salta CONTRACTS_TEST_SIGNING: un documento de prueba sigue sin poder firmarse (422)", testNoSwitch.status >= 400 && mails.length === 0, [testNoSwitch.status, testNoSwitch.body, mails.length]);
  const od = await call("POST", `${P_}/documents`, central.token, { code: `CONTRATO_ENSAYO_${tag}`, title: `Contrato General de ensayo ${tag}`, kind: "SERVICE_AGREEMENT", isTest: false });
  const ov = (await call("POST", `${P_}/documents/${od.body.document?.id}/versions`, central.token, { versionLabel: "1.1", body: [`CONTRATO GENERAL — ENSAYO LOCAL ${tag}`, "PRIMERA. Cláusula de ensayo.", ...ANNEX.map((l) => l.replace("ficticia", "de ensayo"))].join("\n") + "\n" })).body.version;
  process.env.CONTRACTS_OFFICIAL_PUBLISHING = "on";
  const pubNoLegal = await call("POST", `${P_}/versions/${ov.id}/publish`, central.token);
  delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
  const aSeesDraft = await call("GET", `${O(orgA)}/versions/${ov.id}`, A.rep.token);
  check("K6. Con el interruptor encendido, un oficial sin aprobación jurídica sigue sin publicarse (409) y su borrador no es visible para la agencia (404)",
    pubNoLegal.status === 409 && aSeesDraft.status === 404, [pubNoLegal.status, pubNoLegal.body.error, aSeesDraft.status]);
  // Publicado con aprobación verificada (ficticia) y Word: la administradora técnica sin designación sigue sin firmar.
  const word = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(2000)]);
  await call("POST", `${P_}/versions/${ov.id}/source-file`, central.token, word, { "X-File-Name": `Ensayo_${tag}.docx` });
  await call("POST", `${P_}/versions/${ov.id}/legal-approval`, central.token, { approverName: "Lcda. Abogada Ficticia de Ensayo", approvedOn: "2026-11-20", documentReference: "Aprobación ficticia de ensayo", contentSha256: ov.content_sha256, sourceFileSha256: sha256(word) });
  process.env.CONTRACTS_OFFICIAL_PUBLISHING = "on";
  const pubOk = await call("POST", `${P_}/versions/${ov.id}/publish`, central.token);
  delete process.env.CONTRACTS_OFFICIAL_PUBLISHING;
  const techTry = await call("POST", `${O(orgA)}/versions/${ov.id}/signature-code`, A.tech.token, { contentSha256: ov.content_sha256, ...SIGN });
  check("K7. El interruptor no sustituye la designación: sin representante designada nadie firma (403 NOT_DESIGNATED) y no sale ningún correo",
    pubOk.status === 200 && techTry.status === 403 && techTry.body.error === "CONTRACT_SIGNATORY_NOT_DESIGNATED" && mails.length === 0, [pubOk.status, techTry.status, techTry.body]);
  await call("POST", `${P_}/organizations/${orgA}/signatories`, central.token, { userId: A.rep.userId, fullName: "Ana Ficticia Representante", title: "Presidenta (ficticia)", basis: "Resolución corporativa ficticia de prueba" });
  await call("POST", `${P_}/organizations/${orgB}/signatories`, central.token, { userId: B.rep.userId, fullName: "Ana Ficticia Representante", title: "Presidenta (ficticia)", basis: "Resolución corporativa ficticia de prueba" });
  const req = await call("POST", `${O(orgA)}/versions/${ov.id}/signature-code`, A.rep.token, { contentSha256: ov.content_sha256, ...SIGN });
  const acc = await call("POST", `${O(orgA)}/versions/${ov.id}/accept`, A.rep.token, { contentSha256: ov.content_sha256, ...SIGN, challengeId: req.body.challengeId, code: lastCode(A.rep.email) });
  const accId = acc.body.acceptance?.id;
  const cert = await call("GET", `${O(orgA)}/acceptances/${accId}/certificate.pdf`, A.rep.token);
  const bDesigTry = await call("POST", `${O(orgB)}/versions/${ov.id}/signature-code`, B.rep.token, { contentSha256: ov.content_sha256, ...SIGN });
  check("K8. Casa Demo (encendida): la representante designada firma con código (201) y descarga su constancia; la agencia apagada, aun designada, no puede pedir código (404) ni recibe correo",
    acc.status === 201 && cert.status === 200 && bDesigTry.status === 404 && mails.length === 1 && mails[0].to === A.rep.email, [req.status, acc.status, cert.status, bDesigTry.status, mails.map((m) => m.to)]);
  const status = await call("GET", `${O(orgA)}/status`, A.rep.token);
  check("K9. Reglas de acceso siguen apagadas (sin CONTRACTS_ENFORCEMENT): servidor apagado, modo «off», nada restringido",
    status.body.status?.serverEnforcementEnabled === false && status.body.status?.restricted === false, status.body);

  // ---------------------------------------------------------------- global apagado manda
  delete process.env.CONTRACTS_MODULE;
  const globalOff = await call("GET", O(orgA), A.rep.token), globalOffT = await call("GET", T(orgA), A.worker.token), globalOffP = await call("GET", P_, central.token);
  process.env.CONTRACTS_MODULE = "on";
  check("K10. Con CONTRACTS_MODULE apagado, el interruptor encendido no abre nada: agencia, términos y Central responden 404",
    globalOff.status === 404 && globalOffT.status === 404 && globalOffP.status === 404, [globalOff.status, globalOffT.status, globalOffP.status]);

  // ---------------------------------------------------------------- apagar el interruptor
  const nAcc0 = (await q(`SELECT count(*)::int n FROM organization_contract_acceptances WHERE organization_id=$1`, [orgA])).rows[0].n;
  const off = await call("PUT", F(orgA), central.token, { enabled: false, reason: "Fin del ensayo (ficticio)" });
  const offList = await call("GET", O(orgA), A.rep.token), offCert = await call("GET", `${O(orgA)}/acceptances/${accId}/certificate.pdf`, A.rep.token);
  const offTerms = await call("GET", T(orgA), A.worker.token);
  const offAccept = await call("POST", `${T(orgA)}/${(drafts.body.roleTerms ?? [])[1]?.id}/accept`, A.worker.token, { contentSha256: (drafts.body.roleTerms ?? [])[1]?.content_sha256, confirm: true });
  const centralSees = await call("GET", `${P_}/versions/${ov.id}/acceptances`, central.token);
  const nAcc1 = (await q(`SELECT count(*)::int n FROM organization_contract_acceptances WHERE organization_id=$1`, [orgA])).rows[0].n;
  check("K11. Apagado: la agencia deja de ver y aceptar (404), pero la aceptación y la constancia siguen en la base y Central las ve",
    off.status === 200 && offList.status === 404 && offCert.status === 404 && offTerms.status === 404 && offAccept.status === 404
    && nAcc0 === 1 && nAcc1 === 1 && (centralSees.body.acceptances ?? []).length === 1, [off.status, offList.status, offCert.status, offTerms.status, offAccept.status, nAcc0, nAcc1, centralSees.status]);
  // La base también lo exige a la aplicación (aunque alguien saltara la ruta).
  const rt = new pg.Client({ connectionString: process.env.DATABASE_URL }); await rt.connect();
  const dbBlock = await errCode((async () => {
    await rt.query("BEGIN");
    try {
      await rt.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin','false',true)`, [A.rep.userId, orgA]);
      await rt.query(`INSERT INTO contract_document_downloads (organization_id,document_version_id,user_id,format) VALUES ($1,$2,$3,'pdf')`, [orgA, ov.id, A.rep.userId]);
    } finally { await rt.query("ROLLBACK"); }
  })());
  const dbBlockTerms = await errCode((async () => {
    await rt.query("BEGIN");
    try {
      await rt.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin','false',true)`, [A.worker.userId, orgA]);
      const t = (drafts.body.roleTerms ?? [])[1];
      await rt.query(`INSERT INTO user_role_terms_acceptances (user_id,organization_id,terms_version_id,content_sha256) VALUES ($1,$2,$3,$4)`, [A.worker.userId, orgA, t?.id, t?.content_sha256]);
    } finally { await rt.query("ROLLBACK"); }
  })());
  await rt.end();
  check("K12. Con el interruptor apagado, la base rechaza a la aplicación nuevas descargas registradas y aceptaciones (CONTRACT_ORGANIZATION_NOT_ENABLED)",
    dbBlock.includes("CONTRACT_ORGANIZATION_NOT_ENABLED") && dbBlockTerms.includes("CONTRACT_ORGANIZATION_NOT_ENABLED"), [dbBlock, dbBlockTerms]);
  const suUpd = await errCode(q(`UPDATE organization_contract_acceptances SET signer_title = 'x' WHERE organization_id=$1`, [orgA]));
  check("K13. Apagar no borra ni cambia evidencia: las aceptaciones siguen siendo inmutables", suUpd.includes("IMMUTABLE"), suUpd);
  const on2 = await call("PUT", F(orgA), central.token, { enabled: true, reason: "Reanudación del ensayo (ficticio)" });
  const cert2 = await call("GET", `${O(orgA)}/acceptances/${accId}/certificate.pdf`, A.rep.token);
  const events = (await q(`SELECT enabled, reason FROM organization_feature_events WHERE organization_id=$1 AND feature_code='CONTRACTS' ORDER BY occurred_at`, [orgA])).rows;
  check("K14. Al volver a encenderlo, la constancia anterior está intacta; la auditoría registra los tres cambios con su motivo",
    on2.status === 200 && cert2.status === 200 && cert2.raw.subarray(0, 4).toString() === "%PDF" && events.length === 3 && events.map((e) => e.enabled).join() === "true,false,true", [on2.status, cert2.status, events]);
  check("M1. Ningún correo real: solo el código ficticio interceptado de Casa Demo", mails.length === 1 && mails.every((m) => m.to.endsWith("@example.invalid")), mails.length);

  server.close(); await pool.end().catch(() => undefined); await db.end();
  await srv.query(`DROP DATABASE ${own} WITH (FORCE)`).catch(() => undefined); await srv.end();
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 600)}`}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`TOTAL ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 600)}`}`); console.error(e); process.exit(2); });
