/**
 * Módulo contractual, Etapas 1 y 2 (152). Documentos y versiones que publica ETNARA Central y evidencia
 * de aceptación por agencia. La base garantiza la inmutabilidad, la huella y los permisos (RLS +
 * triggers); este servicio solo ordena las operaciones y audita.
 *
 * Interruptores (por defecto apagados; no hay bloqueos de ningún tipo en esta etapa):
 *   CONTRACTS_MODULE=on               habilita las rutas (si no, responden 404);
 *   CONTRACTS_OFFICIAL_PUBLISHING=on  permite publicar un documento NO marcado como prueba.
 */
import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { Database } from "../../config/db.js";
import { withPlatformContext, withTenantContext } from "../../context/tenantContext.js";
import { loadEmailConfig, sendContractSignatureCodeEmail } from "../email/email.service.js";
import { renderAcceptanceCertificatePdf, renderContractDocumentPdf } from "./contractsPdf.js";

import { acceptanceStatement, officialPublishingEnabled, type ContractSigner } from "./contracts.rules.js";
export { acceptanceStatement, contractsModuleEnabled } from "./contracts.rules.js";

export class ContractNotFoundError extends Error { constructor() { super("CONTRACT_NOT_FOUND"); } }
export class ContractForbiddenError extends Error { constructor() { super("CONTRACT_FORBIDDEN"); } }
/** Reglas de la base o del flujo, con un código estable para la respuesta (409/422). */
export class ContractRuleError extends Error {
  constructor(public code: string, public status: 409 | 422 | 429 | 503 = 409, public extra: Record<string, unknown> = {}) { super(code); }
}

type Trx = Transaction<Database>;
const DB_RULES = new Set([
  "CONTRACT_VERSION_IMMUTABLE", "CONTRACT_DOCUMENT_IMMUTABLE", "CONTRACT_ACCEPTANCE_IMMUTABLE", "CONTRACT_VERSION_NOT_ACCEPTABLE",
  "CONTRACT_CONTENT_MISMATCH", "CONTRACT_TEST_BANNER_REQUIRED", "CONTRACT_OFFICIAL_CANNOT_BE_MARKED_TEST",
  "CONTRACT_VERSION_INVALID_TRANSITION", "CONTRACT_ACCEPTANCE_ADMIN_REQUIRED",
  "CONTRACT_CODE_NOT_USABLE", "CONTRACT_IDENTITY_NOT_VERIFIED", "CONTRACT_SIGNER_EMAIL_REQUIRED", "CONTRACT_CHALLENGE_IMMUTABLE",
]);
/** Traduce los errores de la base a errores de dominio sin exponer su texto. */
function mapDbError(err: unknown): never {
  const e = err as { code?: string; message?: string; constraint?: string };
  const msg = e?.message ?? "";
  if (msg === "CONTRACT_ACCEPTANCE_ADMIN_REQUIRED" || msg === "CONTRACT_IDENTITY_NOT_VERIFIED" || (e?.code === "42501" && /row-level security/.test(msg))) throw new ContractForbiddenError();
  if (DB_RULES.has(msg)) throw new ContractRuleError(msg, msg === "CONTRACT_TEST_BANNER_REQUIRED" || msg === "CONTRACT_OFFICIAL_CANNOT_BE_MARKED_TEST" ? 422 : 409);
  if (e?.code === "23505") {
    if (e.constraint === "organization_contract_acceptances_once") throw new ContractRuleError("CONTRACT_ALREADY_ACCEPTED");
    if (e.constraint === "contract_document_versions_label_unique") throw new ContractRuleError("CONTRACT_VERSION_LABEL_TAKEN");
    if (e.constraint === "contract_documents_code_key") throw new ContractRuleError("CONTRACT_CODE_TAKEN");
    if (e.constraint === "contract_document_versions_one_published") throw new ContractRuleError("CONTRACT_PUBLISH_CONFLICT");
  }
  if (e?.code === "23514") throw new ContractRuleError("CONTRACT_INVALID_DOCUMENT", 422);
  throw err;
}
const audit = (trx: Trx, actor: string, org: string | null, action: string, entityType: string, entityId: string, value: Record<string, unknown>) =>
  sql`INSERT INTO audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
      VALUES (${actor}, ${org}, ${org}, ${action}, ${entityType}, ${entityId}, ${JSON.stringify(value)}::jsonb)`.execute(trx);

const versionFields = sql.raw(`v.id, v.document_id, v.version_label, v.status, v.is_test, v.requires_new_acceptance, v.content_sha256,
  v.created_at, v.published_at, v.retired_at, length(v.body) AS body_length`);

// ------------------------------------------------------------------ ETNARA Central
export async function platformListContracts(userId: string) {
  return withPlatformContext(userId, async (trx) => {
    const docs = await sql<any>`SELECT id, code, title, kind, is_test, created_at FROM contract_documents ORDER BY created_at`.execute(trx);
    const versions = await sql<any>`SELECT ${versionFields},
        (SELECT count(*)::int FROM organization_contract_acceptances a WHERE a.document_version_id = v.id) AS acceptances
      FROM contract_document_versions v ORDER BY v.created_at`.execute(trx);
    return docs.rows.map((d) => ({ ...d, versions: versions.rows.filter((v) => v.document_id === d.id) }));
  });
}

export async function platformCreateDocument(userId: string, input: { code: string; title: string; kind: string; isTest: boolean }) {
  return withPlatformContext(userId, async (trx) => {
    try {
      const r = await sql<any>`INSERT INTO contract_documents (code, title, kind, is_test, created_by_user_id)
        VALUES (${input.code}, ${input.title}, ${input.kind}, ${input.isTest}, ${userId})
        RETURNING id, code, title, kind, is_test, created_at`.execute(trx);
      await audit(trx, userId, null, "CONTRACT_DOCUMENT_CREATED", "contract_document", r.rows[0].id, { code: input.code, kind: input.kind, is_test: input.isTest });
      return r.rows[0];
    } catch (err) { mapDbError(err); }
  });
}

export async function platformCreateVersion(userId: string, documentId: string, input: { versionLabel: string; body: string; requiresNewAcceptance?: boolean }) {
  return withPlatformContext(userId, async (trx) => {
    const doc = await sql<any>`SELECT id FROM contract_documents WHERE id = ${documentId}`.execute(trx);
    if (!doc.rows[0]) throw new ContractNotFoundError();
    try {
      const r = await sql<any>`INSERT INTO contract_document_versions (document_id, version_label, body, content_sha256, is_test, requires_new_acceptance, created_by_user_id)
        VALUES (${documentId}, ${input.versionLabel}, ${input.body}, repeat('0', 64), false, ${input.requiresNewAcceptance ?? true}, ${userId})
        RETURNING id`.execute(trx);
      // La huella y la marca de prueba las fija la base: se lee la fila tal como quedó.
      const v = (await sql<any>`SELECT ${versionFields} FROM contract_document_versions v WHERE v.id = ${r.rows[0].id}`.execute(trx)).rows[0];
      await audit(trx, userId, null, "CONTRACT_VERSION_DRAFTED", "contract_document_version", v.id, { document_id: documentId, version_label: v.version_label, content_sha256: v.content_sha256 });
      return v;
    } catch (err) { mapDbError(err); }
  });
}

export async function platformUpdateDraft(userId: string, versionId: string, input: { versionLabel?: string; body?: string; requiresNewAcceptance?: boolean }) {
  return withPlatformContext(userId, async (trx) => {
    const cur = await sql<any>`SELECT status FROM contract_document_versions WHERE id = ${versionId} FOR UPDATE`.execute(trx);
    if (!cur.rows[0]) throw new ContractNotFoundError();
    try {
      await sql`UPDATE contract_document_versions
        SET body = COALESCE(${input.body ?? null}, body), version_label = COALESCE(${input.versionLabel ?? null}, version_label),
            requires_new_acceptance = COALESCE(${input.requiresNewAcceptance ?? null}::boolean, requires_new_acceptance)
        WHERE id = ${versionId}`.execute(trx);
      const v = (await sql<any>`SELECT ${versionFields} FROM contract_document_versions v WHERE v.id = ${versionId}`.execute(trx)).rows[0];
      await audit(trx, userId, null, "CONTRACT_VERSION_DRAFT_EDITED", "contract_document_version", versionId, { version_label: v.version_label, content_sha256: v.content_sha256 });
      return v;
    } catch (err) { mapDbError(err); }
  });
}

/** Publica un borrador. La versión vigente anterior del mismo documento pasa a «retirada». */
export async function platformPublishVersion(userId: string, versionId: string) {
  return withPlatformContext(userId, async (trx) => {
    const cur = await sql<any>`SELECT v.id, v.document_id, v.status, v.is_test FROM contract_document_versions v WHERE v.id = ${versionId} FOR UPDATE`.execute(trx);
    const v = cur.rows[0];
    if (!v) throw new ContractNotFoundError();
    if (v.status !== "draft") throw new ContractRuleError("CONTRACT_VERSION_IMMUTABLE");
    // Etapa 1: el contrato oficial NO se publica. Solo documentos de prueba, salvo interruptor explícito.
    if (!v.is_test && !officialPublishingEnabled()) throw new ContractRuleError("CONTRACT_OFFICIAL_PUBLISHING_DISABLED", 422);
    try {
      // Serializa las publicaciones del mismo documento (como mucho una versión vigente).
      await sql`SELECT pg_advisory_xact_lock(hashtext('contract_document:' || ${v.document_id}::text))`.execute(trx);
      const prev = await sql<any>`UPDATE contract_document_versions SET status = 'retired', retired_by_user_id = ${userId}
        WHERE document_id = ${v.document_id} AND status = 'published' RETURNING id`.execute(trx);
      await sql`UPDATE contract_document_versions SET status = 'published', published_by_user_id = ${userId} WHERE id = ${versionId}`.execute(trx);
      const out = (await sql<any>`SELECT ${versionFields} FROM contract_document_versions v WHERE v.id = ${versionId}`.execute(trx)).rows[0];
      for (const p of prev.rows) await audit(trx, userId, null, "CONTRACT_VERSION_RETIRED", "contract_document_version", p.id, { replaced_by: versionId });
      await audit(trx, userId, null, "CONTRACT_VERSION_PUBLISHED", "contract_document_version", versionId, { document_id: v.document_id, content_sha256: out.content_sha256, is_test: out.is_test });
      return out;
    } catch (err) { mapDbError(err); }
  });
}

export async function platformRetireVersion(userId: string, versionId: string) {
  return withPlatformContext(userId, async (trx) => {
    const cur = await sql<any>`SELECT status FROM contract_document_versions WHERE id = ${versionId} FOR UPDATE`.execute(trx);
    if (!cur.rows[0]) throw new ContractNotFoundError();
    if (cur.rows[0].status !== "published") throw new ContractRuleError("CONTRACT_VERSION_INVALID_TRANSITION");
    try {
      await sql`UPDATE contract_document_versions SET status = 'retired', retired_by_user_id = ${userId} WHERE id = ${versionId}`.execute(trx);
      await audit(trx, userId, null, "CONTRACT_VERSION_RETIRED", "contract_document_version", versionId, {});
      return (await sql<any>`SELECT ${versionFields} FROM contract_document_versions v WHERE v.id = ${versionId}`.execute(trx)).rows[0];
    } catch (err) { mapDbError(err); }
  });
}

/** Quién aceptó una versión (metadatos de la evidencia; ningún dato de residentes ni del personal). */
export async function platformListAcceptances(userId: string, versionId: string) {
  return withPlatformContext(userId, async (trx) => {
    const v = await sql<any>`SELECT id FROM contract_document_versions WHERE id = ${versionId}`.execute(trx);
    if (!v.rows[0]) throw new ContractNotFoundError();
    const r = await sql<any>`SELECT organization_id, organization_name, accepted_by_login, accepted_role, signer_full_name, signer_title, verification_method, accepted_at, content_sha256, is_test
      FROM organization_contract_acceptances WHERE document_version_id = ${versionId} ORDER BY accepted_at`.execute(trx);
    return r.rows;
  });
}

/**
 * Estado contractual de cada agencia (activa o en prueba) frente a cada versión vigente: aceptada
 * (versión, fecha y representante), cubierta por una aceptación anterior que no exige renovarse,
 * o pendiente. Solo metadatos de la evidencia. Informativo: no bloquea a nadie.
 */
export async function platformContractOverview(userId: string) {
  return withPlatformContext(userId, async (trx) => {
    const current = (await sql<any>`SELECT ${versionFields}, d.code, d.title FROM contract_document_versions v
      JOIN contract_documents d ON d.id = v.document_id WHERE v.status = 'published' ORDER BY d.created_at`.execute(trx)).rows;
    const orgs = (await sql<any>`SELECT id, name, status FROM organizations WHERE archived_at IS NULL AND status IN ('active', 'trial') ORDER BY name`.execute(trx)).rows;
    const acc = (await sql<any>`SELECT a.organization_id, a.document_version_id, v.document_id, v.version_label, v.published_at, a.accepted_at,
        a.signer_full_name, a.signer_title, a.accepted_by_login
      FROM organization_contract_acceptances a JOIN contract_document_versions v ON v.id = a.document_version_id
      ORDER BY a.accepted_at`.execute(trx)).rows;
    return {
      documents: current.map((v) => ({ documentId: v.document_id, code: v.code, title: v.title, versionId: v.id, versionLabel: v.version_label, isTest: v.is_test, requiresNewAcceptance: v.requires_new_acceptance })),
      organizations: orgs.map((o) => ({
        organizationId: o.id, name: o.name, status: o.status,
        contracts: current.map((v) => {
          const mine = acc.filter((a) => a.organization_id === o.id && a.document_id === v.document_id);
          const exact = mine.find((a) => a.document_version_id === v.id);
          const last = mine[mine.length - 1];
          const state = exact ? "accepted" : last && !v.requires_new_acceptance ? "covered" : "pending";
          const shown = exact ?? last;
          return {
            versionId: v.id, state,
            accepted: shown ? { versionLabel: shown.version_label, acceptedAt: shown.accepted_at, signerFullName: shown.signer_full_name, signerTitle: shown.signer_title } : null,
          };
        }),
      })),
    };
  });
}

// ------------------------------------------------------------------ Agencia (solo ORGANIZATION_ADMIN)
async function requireOrgAdmin(trx: Trx) {
  const r = await sql<{ ok: boolean }>`SELECT public.app_is_org_admin() AS ok`.execute(trx);
  if (!r.rows[0]?.ok) throw new ContractForbiddenError();
}

/**
 * Documentos vigentes y su estado para la agencia. No bloquea nada: solo informa.
 *   accepted  aceptó esta versión;
 *   pending   no la aceptó y debe hacerlo (nunca aceptó el documento, o la versión nueva lo exige);
 *   covered   aceptó una versión anterior y esta no exige una nueva aceptación.
 */
export async function orgListContracts(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const cur = (await sql<any>`SELECT d.id AS document_id, d.code, d.title, d.kind, ${versionFields}
      FROM contract_document_versions v JOIN contract_documents d ON d.id = v.document_id
      WHERE v.status = 'published' ORDER BY d.created_at`.execute(trx)).rows;
    const mine = (await sql<any>`SELECT a.document_version_id, v.document_id, v.version_label, a.accepted_at, a.signer_full_name, a.signer_title, a.id AS acceptance_id
      FROM organization_contract_acceptances a JOIN contract_document_versions v ON v.id = a.document_version_id
      WHERE a.organization_id = ${organizationId} ORDER BY a.accepted_at`.execute(trx)).rows;
    return cur.map((v) => {
      const docAcc = mine.filter((a) => a.document_id === v.document_id);
      const exact = docAcc.find((a) => a.document_version_id === v.id);
      const prev = docAcc.filter((a) => a.document_version_id !== v.id).pop();
      const acceptance = exact ? "accepted" : prev && !v.requires_new_acceptance ? "covered" : "pending";
      return {
        ...v, acceptance,
        isNewVersion: !exact && !!prev,
        currentAcceptance: exact ? { id: exact.acceptance_id, acceptedAt: exact.accepted_at, signerFullName: exact.signer_full_name, signerTitle: exact.signer_title } : null,
        previousAcceptance: prev ? { id: prev.acceptance_id, versionLabel: prev.version_label, acceptedAt: prev.accepted_at } : null,
      };
    });
  });
}

export async function orgGetVersion(userId: string, organizationId: string, versionId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const r = await sql<any>`SELECT ${versionFields}, v.body, d.code, d.title, d.kind,
        o.name AS organization_name
      FROM contract_document_versions v JOIN contract_documents d ON d.id = v.document_id
      JOIN organizations o ON o.id = ${organizationId}
      WHERE v.id = ${versionId}`.execute(trx);
    const v = r.rows[0];
    if (!v) throw new ContractNotFoundError();
    // Lo que la representante debe confirmar antes de aceptar (el texto de la declaración lo fija la base).
    const decl = (await sql<{ t: string }>`SELECT public.app_contract_authority_declaration() AS t`.execute(trx)).rows[0].t;
    return { ...v, authorityDeclaration: decl, acceptanceStatementTemplate: acceptanceStatement(v.organization_name, v.title, v.version_label, v.content_sha256, { fullName: "{nombre completo}", title: "{cargo}" }) };
  });
}

const CODE_TTL_LIMIT_PER_HOUR = 5;
const RESEND_SECONDS = 60;
const codeHash = (challengeId: string, code: string) => createHash("sha256").update(`${challengeId}:${code}`, "utf8").digest("hex");
export const maskEmail = (email: string) => {
  const at = email.lastIndexOf("@");
  const user = at > 0 ? email.slice(0, at) : email, domain = at > 0 ? email.slice(at + 1) : "";
  return `${user.slice(0, 1)}${"•".repeat(Math.max(1, Math.min(6, user.length - 1)))}@${domain}`;
};

async function loadAcceptableVersion(trx: Trx, organizationId: string, versionId: string, contentSha256: string) {
  const v = (await sql<any>`SELECT v.id, v.version_label, v.status, v.content_sha256, d.title, o.name AS organization_name
    FROM contract_document_versions v JOIN contract_documents d ON d.id = v.document_id JOIN organizations o ON o.id = ${organizationId}
    WHERE v.id = ${versionId}`.execute(trx)).rows[0];
  if (!v) throw new ContractNotFoundError();
  if (v.status !== "published") throw new ContractRuleError("CONTRACT_VERSION_NOT_ACCEPTABLE");
  if (v.content_sha256 !== contentSha256) throw new ContractRuleError("CONTRACT_CONTENT_MISMATCH");
  const done = (await sql<any>`SELECT 1 FROM organization_contract_acceptances WHERE organization_id = ${organizationId} AND document_version_id = ${versionId}`.execute(trx)).rows[0];
  if (done) throw new ContractRuleError("CONTRACT_ALREADY_ACCEPTED");
  return v;
}

/**
 * Paso 1 de la firma: envía un código de 6 dígitos al correo de la cuenta de la representante.
 * Antes comprueba lo mismo que la firma (administradora activa, versión vigente, huella del texto
 * visto, aún no aceptada). Límites: un envío por minuto y 5 por hora para esa versión.
 */
export async function orgRequestSignatureCode(userId: string, organizationId: string, versionId: string, contentSha256: string) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const challengeId = randomUUID();
  const prepared = await withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const v = await loadAcceptableVersion(trx, organizationId, versionId, contentSha256);
    const recent = (await sql<{ n: number; last: string | null }>`SELECT count(*)::int AS n, max(created_at) AS last FROM contract_signature_challenges
      WHERE user_id = ${userId} AND document_version_id = ${versionId} AND created_at > now() - interval '1 hour'`.execute(trx)).rows[0];
    if (recent.last && Date.now() - new Date(recent.last).getTime() < RESEND_SECONDS * 1000) {
      throw new ContractRuleError("CONTRACT_CODE_RESEND_TOO_SOON", 429, { retryAfterSeconds: Math.ceil(RESEND_SECONDS - (Date.now() - new Date(recent.last).getTime()) / 1000) });
    }
    if (recent.n >= CODE_TTL_LIMIT_PER_HOUR) throw new ContractRuleError("CONTRACT_CODE_RATE_LIMITED", 429, { retryAfterSeconds: 3600 });
    try {
      const c = (await sql<any>`INSERT INTO contract_signature_challenges (id, organization_id, document_version_id, user_id, code_hash)
        VALUES (${challengeId}, ${organizationId}, ${versionId}, ${userId}, ${codeHash(challengeId, code)})
        RETURNING email, expires_at`.execute(trx)).rows[0];
      await audit(trx, userId, organizationId, "CONTRACT_SIGNATURE_CODE_REQUESTED", "contract_signature_challenge", challengeId, { document_version_id: versionId });
      return { email: c.email as string, expiresAt: c.expires_at as string, title: v.title as string, versionLabel: v.version_label as string, organizationName: v.organization_name as string };
    } catch (err) { mapDbError(err); }
  });
  // El correo se envía fuera de la transacción; el resultado se anota en el código.
  const sent = await sendContractSignatureCodeEmail({ recipientEmail: prepared!.email, code, organizationName: prepared!.organizationName, documentTitle: prepared!.title, versionLabel: prepared!.versionLabel }, loadEmailConfig());
  await withTenantContext({ userId, organizationId }, (trx) =>
    sql`UPDATE contract_signature_challenges SET delivery_status = ${sent.status === "sent" ? "sent" : "failed"} WHERE id = ${challengeId}`.execute(trx));
  if (sent.status !== "sent") throw new ContractRuleError("CONTRACT_CODE_DELIVERY_FAILED", 503);
  return { challengeId, emailMasked: maskEmail(prepared!.email), expiresAt: prepared!.expiresAt, resendAfterSeconds: RESEND_SECONDS };
}

/**
 * Paso 2: firma. Comprueba el código (5 intentos, 10 minutos, un solo uso) y, en la MISMA
 * transacción, lo consume y guarda la evidencia ligada a él. Un código equivocado suma un intento
 * (se guarda aunque la firma falle).
 */
export async function orgAcceptVersion(userId: string, organizationId: string, versionId: string, contentSha256: string, signer: ContractSigner,
  verification: { challengeId: string; code: string }, meta: { ip?: string | null; userAgent?: string | null }) {
  const outcome = await withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const v = await loadAcceptableVersion(trx, organizationId, versionId, contentSha256);
    const c = (await sql<any>`SELECT id, document_version_id, code_hash, attempts, expires_at, consumed_at, delivery_status
      FROM contract_signature_challenges WHERE id = ${verification.challengeId} FOR UPDATE`.execute(trx)).rows[0];
    if (!c || c.document_version_id !== versionId) return { error: "CONTRACT_CODE_INVALID" } as const;
    if (c.consumed_at) return { error: "CONTRACT_CODE_ALREADY_USED" } as const;
    if (c.delivery_status !== "sent") return { error: "CONTRACT_CODE_INVALID" } as const;
    if (new Date(c.expires_at).getTime() <= Date.now()) return { error: "CONTRACT_CODE_EXPIRED" } as const;
    if (c.attempts >= 5) return { error: "CONTRACT_CODE_TOO_MANY_ATTEMPTS" } as const;
    const ok = timingSafeEqual(Buffer.from(codeHash(c.id, verification.code)), Buffer.from(c.code_hash));
    if (!ok) {
      await sql`UPDATE contract_signature_challenges SET attempts = attempts + 1 WHERE id = ${c.id}`.execute(trx);
      await audit(trx, userId, organizationId, "CONTRACT_SIGNATURE_CODE_FAILED", "contract_signature_challenge", c.id, { attempt: c.attempts + 1 });
      return { error: "CONTRACT_CODE_INVALID", attemptsLeft: 4 - c.attempts } as const;
    }
    const ip = meta.ip && /^[0-9a-fA-F:.]{3,45}$/.test(meta.ip) ? meta.ip : null;
    const ua = meta.userAgent ? meta.userAgent.slice(0, 300) : null;
    try {
      await sql`UPDATE contract_signature_challenges SET consumed_at = now() WHERE id = ${c.id}`.execute(trx);
      const r = await sql<any>`INSERT INTO organization_contract_acceptances
          (organization_id, document_version_id, content_sha256, accepted_by_user_id, signer_full_name, signer_title, acceptance_statement, ip_address, user_agent, verification_challenge_id)
        VALUES (${organizationId}, ${versionId}, ${contentSha256}, ${userId}, ${signer.fullName}, ${signer.title},
                ${acceptanceStatement(v.organization_name, v.title, v.version_label, v.content_sha256, signer)}, ${ip}::inet, ${ua}, ${c.id})
        RETURNING id, organization_id, document_version_id, content_sha256, is_test, accepted_by_login, accepted_role, signer_full_name, signer_title,
                  authority_declaration, organization_name, acceptance_statement, accepted_at, verification_method, verified_email`.execute(trx);
      await audit(trx, userId, organizationId, "CONTRACT_VERSION_ACCEPTED", "organization_contract_acceptance", r.rows[0].id,
        { document_version_id: versionId, content_sha256: r.rows[0].content_sha256, is_test: r.rows[0].is_test, verification: "EMAIL_CODE" });
      return { acceptance: { ...r.rows[0], verified_email: maskEmail(r.rows[0].verified_email) } } as const;
    } catch (err) { mapDbError(err); }
  });
  if (outcome && "error" in outcome) {
    const code: string = outcome.error ?? "CONTRACT_CODE_INVALID";
    throw new ContractRuleError(code, code === "CONTRACT_CODE_INVALID" ? 422 : 409, "attemptsLeft" in outcome ? { attemptsLeft: outcome.attemptsLeft } : {});
  }
  return outcome!.acceptance;
}

export async function orgListAcceptances(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const r = await sql<any>`SELECT a.id, a.document_version_id, v.version_label, d.code, d.title, a.content_sha256, a.is_test,
        a.accepted_by_login, a.accepted_role, a.signer_full_name, a.signer_title, a.authority_declaration,
        a.acceptance_statement, a.accepted_at, a.verification_method, v.status AS version_status
      FROM organization_contract_acceptances a
      JOIN contract_document_versions v ON v.id = a.document_version_id JOIN contract_documents d ON d.id = v.document_id
      WHERE a.organization_id = ${organizationId} ORDER BY a.accepted_at`.execute(trx);
    return r.rows;
  });
}

/** PDF o texto exacto de una versión vigente o retirada (para leerla y descargarla antes de aceptar). */
export async function orgDocumentFile(userId: string, organizationId: string, versionId: string, format: "pdf" | "txt") {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const v = (await sql<any>`SELECT v.version_label, v.body, v.content_sha256, v.published_at, v.is_test, d.title, d.code
      FROM contract_document_versions v JOIN contract_documents d ON d.id = v.document_id WHERE v.id = ${versionId}`.execute(trx)).rows[0];
    if (!v) throw new ContractNotFoundError();
    const base = `${v.code}-v${v.version_label}`.replace(/[^A-Za-z0-9._-]/g, "_");
    // Cabeceras construidas aquí, dentro del contexto de la agencia (como facturación e informes).
    const headers = (fileName: string, contentType: string) => ({ "Content-Type": contentType, "Content-Disposition": `attachment; filename="${fileName}"`, "X-Content-SHA256": v.content_sha256 as string });
    if (format === "txt") return { body: Buffer.from(v.body, "utf8"), headers: headers(`${base}.txt`, "text/plain; charset=utf-8") };
    const pdf = await renderContractDocumentPdf({ title: v.title, code: v.code, versionLabel: v.version_label, body: v.body, contentSha256: v.content_sha256, publishedAt: v.published_at, isTest: v.is_test });
    return { body: pdf, headers: headers(`${base}.pdf`, "application/pdf") };
  });
}

/** Constancia PDF de una aceptación de la propia agencia. */
export async function orgAcceptanceCertificate(userId: string, organizationId: string, acceptanceId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const a = (await sql<any>`SELECT a.*, host(a.ip_address) AS ip_text, v.version_label, d.title, d.code
      FROM organization_contract_acceptances a JOIN contract_document_versions v ON v.id = a.document_version_id JOIN contract_documents d ON d.id = v.document_id
      WHERE a.id = ${acceptanceId} AND a.organization_id = ${organizationId}`.execute(trx)).rows[0];
    if (!a) throw new ContractNotFoundError();
    const pdf = await renderAcceptanceCertificatePdf({
      id: a.id, organizationName: a.organization_name, title: a.title, code: a.code, versionLabel: a.version_label, contentSha256: a.content_sha256, isTest: a.is_test,
      signerFullName: a.signer_full_name, signerTitle: a.signer_title, authorityDeclaration: a.authority_declaration, acceptanceStatement: a.acceptance_statement,
      acceptedByLogin: a.accepted_by_login, verifiedEmail: maskEmail(a.verified_email), verificationMethod: a.verification_method, acceptedAt: a.accepted_at, ipAddress: a.ip_text,
    });
    const fileName = `constancia-${String(a.code).replace(/[^A-Za-z0-9._-]/g, "_")}-v${a.version_label}.pdf`.replace(/[^A-Za-z0-9._-]/g, "_");
    return { body: pdf, headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${fileName}"` } };
  });
}
