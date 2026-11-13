/**
 * Contrato SaaS v1.0 (153): aprobación jurídica, vista previa para Central, representantes
 * designados, Orden de Suscripción por agencia y reglas de acceso (apagadas). Reutiliza la
 * infraestructura de 152 (versiones, huella, código por correo, evidencia, constancia).
 * No crea cobros, suscripciones ni bloqueos activos.
 */
import { sql } from "kysely";
import { withPlatformContext, withTenantContext } from "../../context/tenantContext.js";
import { ContractNotFoundError, ContractRuleError, audit, mapDbError, requireOrgAdmin } from "./contracts.service.js";
import { contractsEnforcementEnabled, MIN_NOTICE_DAYS, type EnforcementMode } from "./contracts.enforcement.js";

const rethrow = (err: unknown): never => { if (err instanceof ContractRuleError || err instanceof ContractNotFoundError) throw err; return mapDbError(err); };

// ---------------------------------------------------------------- Central: vista previa y aprobación jurídica
/** Texto completo de cualquier versión (también borradores) para revisión en Central. Sin datos de agencias. */
export async function platformGetVersion(userId: string, versionId: string) {
  return withPlatformContext(userId, async (trx) => {
    const v = (await sql<any>`SELECT v.id, v.document_id, v.version_label, v.status, v.is_test, v.requires_new_acceptance, v.content_sha256, v.body,
        v.legal_status, v.legal_approved_at, v.legal_approval_reference, v.legal_approved_sha256, v.source_file_name, v.source_file_sha256,
        v.commercial_terms, v.published_at, d.code, d.title, d.kind, d.organization_id, d.required_for_operation
      FROM contract_document_versions v JOIN contract_documents d ON d.id = v.document_id WHERE v.id = ${versionId}`.execute(trx)).rows[0];
    if (!v) throw new ContractNotFoundError();
    return v;
  });
}

/**
 * Registra la aprobación jurídica de un borrador (referencia escrita: quién, cuándo, documento).
 * Vale solo para el texto exacto (huella) aprobado; si el borrador cambia, la base la anula.
 * No publica: publicar un documento oficial sigue exigiendo CONTRACTS_OFFICIAL_PUBLISHING=on.
 */
export async function platformRecordLegalApproval(userId: string, versionId: string, reference: string, expectedSha256: string) {
  return withPlatformContext(userId, async (trx) => {
    const v = (await sql<any>`SELECT status, is_test, content_sha256 FROM contract_document_versions WHERE id = ${versionId} FOR UPDATE`.execute(trx)).rows[0];
    if (!v) throw new ContractNotFoundError();
    if (v.status !== "draft") throw new ContractRuleError("CONTRACT_VERSION_IMMUTABLE");
    if (v.content_sha256 !== expectedSha256) throw new ContractRuleError("CONTRACT_CONTENT_MISMATCH");
    try {
      await sql`UPDATE contract_document_versions SET legal_status = 'legally_approved', legal_approved_by_user_id = ${userId}, legal_approval_reference = ${reference}
        WHERE id = ${versionId}`.execute(trx);
      await audit(trx, userId, null, "CONTRACT_LEGAL_APPROVAL_RECORDED", "contract_document_version", versionId, { content_sha256: v.content_sha256 });
      return (await sql<any>`SELECT id, legal_status, legal_approved_at, legal_approved_sha256 FROM contract_document_versions WHERE id = ${versionId}`.execute(trx)).rows[0];
    } catch (err) { return rethrow(err); }
  });
}

// ---------------------------------------------------------------- representantes designados
/**
 * Central registra quién representa a la agencia en su contrato con ETNARA (p. ej., según la
 * resolución corporativa o el formulario de alta). Debe ser una administradora activa de esa agencia.
 */
export async function platformDesignateSignatory(userId: string, organizationId: string, input: { userId: string; fullName: string; title: string; basis: string }) {
  return withPlatformContext(userId, async (trx) => {
    const ok = (await sql<{ is_active_admin: boolean }>`SELECT is_active_admin FROM public.app_contract_acceptance_facts(${input.userId}, ${organizationId})`.execute(trx)).rows[0];
    if (!ok?.is_active_admin) throw new ContractRuleError("CONTRACT_SIGNATORY_MUST_BE_ACTIVE_ADMIN", 422);
    try {
      const r = (await sql<any>`INSERT INTO organization_contract_signatories (organization_id, user_id, full_name, title, basis, designated_by_user_id)
        VALUES (${organizationId}, ${input.userId}, ${input.fullName.trim()}, ${input.title.trim()}, ${input.basis.trim()}, ${userId})
        RETURNING id, organization_id, user_id, full_name, title, basis, designated_at`.execute(trx)).rows[0];
      await audit(trx, userId, organizationId, "CONTRACT_SIGNATORY_DESIGNATED", "organization_contract_signatory", r.id, { user_id: input.userId });
      return r;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new ContractRuleError("CONTRACT_SIGNATORY_ALREADY_DESIGNATED");
      return rethrow(err);
    }
  });
}

export async function platformRevokeSignatory(userId: string, organizationId: string, signatoryId: string, reason: string) {
  return withPlatformContext(userId, async (trx) => {
    try {
      const r = (await sql<any>`UPDATE organization_contract_signatories SET revoked_by_user_id = ${userId}, revoke_reason = ${reason}
        WHERE id = ${signatoryId} AND organization_id = ${organizationId} RETURNING id, revoked_at`.execute(trx)).rows[0];
      if (!r) throw new ContractNotFoundError();
      await audit(trx, userId, organizationId, "CONTRACT_SIGNATORY_REVOKED", "organization_contract_signatory", signatoryId, {});
      return r;
    } catch (err) { return rethrow(err); }
  });
}

export async function platformListSignatories(userId: string, organizationId: string) {
  return withPlatformContext(userId, async (trx) =>
    (await sql<any>`SELECT id, user_id, full_name, title, basis, designated_at, revoked_at FROM organization_contract_signatories
      WHERE organization_id = ${organizationId} ORDER BY designated_at`.execute(trx)).rows);
}

export async function orgListSignatories(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    return (await sql<any>`SELECT id, user_id, full_name, title, designated_at, revoked_at FROM organization_contract_signatories
      WHERE organization_id = ${organizationId} ORDER BY designated_at`.execute(trx)).rows;
  });
}

// ---------------------------------------------------------------- Orden de Suscripción (por agencia)
export { FOUNDING_PROGRAM, FOUNDING_PROGRAM_LIMIT, normalizeOrderTerms, subscriptionOrderBody, type OrderTerms, type OrderTermsInput } from "./contracts.orderTerms.js";
import { FOUNDING_PROGRAM_LIMIT, normalizeOrderTerms, subscriptionOrderBody, type OrderTermsInput } from "./contracts.orderTerms.js";

async function countFounding(trx: Parameters<Parameters<typeof withPlatformContext>[1]>[0], exceptOrg: string) {
  return (await sql<{ n: number }>`SELECT count(DISTINCT d.organization_id)::int n FROM contract_documents d JOIN contract_document_versions v ON v.document_id = d.id
    WHERE d.kind = 'SUBSCRIPTION_ORDER' AND NOT d.is_test AND d.organization_id <> ${exceptOrg} AND (v.commercial_terms -> 'foundingProgram' ->> 'enrolled') = 'true'`.execute(trx)).rows[0].n;
}

export async function platformCreateSubscriptionOrder(userId: string, organizationId: string, input: { isTest: boolean; versionLabel: string; requiredForOperation?: boolean; terms: OrderTermsInput }) {
  return withPlatformContext(userId, async (trx) => {
    const org = (await sql<any>`SELECT id, name FROM organizations WHERE id = ${organizationId}`.execute(trx)).rows[0];
    if (!org) throw new ContractNotFoundError();
    const terms = normalizeOrderTerms(input.terms);
    // Programa Fundadoras (propuesto): como mucho 10 agencias con Orden oficial inscrita (las de prueba no cuentan).
    if (!input.isTest && terms.foundingProgram && (await countFounding(trx, organizationId)) >= FOUNDING_PROGRAM_LIMIT) throw new ContractRuleError("CONTRACT_FOUNDING_PROGRAM_FULL");
    const short = organizationId.replace(/-/g, "").slice(0, 8).toUpperCase();
    const code = `${input.isTest ? "TEST_" : ""}ORDEN_SUSCRIPCION_${short}_${input.versionLabel.replace(/[^0-9A-Za-z]/g, "")}`;
    const title = `${input.isTest ? "[PRUEBA] " : ""}Orden de Suscripción — ${org.name}`;
    try {
      const d = (await sql<any>`INSERT INTO contract_documents (code, title, kind, is_test, organization_id, required_for_operation, created_by_user_id)
        VALUES (${code}, ${title}, 'SUBSCRIPTION_ORDER', ${input.isTest}, ${organizationId}, ${input.requiredForOperation ?? false}, ${userId}) RETURNING id`.execute(trx)).rows[0];
      const v = (await sql<any>`INSERT INTO contract_document_versions (document_id, version_label, body, content_sha256, is_test, commercial_terms, created_by_user_id)
        VALUES (${d.id}, ${input.versionLabel}, ${subscriptionOrderBody(org.name, terms, input.isTest)}, repeat('0', 64), false, ${JSON.stringify(terms)}::jsonb, ${userId})
        RETURNING id, content_sha256, status, legal_status, commercial_status`.execute(trx)).rows[0];
      await audit(trx, userId, organizationId, "CONTRACT_SUBSCRIPTION_ORDER_DRAFTED", "contract_document_version", v.id, { document_id: d.id, is_test: input.isTest, founding: !!terms.foundingProgram });
      return { documentId: d.id, versionId: v.id, code, title, status: v.status, legalStatus: v.legal_status, commercialStatus: v.commercial_status, contentSha256: v.content_sha256, commercialTerms: terms };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new ContractRuleError("CONTRACT_CODE_TAKEN");
      return rethrow(err);
    }
  });
}

/** Ajusta las condiciones de una Orden en borrador: regenera su texto (y su huella); anula aprobaciones previas. */
export async function platformUpdateOrderTerms(userId: string, versionId: string, input: OrderTermsInput) {
  return withPlatformContext(userId, async (trx) => {
    const v = (await sql<any>`SELECT v.id, v.status, v.is_test, d.kind, d.organization_id, o.name AS organization_name FROM contract_document_versions v
      JOIN contract_documents d ON d.id = v.document_id JOIN organizations o ON o.id = d.organization_id WHERE v.id = ${versionId} FOR UPDATE OF v`.execute(trx)).rows[0];
    if (!v || v.kind !== "SUBSCRIPTION_ORDER") throw new ContractNotFoundError();
    if (v.status !== "draft") throw new ContractRuleError("CONTRACT_VERSION_IMMUTABLE");
    const terms = normalizeOrderTerms(input);
    if (!v.is_test && terms.foundingProgram && (await countFounding(trx, v.organization_id)) >= FOUNDING_PROGRAM_LIMIT) throw new ContractRuleError("CONTRACT_FOUNDING_PROGRAM_FULL");
    try {
      await sql`UPDATE contract_document_versions SET body = ${subscriptionOrderBody(v.organization_name, terms, v.is_test)}, commercial_terms = ${JSON.stringify(terms)}::jsonb WHERE id = ${versionId}`.execute(trx);
      const r = (await sql<any>`SELECT id, content_sha256, legal_status, commercial_status, commercial_terms FROM contract_document_versions WHERE id = ${versionId}`.execute(trx)).rows[0];
      await audit(trx, userId, v.organization_id, "CONTRACT_SUBSCRIPTION_ORDER_TERMS_EDITED", "contract_document_version", versionId, { content_sha256: r.content_sha256 });
      return r;
    } catch (err) { return rethrow(err); }
  });
}

/** Aprobación COMERCIAL de una Orden en borrador (referencia escrita), ligada a la huella exacta. No publica ni cobra. */
export async function platformRecordCommercialApproval(userId: string, versionId: string, reference: string, expectedSha256: string) {
  return withPlatformContext(userId, async (trx) => {
    const v = (await sql<any>`SELECT v.status, v.content_sha256, d.kind, d.organization_id FROM contract_document_versions v JOIN contract_documents d ON d.id = v.document_id
      WHERE v.id = ${versionId} FOR UPDATE OF v`.execute(trx)).rows[0];
    if (!v || v.kind !== "SUBSCRIPTION_ORDER") throw new ContractNotFoundError();
    if (v.status !== "draft") throw new ContractRuleError("CONTRACT_VERSION_IMMUTABLE");
    if (v.content_sha256 !== expectedSha256) throw new ContractRuleError("CONTRACT_CONTENT_MISMATCH");
    try {
      await sql`UPDATE contract_document_versions SET commercial_status = 'commercially_approved', commercial_approved_by_user_id = ${userId}, commercial_approval_reference = ${reference}
        WHERE id = ${versionId}`.execute(trx);
      await audit(trx, userId, v.organization_id, "CONTRACT_COMMERCIAL_APPROVAL_RECORDED", "contract_document_version", versionId, { content_sha256: v.content_sha256 });
      return (await sql<any>`SELECT id, commercial_status, commercial_approved_at, commercial_approved_sha256 FROM contract_document_versions WHERE id = ${versionId}`.execute(trx)).rows[0];
    } catch (err) { return rethrow(err); }
  });
}

// ---------------------------------------------------------------- reglas de acceso (apagadas)
export async function platformSetEnforcement(userId: string, organizationId: string, input: { mode: EnforcementMode; enforceFrom: string | null; reason: string }) {
  return withPlatformContext(userId, async (trx) => {
    const org = (await sql<any>`SELECT id FROM organizations WHERE id = ${organizationId}`.execute(trx)).rows[0];
    if (!org) throw new ContractNotFoundError();
    const from = input.enforceFrom ? new Date(input.enforceFrom) : null;
    if ((input.mode === "restrict_new_operations" || input.mode === "contract_only") && (!from || Number.isNaN(from.getTime()))) throw new ContractRuleError("CONTRACT_ENFORCEMENT_DATE_REQUIRED", 422);
    const hasData = (await sql<{ any: boolean }>`SELECT public.app_contract_org_has_operational_data(${organizationId}) AS any`.execute(trx)).rows[0].any;
    // «Solo contrato» es para agencias nuevas sin datos: nunca corta el acceso a datos existentes.
    if (input.mode === "contract_only" && hasData) throw new ContractRuleError("CONTRACT_ENFORCEMENT_MODE_NOT_ALLOWED", 422);
    // Agencias que ya operan: aviso previo mínimo antes de restringir.
    if (input.mode === "restrict_new_operations" && hasData && from && from.getTime() < Date.now() + MIN_NOTICE_DAYS * 86_400_000 - 60_000) {
      throw new ContractRuleError("CONTRACT_ENFORCEMENT_NOTICE_TOO_SHORT", 422, { minNoticeDays: MIN_NOTICE_DAYS });
    }
    const r = (await sql<any>`INSERT INTO organization_contract_enforcement (organization_id, mode, enforce_from, reason, set_by_user_id)
      VALUES (${organizationId}, ${input.mode}, ${from}, ${input.reason}, ${userId})
      ON CONFLICT (organization_id) DO UPDATE SET mode = EXCLUDED.mode, enforce_from = EXCLUDED.enforce_from, reason = EXCLUDED.reason, set_by_user_id = EXCLUDED.set_by_user_id, set_at = now()
      RETURNING organization_id, mode, enforce_from, set_at`.execute(trx)).rows[0];
    await audit(trx, userId, organizationId, "CONTRACT_ENFORCEMENT_SET", "organization", organizationId, { mode: input.mode, enforce_from: from?.toISOString() ?? null });
    return { ...r, serverEnforcementEnabled: contractsEnforcementEnabled() };
  });
}

/** Estado para el portal de la agencia (administración). Informativo si el interruptor global está apagado. */
export async function orgContractStatus(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const s = (await sql<{ mode: EnforcementMode; enforce_from: Date | null; satisfied: boolean; pending: number }>`SELECT mode, enforce_from, satisfied, pending FROM public.app_contract_enforcement_state(${organizationId})`.execute(trx)).rows[0];
    const enabled = contractsEnforcementEnabled();
    const started = !!s.enforce_from && new Date(s.enforce_from).getTime() <= Date.now();
    return {
      serverEnforcementEnabled: enabled, mode: s.mode, enforceFrom: s.enforce_from, satisfied: s.satisfied, pendingRequired: s.pending,
      notice: enabled && s.mode !== "off" && !s.satisfied,
      restricted: enabled && !s.satisfied && started && (s.mode === "restrict_new_operations" || s.mode === "contract_only"),
    };
  });
}
