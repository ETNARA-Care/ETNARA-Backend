/**
 * Contrato Oficial v1.1 (156): Word original inmutable, aprobación jurídica ligada al archivo y
 * términos individuales por función tomados LITERALMENTE del Anexo E del contrato fuente.
 * La base garantiza la inmutabilidad, las huellas, el texto literal y los permisos (RLS + triggers);
 * este servicio ordena las operaciones y audita. Nada aquí bloquea operaciones ni cobra.
 */
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { withPlatformContext, withTenantContext } from "../../context/tenantContext.js";
import { ContractForbiddenError, ContractNotFoundError, ContractRuleError, audit, mapDbError, requireOrgAdmin } from "./contracts.service.js";
import { officialPublishingEnabled, testSigningEnabled } from "./contracts.rules.js";
import { renderContractDocumentPdf } from "./contractsPdf.js";
import { ROLE_TERMS_ROLES, ROLE_TITLE, legalReference, roleTermsFromAnnex, type RoleTermsRole } from "./contracts.roleTerms.js";

export const SOURCE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export { ROLE_TERMS_ROLES, legalReference, roleTermsFromAnnex, type RoleTermsRole } from "./contracts.roleTerms.js";

const RULES = new Set([
  "CONTRACT_SOURCE_FILE_IMMUTABLE", "CONTRACT_SOURCE_FILE_INVALID", "ROLE_TERMS_ANNEX_NOT_FOUND", "CONTRACT_SOURCE_FILE_MISMATCH", "CONTRACT_SOURCE_FILE_REQUIRED",
  "CONTRACT_LEGAL_APPROVAL_REFERENCE_INCOMPLETE", "ROLE_TERMS_IMMUTABLE", "ROLE_TERMS_MUST_START_AS_DRAFT", "ROLE_TERMS_SOURCE_INVALID",
  "ROLE_TERMS_TEXT_NOT_IN_CONTRACT", "ROLE_TERMS_INVALID_TRANSITION", "ROLE_TERMS_SOURCE_NOT_APPROVED", "ROLE_TERMS_ACCEPTANCE_IMMUTABLE",
]);
const UNPROCESSABLE = new Set(["ROLE_TERMS_ANNEX_NOT_FOUND", "CONTRACT_SOURCE_FILE_INVALID", "CONTRACT_SOURCE_FILE_MISMATCH", "ROLE_TERMS_TEXT_NOT_IN_CONTRACT", "ROLE_TERMS_SOURCE_INVALID"]);
const rethrow = (err: unknown): never => {
  if (err instanceof ContractRuleError || err instanceof ContractNotFoundError || err instanceof ContractForbiddenError) throw err;
  const e = err as { code?: string; message?: string; constraint?: string };
  const msg = e?.message ?? "";
  if (msg === "ROLE_TERMS_ROLE_MISMATCH") throw new ContractRuleError(msg, 403);
  if (RULES.has(msg)) throw new ContractRuleError(msg, UNPROCESSABLE.has(msg) ? 422 : 409);
  if (e?.code === "23505") {
    if (e.constraint === "user_role_terms_acceptances_once") throw new ContractRuleError("CONTRACT_ALREADY_ACCEPTED");
    if (e.constraint === "role_terms_versions_one_published") throw new ContractRuleError("CONTRACT_PUBLISH_CONFLICT");
    if (e.constraint === "role_terms_versions_label_unique") throw new ContractRuleError("CONTRACT_VERSION_LABEL_TAKEN");
    if (e.constraint === "contract_source_files_pkey") throw new ContractRuleError("CONTRACT_SOURCE_FILE_IMMUTABLE");
  }
  return mapDbError(err);
};
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

// ================================================================ Word original
/**
 * Central guarda el Word original de un borrador. El nombre y la huella deben ser los declarados en la
 * versión; si la versión aún no los declara (borrador sin aprobar), se fijan con este archivo.
 */
export async function platformUploadSourceFile(userId: string, versionId: string, fileName: string, content: Buffer) {
  if (!/^[^/\\]{1,195}\.docx$/i.test(fileName)) throw new ContractRuleError("CONTRACT_SOURCE_FILE_INVALID", 422);
  if (content.length < 100 || content.length > SOURCE_FILE_MAX_BYTES) throw new ContractRuleError("CONTRACT_SOURCE_FILE_INVALID", 422);
  const hash = sha256(content);
  return withPlatformContext(userId, async (trx) => {
    const v = (await sql<any>`SELECT id, status, source_file_name, source_file_sha256, legal_status FROM contract_document_versions WHERE id = ${versionId} FOR UPDATE`.execute(trx)).rows[0];
    if (!v) throw new ContractNotFoundError();
    if (v.status !== "draft") throw new ContractRuleError("CONTRACT_VERSION_IMMUTABLE");
    try {
      if (v.source_file_sha256 !== hash || v.source_file_name !== fileName) {
        if (v.source_file_sha256 && v.legal_status === "legally_approved") throw new ContractRuleError("CONTRACT_SOURCE_FILE_MISMATCH", 422);
        await sql`UPDATE contract_document_versions SET source_file_name = ${fileName}, source_file_sha256 = ${hash} WHERE id = ${versionId}`.execute(trx);
      }
      await sql`INSERT INTO contract_source_files (document_version_id, file_name, content, uploaded_by_user_id) VALUES (${versionId}, ${fileName}, ${content}, ${userId})`.execute(trx);
      await audit(trx, userId, null, "CONTRACT_SOURCE_FILE_STORED", "contract_document_version", versionId, { file_name: fileName, sha256: hash, byte_size: content.length });
      return (await sql<any>`SELECT document_version_id, file_name, byte_size, sha256, uploaded_at FROM contract_source_files WHERE document_version_id = ${versionId}`.execute(trx)).rows[0];
    } catch (err) { return rethrow(err); }
  });
}

/** Lee el Word y comprueba su integridad (la huella del contenido = la guardada = la de la versión). */
async function readVerifiedSourceFile(trx: Parameters<Parameters<typeof withPlatformContext>[1]>[0], versionId: string) {
  const f = (await sql<any>`SELECT f.file_name, f.sha256, f.content, v.source_file_sha256, v.version_label, d.code
    FROM contract_source_files f JOIN contract_document_versions v ON v.id = f.document_version_id JOIN contract_documents d ON d.id = v.document_id
    WHERE f.document_version_id = ${versionId}`.execute(trx)).rows[0];
  if (!f) throw new ContractNotFoundError();
  const content = Buffer.from(f.content);
  if (sha256(content) !== f.sha256 || f.sha256 !== f.source_file_sha256) throw new ContractRuleError("CONTRACT_SOURCE_FILE_INTEGRITY", 503);
  return { content, sha: f.sha256 as string, fileName: f.file_name as string, code: f.code as string, versionLabel: f.version_label as string };
}
const docxHeaders = (fileName: string, hash: string) => ({ "Content-Type": DOCX_TYPE, "Content-Disposition": `attachment; filename="${safeName(fileName)}"`, "X-Content-SHA256": hash });

export async function platformDownloadSourceFile(userId: string, versionId: string) {
  return withPlatformContext(userId, async (trx) => {
    const f = await readVerifiedSourceFile(trx, versionId);
    return { body: f.content, headers: docxHeaders(f.fileName, f.sha) };
  });
}

/** Word original de una versión vigente o retirada, para la administración de la agencia (queda registrado). */
export async function orgDownloadSourceFile(userId: string, organizationId: string, versionId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const f = await readVerifiedSourceFile(trx, versionId);
    await sql`INSERT INTO contract_document_downloads (organization_id, document_version_id, user_id, format) VALUES (${organizationId}, ${versionId}, ${userId}, 'docx')`.execute(trx);
    await audit(trx, userId, organizationId, "CONTRACT_SOURCE_FILE_DOWNLOADED", "contract_document_version", versionId, { sha256: f.sha });
    return { body: f.content, headers: docxHeaders(f.fileName, f.sha) };
  });
}

/** Datos del Word para mostrar en la pantalla del contrato (sin el contenido). */
export async function sourceFileSummary(trx: Parameters<Parameters<typeof withPlatformContext>[1]>[0], versionId: string) {
  return (await sql<any>`SELECT file_name, byte_size, sha256 FROM contract_source_files WHERE document_version_id = ${versionId}`.execute(trx)).rows[0] ?? null;
}

// ================================================================ aprobación jurídica con datos completos

/**
 * Registra la aprobación jurídica con nombre, fecha y referencia documental (no los completa nadie más
 * que Central). Antes verifica que el texto (huella) y el Word original guardado (huella) sean
 * exactamente los aprobados.
 */
export async function platformRecordVerifiedLegalApproval(userId: string, versionId: string, input: { approverName: string; approvedOn: string; documentReference: string; contentSha256: string; sourceFileSha256: string }) {
  const day = new Date(`${input.approvedOn}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== input.approvedOn || day.getTime() > Date.now() + 36 * 3600_000) throw new ContractRuleError("CONTRACT_LEGAL_APPROVAL_DATE_INVALID", 422);
  return withPlatformContext(userId, async (trx) => {
    const v = (await sql<any>`SELECT status, content_sha256, source_file_sha256 FROM contract_document_versions WHERE id = ${versionId} FOR UPDATE`.execute(trx)).rows[0];
    if (!v) throw new ContractNotFoundError();
    if (v.status !== "draft") throw new ContractRuleError("CONTRACT_VERSION_IMMUTABLE");
    if (v.content_sha256 !== input.contentSha256) throw new ContractRuleError("CONTRACT_CONTENT_MISMATCH");
    if (!v.source_file_sha256 || v.source_file_sha256 !== input.sourceFileSha256) throw new ContractRuleError("CONTRACT_SOURCE_FILE_MISMATCH", 422);
    await readVerifiedSourceFile(trx, versionId); // guardado e íntegro
    const reference = legalReference(input.approverName, input.approvedOn, input.documentReference);
    try {
      // Si ya tenía una aprobación (p. ej., sin datos completos), se reemplaza dentro del borrador.
      await sql`UPDATE contract_document_versions SET legal_status = 'pending_legal_approval' WHERE id = ${versionId} AND legal_status = 'legally_approved'`.execute(trx);
      await sql`UPDATE contract_document_versions SET legal_status = 'legally_approved', legal_approved_by_user_id = ${userId}, legal_approval_reference = ${reference} WHERE id = ${versionId}`.execute(trx);
      await audit(trx, userId, null, "CONTRACT_LEGAL_APPROVAL_RECORDED", "contract_document_version", versionId,
        { content_sha256: v.content_sha256, source_file_sha256: v.source_file_sha256, approver: input.approverName.trim(), approved_on: input.approvedOn, verified: true });
      return (await sql<any>`SELECT id, legal_status, legal_approved_at, legal_approved_sha256, legal_approved_source_sha256, legal_approval_reference FROM contract_document_versions WHERE id = ${versionId}`.execute(trx)).rows[0];
    } catch (err) { return rethrow(err); }
  });
}

// ================================================================ términos por función (Central)
const termsFields = sql.raw(`t.id, t.role, t.version_label, t.title, t.content_sha256, t.source_contract_version_id, t.is_test, t.status, t.legal_status,
  t.legal_approval_reference, t.legal_approved_at, t.legal_approved_sha256, t.created_at, t.published_at, t.retired_at`);

export async function platformListRoleTerms(userId: string) {
  return withPlatformContext(userId, async (trx) => (await sql<any>`SELECT ${termsFields}, t.body FROM role_terms_versions t ORDER BY t.role, t.created_at`.execute(trx)).rows);
}

export async function platformDraftRoleTermsFromAnnex(userId: string, sourceContractVersionId: string, versionLabel: string) {
  return withPlatformContext(userId, async (trx) => {
    const src = (await sql<any>`SELECT v.body FROM contract_document_versions v WHERE v.id = ${sourceContractVersionId}`.execute(trx)).rows[0];
    if (!src) throw new ContractNotFoundError();
    try {
      const created = [];
      for (const role of ROLE_TERMS_ROLES) {
        const body = roleTermsFromAnnex(src.body, role);
        const r = (await sql<any>`INSERT INTO role_terms_versions (role, version_label, title, body, content_sha256, source_contract_version_id, is_test, created_by_user_id)
          VALUES (${role}, ${versionLabel}, ${ROLE_TITLE[role]}, ${body}, repeat('0', 64), ${sourceContractVersionId}, false, ${userId}) RETURNING id`.execute(trx)).rows[0];
        await audit(trx, userId, null, "ROLE_TERMS_DRAFTED", "role_terms_version", r.id, { role, source_contract_version_id: sourceContractVersionId });
        created.push((await sql<any>`SELECT ${termsFields}, t.body FROM role_terms_versions t WHERE t.id = ${r.id}`.execute(trx)).rows[0]);
      }
      return created;
    } catch (err) { return rethrow(err); }
  });
}

export async function platformCreateRoleTerms(userId: string, input: { role: RoleTermsRole; versionLabel: string; title: string; body: string; sourceContractVersionId: string }) {
  return withPlatformContext(userId, async (trx) => {
    try {
      const r = (await sql<any>`INSERT INTO role_terms_versions (role, version_label, title, body, content_sha256, source_contract_version_id, is_test, created_by_user_id)
        VALUES (${input.role}, ${input.versionLabel}, ${input.title}, ${input.body}, repeat('0', 64), ${input.sourceContractVersionId}, false, ${userId}) RETURNING id`.execute(trx)).rows[0];
      await audit(trx, userId, null, "ROLE_TERMS_DRAFTED", "role_terms_version", r.id, { role: input.role, source_contract_version_id: input.sourceContractVersionId });
      return (await sql<any>`SELECT ${termsFields}, t.body FROM role_terms_versions t WHERE t.id = ${r.id}`.execute(trx)).rows[0];
    } catch (err) { return rethrow(err); }
  });
}

export async function platformUpdateRoleTermsDraft(userId: string, id: string, input: { title?: string; body?: string; versionLabel?: string }) {
  return withPlatformContext(userId, async (trx) => {
    const cur = (await sql<any>`SELECT status FROM role_terms_versions WHERE id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!cur) throw new ContractNotFoundError();
    if (cur.status !== "draft") throw new ContractRuleError("ROLE_TERMS_IMMUTABLE");
    try {
      await sql`UPDATE role_terms_versions SET title = COALESCE(${input.title ?? null}, title), body = COALESCE(${input.body ?? null}, body),
        version_label = COALESCE(${input.versionLabel ?? null}, version_label) WHERE id = ${id}`.execute(trx);
      await audit(trx, userId, null, "ROLE_TERMS_DRAFT_UPDATED", "role_terms_version", id, {});
      return (await sql<any>`SELECT ${termsFields}, t.body FROM role_terms_versions t WHERE t.id = ${id}`.execute(trx)).rows[0];
    } catch (err) { return rethrow(err); }
  });
}

/** Confirmación jurídica de que estos términos están comprendidos en la aprobación (sobre esta huella). */
export async function platformRecordRoleTermsLegalApproval(userId: string, id: string, reference: string, contentSha256: string) {
  return withPlatformContext(userId, async (trx) => {
    const t = (await sql<any>`SELECT status, content_sha256 FROM role_terms_versions WHERE id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!t) throw new ContractNotFoundError();
    if (t.status !== "draft") throw new ContractRuleError("ROLE_TERMS_IMMUTABLE");
    if (t.content_sha256 !== contentSha256) throw new ContractRuleError("CONTRACT_CONTENT_MISMATCH");
    try {
      await sql`UPDATE role_terms_versions SET legal_status = 'legally_approved', legal_approved_by_user_id = ${userId}, legal_approval_reference = ${reference} WHERE id = ${id}`.execute(trx);
      await audit(trx, userId, null, "ROLE_TERMS_LEGAL_APPROVAL_RECORDED", "role_terms_version", id, { content_sha256: contentSha256 });
      return (await sql<any>`SELECT ${termsFields} FROM role_terms_versions t WHERE t.id = ${id}`.execute(trx)).rows[0];
    } catch (err) { return rethrow(err); }
  });
}

export async function platformPublishRoleTerms(userId: string, id: string) {
  return withPlatformContext(userId, async (trx) => {
    const t = (await sql<any>`SELECT status, is_test FROM role_terms_versions WHERE id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!t) throw new ContractNotFoundError();
    if (t.status !== "draft") throw new ContractRuleError("ROLE_TERMS_IMMUTABLE");
    if (!t.is_test && !officialPublishingEnabled()) throw new ContractRuleError("CONTRACT_OFFICIAL_PUBLISHING_DISABLED", 422);
    try {
      await sql`UPDATE role_terms_versions SET status = 'published', published_by_user_id = ${userId} WHERE id = ${id}`.execute(trx);
      await audit(trx, userId, null, "ROLE_TERMS_PUBLISHED", "role_terms_version", id, { is_test: t.is_test });
      return (await sql<any>`SELECT ${termsFields} FROM role_terms_versions t WHERE t.id = ${id}`.execute(trx)).rows[0];
    } catch (err) { return rethrow(err); }
  });
}

export async function platformRetireRoleTerms(userId: string, id: string) {
  return withPlatformContext(userId, async (trx) => {
    try {
      const r = await sql`UPDATE role_terms_versions SET status = 'retired', retired_by_user_id = ${userId} WHERE id = ${id} AND status = 'published'`.execute(trx);
      if (!Number(r.numAffectedRows ?? 0)) throw new ContractRuleError("ROLE_TERMS_INVALID_TRANSITION");
      await audit(trx, userId, null, "ROLE_TERMS_RETIRED", "role_terms_version", id, {});
      return (await sql<any>`SELECT ${termsFields} FROM role_terms_versions t WHERE t.id = ${id}`.execute(trx)).rows[0];
    } catch (err) { return rethrow(err); }
  });
}

// ================================================================ términos por función (cada persona)
/**
 * Términos vigentes de las funciones que la persona tiene en esta agencia y si ya los aceptó.
 * Una versión nueva requiere una aceptación nueva; las anteriores se conservan en el historial.
 */
export async function myRoleTerms(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const roles: RoleTermsRole[] = [];
    for (const role of ROLE_TERMS_ROLES) {
      const ok = (await sql<{ ok: boolean }>`SELECT public.app_role_terms_user_has_role(${userId}, ${organizationId}, ${role}) AS ok`.execute(trx)).rows[0]?.ok;
      if (ok) roles.push(role);
    }
    const checkbox = (await sql<{ t: string }>`SELECT public.app_role_terms_checkbox_text() AS t`.execute(trx)).rows[0].t;
    if (!roles.length) return { roles, items: [], checkboxText: checkbox };
    const cur = (await sql<any>`SELECT ${termsFields}, t.body FROM role_terms_versions t WHERE t.status = 'published' AND t.role = ANY(${roles})`.execute(trx)).rows;
    const mine = (await sql<any>`SELECT id, terms_version_id, accepted_at FROM user_role_terms_acceptances WHERE user_id = ${userId} AND organization_id = ${organizationId}`.execute(trx)).rows;
    const items = cur.map((t) => {
      const a = mine.find((m) => m.terms_version_id === t.id);
      const testBlocked = t.is_test && !testSigningEnabled();
      return { ...t, accepted: !!a, acceptedAt: a?.accepted_at ?? null, acceptanceId: a?.id ?? null, acceptable: !a && !testBlocked, blockedReason: testBlocked ? "TEST_DOCUMENT" : null };
    });
    return { roles, items, checkboxText: checkbox };
  });
}

export async function acceptRoleTerms(userId: string, organizationId: string, termsId: string, contentSha256: string, meta: { ip: string | null; userAgent: string | null }) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const t = (await sql<any>`SELECT id, role, status, is_test, content_sha256 FROM role_terms_versions WHERE id = ${termsId}`.execute(trx)).rows[0];
    if (!t) throw new ContractNotFoundError();
    if (t.status !== "published") throw new ContractRuleError("CONTRACT_VERSION_NOT_ACCEPTABLE");
    if (t.is_test && !testSigningEnabled()) throw new ContractRuleError("CONTRACT_TEST_DOCUMENT_NOT_SIGNABLE");
    if (t.content_sha256 !== contentSha256) throw new ContractRuleError("CONTRACT_CONTENT_MISMATCH");
    try {
      const r = (await sql<any>`INSERT INTO user_role_terms_acceptances (user_id, organization_id, terms_version_id, content_sha256, ip_address, user_agent)
        VALUES (${userId}, ${organizationId}, ${termsId}, ${contentSha256}, ${meta.ip}::inet, ${meta.userAgent ? meta.userAgent.slice(0, 300) : null})
        RETURNING id, role, terms_version_id, content_sha256, is_test, accepted_at, acceptance_checkbox_text`.execute(trx)).rows[0];
      await audit(trx, userId, organizationId, "ROLE_TERMS_ACCEPTED", "user_role_terms_acceptance", r.id, { role: r.role, terms_version_id: termsId, content_sha256: contentSha256 });
      return r;
    } catch (err) { return rethrow(err); }
  });
}

/** Historial: la administración ve el de su agencia; las demás personas, solo el suyo (RLS). */
export async function listRoleTermsAcceptances(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => (await sql<any>`
    SELECT a.id, a.user_id, a.role, a.terms_version_id, a.content_sha256, a.is_test, a.accepted_login, a.acceptance_checkbox_text, a.accepted_at, t.version_label, t.title
      FROM user_role_terms_acceptances a JOIN role_terms_versions t ON t.id = a.terms_version_id
     WHERE a.organization_id = ${organizationId} ORDER BY a.accepted_at DESC`.execute(trx)).rows);
}

/** PDF íntegro de unos términos vigentes o retirados (para leerlos y guardarlos, E.1). */
export async function roleTermsPdf(userId: string, organizationId: string, termsId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const t = (await sql<any>`SELECT role, version_label, title, body, content_sha256, published_at, is_test FROM role_terms_versions WHERE id = ${termsId}`.execute(trx)).rows[0];
    if (!t) throw new ContractNotFoundError();
    const code = `TERMINOS_${t.role}`;
    const pdf = await renderContractDocumentPdf({ title: t.title, code, versionLabel: t.version_label, body: t.body, contentSha256: t.content_sha256, publishedAt: t.published_at, isTest: t.is_test });
    return { body: pdf, headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${safeName(`${code}-v${t.version_label}.pdf`)}"`, "X-Content-SHA256": t.content_sha256 as string } };
  });
}
