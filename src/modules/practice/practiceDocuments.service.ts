import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { saveCompliancePolicy } from "../eligibility/eligibility.service.js";
import { EXPIRING_SOON_DAYS, practiceDocumentStatus } from "./practiceStatus.js";

export { EXPIRING_SOON_DAYS, practiceDocumentStatus };
export type { PracticeDocumentStatus } from "./practiceStatus.js";

/**
 * 161 · «Mis documentos» del cuidador independiente (PR C).
 * Documentos AUTODECLARADOS por su titular: ETNARA Care no los verifica, aprueba ni certifica. Los estados se calculan
 * solo con lo registrado (Registrado · Vence pronto · Vencido · Falta). Solo la única persona operativa de una
 * organización INDEPENDENT_PROVIDER usa estas rutas; la base de datos (161) lo exige también.
 */
export const PRACTICE_DOCUMENTS_NOTICE =
  "Documentos registrados por el proveedor. ETNARA Care no verifica, aprueba ni certifica documentos. Cumplir los requisitos legales y profesionales de tu práctica es tu responsabilidad.";
export const INDEPENDENT_WORKER_ROLE = "INDEPENDENT_CAREGIVER";

export class PracticeError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "PracticeError";
  }
}

type Trx = Parameters<Parameters<typeof withTenantContext>[1]>[0];

async function assertOperator(trx: Trx, userId: string, organizationId: string): Promise<{ workerId: string; membershipId: string }> {
  const ok = (await sql<{ ok: boolean }>`SELECT public.app_is_independent_operator(${userId}::uuid, ${organizationId}::uuid) AS ok`.execute(trx)).rows[0]?.ok;
  if (!ok) throw new PracticeError("PRACTICE_INDEPENDENT_ONLY", 403);
  const own = (await sql<{ worker_id: string; id: string }>`
    SELECT owm.worker_id, owm.id FROM organization_worker_memberships owm JOIN workers w ON w.id = owm.worker_id
    WHERE w.user_id = ${userId} AND owm.organization_id = ${organizationId} AND owm.status = 'active' LIMIT 1`.execute(trx)).rows[0];
  if (!own) throw new PracticeError("PRACTICE_INDEPENDENT_ONLY", 403);
  return { workerId: own.worker_id, membershipId: own.id };
}

function todayPr(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Puerto_Rico" }).format(new Date());
}

async function audit(trx: Trx, userId: string, organizationId: string, action: string, credentialId: string, previous: unknown, next: unknown) {
  await sql`INSERT INTO audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, previous_value, new_value)
    VALUES (${userId}, ${organizationId}, ${organizationId}, ${action}, 'credential', ${credentialId},
            ${previous === null ? null : JSON.stringify(previous)}::jsonb, ${JSON.stringify(next)}::jsonb)`.execute(trx);
}

export async function getPracticeDocuments(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const { workerId } = await assertOperator(trx, userId, organizationId);
    const today = todayPr();
    const types = (await sql<{ id: string; code: string; name: string }>`SELECT id, code, name FROM credential_types ORDER BY name`.execute(trx)).rows;
    const docs = (await sql<{ id: string; code: string; name: string; issuing_entity_name: string | null; issued_at: string | null; expires_at: string | null; status: string; declared_by_holder: boolean; created_at: string; credential_type_id: string }>`
      SELECT c.id, ct.code, ct.name, c.issuing_entity_name, c.issued_at::text AS issued_at, c.expires_at::text AS expires_at, c.status::text AS status,
             c.declared_by_holder, c.created_at, c.credential_type_id
      FROM credentials c JOIN credential_types ct ON ct.id = c.credential_type_id
      WHERE c.worker_id = ${workerId} ORDER BY c.created_at DESC`.execute(trx)).rows;
    const set = (await sql<{ id: string }>`SELECT id FROM requirement_sets WHERE organization_id = ${organizationId}
      AND (worker_role IS NULL OR lower(worker_role) = lower(${INDEPENDENT_WORKER_ROLE})) ORDER BY (worker_role IS NOT NULL) DESC, created_at LIMIT 1`.execute(trx)).rows[0];
    const reqs = set ? (await sql<{ credential_type_id: string; code: string; name: string; is_mandatory: boolean }>`
      SELECT r.credential_type_id, ct.code, ct.name, r.is_mandatory FROM requirements r JOIN credential_types ct ON ct.id = r.credential_type_id
      WHERE r.requirement_set_id = ${set.id} ORDER BY ct.name`.execute(trx)).rows : [];
    const latestByType = new Map<string, (typeof docs)[number]>();
    for (const d of docs) if (d.status !== "revoked" && !latestByType.has(d.credential_type_id)) latestByType.set(d.credential_type_id, d);
    const requirements = reqs.map((r) => {
      const doc = latestByType.get(r.credential_type_id) ?? null;
      return { credentialTypeCode: r.code, name: r.name, isMandatory: r.is_mandatory, status: practiceDocumentStatus(doc, today), expiresAt: doc?.expires_at ?? null, documentId: doc?.id ?? null };
    });
    return {
      notice: PRACTICE_DOCUMENTS_NOTICE,
      policyConfigured: Boolean(set),
      expiringSoonDays: EXPIRING_SOON_DAYS,
      requirements,
      pendingMandatory: requirements.filter((r) => r.isMandatory && (r.status === "MISSING" || r.status === "EXPIRED")).map((r) => r.credentialTypeCode),
      documents: docs.map((d) => ({
        id: d.id, credentialTypeCode: d.code, name: d.name, issuingEntityName: d.issuing_entity_name, issuedAt: d.issued_at, expiresAt: d.expires_at,
        status: practiceDocumentStatus(d, today), selfDeclared: d.declared_by_holder,
      })),
      credentialTypes: types.map((t) => ({ code: t.code, name: t.name })),
    };
  });
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const registerPracticeDocumentSchema = z.object({
  credentialTypeCode: z.string().trim().min(1).max(80),
  issuingEntityName: z.string().trim().min(1).max(200).optional(),
  issuedAt: dateSchema.optional(),
  expiresAt: dateSchema.optional(),
}).strict().refine((v) => !v.issuedAt || !v.expiresAt || v.issuedAt <= v.expiresAt, { message: "issuedAt after expiresAt" });

/** Registrar (o RENOVAR: un registro nuevo del mismo tipo pasa a ser el vigente; el anterior queda en el historial). */
export async function registerPracticeDocument(userId: string, organizationId: string, input: z.infer<typeof registerPracticeDocumentSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const { workerId } = await assertOperator(trx, userId, organizationId);
    const type = (await sql<{ id: string }>`SELECT id FROM credential_types WHERE upper(code) = upper(${input.credentialTypeCode}) LIMIT 1`.execute(trx)).rows[0];
    if (!type) throw new PracticeError("CREDENTIAL_TYPE_NOT_FOUND", 400);
    const row = (await sql<{ id: string }>`
      INSERT INTO credentials (worker_id, credential_type_id, issuing_entity_name, issuing_entity_type, issued_at, expires_at, status, declared_by_holder)
      VALUES (${workerId}, ${type.id}, ${input.issuingEntityName ?? null}, 'external_provider', ${input.issuedAt ?? null}::date, ${input.expiresAt ?? null}::date, 'active', true)
      RETURNING id`.execute(trx)).rows[0];
    await audit(trx, userId, organizationId, "SELF_DECLARED_DOCUMENT_REGISTERED", row.id, null, { ...input, selfDeclared: true });
    return { id: row.id };
  });
}

export const updatePracticeDocumentSchema = z.object({
  issuingEntityName: z.string().trim().min(1).max(200).nullable().optional(),
  issuedAt: dateSchema.nullable().optional(),
  expiresAt: dateSchema.nullable().optional(),
  retire: z.literal(true).optional(),
}).strict();

/** Corregir los datos de uno de SUS documentos autodeclarados, o retirarlo (nunca se borra). */
export async function updatePracticeDocument(userId: string, organizationId: string, credentialId: string, input: z.infer<typeof updatePracticeDocumentSchema>) {
  if (!z.string().uuid().safeParse(credentialId).success) throw new PracticeError("INVALID_ID", 400);
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const { workerId } = await assertOperator(trx, userId, organizationId);
    const cur = (await sql<{ issuing_entity_name: string | null; issued_at: string | null; expires_at: string | null; status: string; declared_by_holder: boolean }>`
      SELECT issuing_entity_name, issued_at::text AS issued_at, expires_at::text AS expires_at, status::text AS status, declared_by_holder
      FROM credentials WHERE id = ${credentialId} AND worker_id = ${workerId} FOR UPDATE`.execute(trx)).rows[0];
    if (!cur) throw new PracticeError("NOT_FOUND", 404);
    if (!cur.declared_by_holder) throw new PracticeError("CREDENTIAL_NOT_SELF_DECLARED", 409); // lo registró una agencia: no se edita aquí
    const next = {
      issuing_entity_name: input.issuingEntityName === undefined ? cur.issuing_entity_name : input.issuingEntityName,
      issued_at: input.issuedAt === undefined ? cur.issued_at : input.issuedAt,
      expires_at: input.expiresAt === undefined ? cur.expires_at : input.expiresAt,
      status: input.retire ? "revoked" : cur.status,
    };
    if (next.issued_at && next.expires_at && next.issued_at > next.expires_at) throw new PracticeError("INVALID_DATES", 400);
    await sql`UPDATE credentials SET issuing_entity_name = ${next.issuing_entity_name}, issued_at = ${next.issued_at}::date, expires_at = ${next.expires_at}::date,
      status = ${next.status}::credential_status_enum, updated_at = now() WHERE id = ${credentialId}`.execute(trx);
    await audit(trx, userId, organizationId, input.retire ? "SELF_DECLARED_DOCUMENT_RETIRED" : "SELF_DECLARED_DOCUMENT_UPDATED", credentialId, cur, next);
    return { id: credentialId };
  });
}

export const practiceRequirementsSchema = z.object({
  credentialTypeCodes: z.array(z.string().trim().min(1).max(80)).min(1).max(30),
}).strict();

/** Requisitos de SU práctica (opcionales). Nunca con «revisión de la organización»: nadie más revisa (161). */
export async function savePracticeRequirements(userId: string, organizationId: string, input: z.infer<typeof practiceRequirementsSchema>) {
  await withTenantContext({ userId, organizationId }, async (trx) => { await assertOperator(trx, userId, organizationId); });
  const codes = [...new Set(input.credentialTypeCodes.map((c) => c.toUpperCase()))];
  return saveCompliancePolicy(userId, organizationId, {
    workerRole: INDEPENDENT_WORKER_ROLE,
    requirements: codes.map((credentialTypeCode) => ({ credentialTypeCode, isMandatory: true, requiresOrganizationReview: false })),
  });
}
