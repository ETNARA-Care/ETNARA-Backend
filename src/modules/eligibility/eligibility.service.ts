import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError } from "../../context/errors.js";

export class MembershipNotFoundError extends Error {
  constructor() {
    super("MEMBERSHIP_NOT_FOUND");
    this.name = "MembershipNotFoundError";
  }
}
export class NoApplicableRequirementSetError extends Error {
  constructor() {
    super("NO_APPLICABLE_REQUIREMENT_SET");
    this.name = "NoApplicableRequirementSetError";
  }
}
export class ComplianceManagementForbiddenError extends Error {
  constructor() {
    super("COMPLIANCE_MANAGEMENT_FORBIDDEN");
    this.name = "ComplianceManagementForbiddenError";
  }
}
export class ComplianceCredentialTypeNotFoundError extends Error {
  constructor() {
    super("COMPLIANCE_CREDENTIAL_TYPE_NOT_FOUND");
    this.name = "ComplianceCredentialTypeNotFoundError";
  }
}

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

export interface RequirementResult {
  credentialTypeCode: string;
  isMandatory: boolean;
  requiresOrganizationReview: boolean;
  satisfied: boolean;
  reason: string;
}

export interface EligibilityResult {
  eligibilityStatus: string;
  requirementSetId: string;
  requirements: RequirementResult[];
}

/**
 * Requirement-set selection: prefer the worker-role policy scoped to this
 * organization, then an organization-wide policy, then the same two levels
 * from the platform catalog. If none exists, there is nothing to evaluate.
 */
async function findApplicableRequirementSet(
  trx: unknown,
  organizationId: string,
  workerRole: string
): Promise<string> {
  const orgSpecific = await sql<{ id: string }>`
    SELECT id
    FROM requirement_sets
    WHERE organization_id = ${organizationId}
      AND (worker_role IS NULL OR lower(worker_role) = lower(${workerRole}))
    ORDER BY (worker_role IS NOT NULL) DESC, created_at
    LIMIT 1
  `.execute(trx as never);
  if (orgSpecific.rows[0]) return orgSpecific.rows[0].id;

  const global = await sql<{ id: string }>`
    SELECT id
    FROM requirement_sets
    WHERE organization_id IS NULL
      AND (worker_role IS NULL OR lower(worker_role) = lower(${workerRole}))
    ORDER BY (worker_role IS NOT NULL) DESC, created_at
    LIMIT 1
  `.execute(trx as never);
  if (global.rows[0]) return global.rows[0].id;

  throw new NoApplicableRequirementSetError();
}

/**
 * The eligibility engine. Everything is derived from DB state -- there is
 * no path, anywhere, that accepts an externally-supplied eligibility value
 * or a "satisfied=true" flag from a client. Persists its own result into
 * worker_eligibility (a computed snapshot, per point 28 -- see report), but
 * the compliance-summary read path always calls this fresh rather than
 * trusting the stored snapshot alone, so expirations are always current.
 */
export async function evaluateWorkerEligibility(
  userId: string,
  organizationId: string,
  membershipId: string
): Promise<EligibilityResult> {
  assertUuid(membershipId, "organizationWorkerMembershipId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const membershipRow = await sql<{ id: string; worker_id: string; status: string; internal_role: string }>`
      SELECT id, worker_id, status, internal_role FROM organization_worker_memberships
      WHERE id = ${membershipId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    const membership = membershipRow.rows[0];
    if (!membership) throw new MembershipNotFoundError();

    const requirementSetId = await findApplicableRequirementSet(trx, organizationId, membership.internal_role);

    // Membership inactive -> not_eligible immediately, regardless of
    // credentials -- no operational authority survives a revoked
    // membership, eligibility included.
    if (membership.status !== "active") {
      const result: EligibilityResult = {
        eligibilityStatus: "not_eligible",
        requirementSetId,
        requirements: [],
      };
      await persistEligibility(trx, membershipId, organizationId, requirementSetId, result.eligibilityStatus);
      return result;
    }

    const requirementsRows = await sql<{
      credential_type_id: string;
      type_code: string;
      is_mandatory: boolean;
      requires_organization_review: boolean;
    }>`
      SELECT r.credential_type_id, ct.code as type_code, r.is_mandatory, r.requires_organization_review
      FROM requirements r
      JOIN credential_types ct ON ct.id = r.credential_type_id
      WHERE r.requirement_set_id = ${requirementSetId}
      ORDER BY ct.code
    `.execute(trx);

    const requirementResults: RequirementResult[] = [];
    let allMandatorySatisfied = true;

    for (const req of requirementsRows.rows) {
      // Latest non-revoked credential of this type for this worker.
      const credRow = await sql<{
        id: string;
        status: string;
        expires_at: string | null;
        document_id: string | null;
      }>`
        SELECT id, status, expires_at, document_id FROM credentials
        WHERE worker_id = ${membership.worker_id} AND credential_type_id = ${req.credential_type_id}
          AND status != 'revoked'
        ORDER BY created_at DESC
        LIMIT 1
      `.execute(trx);
      const credential = credRow.rows[0];

      let satisfied = false;
      let reason = "MISSING_CREDENTIAL";

      if (credential) {
        const today = new Date().toISOString().slice(0, 10);
        const notExpired = !credential.expires_at || credential.expires_at >= today;
        const activeStatus = credential.status === "active";

        if (!activeStatus) {
          reason = "CREDENTIAL_NOT_ACTIVE";
        } else if (!notExpired) {
          reason = "CREDENTIAL_EXPIRED";
        } else {
          // A credential only "counts" toward eligibility once the
          // platform has verified it -- verification travels with the
          // worker, but eligibility never assumes it without checking.
          const platformVerification = await sql<{ status: string }>`
            SELECT cpv.status
            FROM credential_platform_verifications cpv
            LEFT JOIN documents d ON d.id = ${credential.document_id}
            WHERE cpv.credential_id = ${credential.id}
              AND (
                cpv.file_id = d.file_id
                OR (cpv.file_id IS NULL AND d.id IS NULL)
              )
            ORDER BY cpv.verified_at DESC LIMIT 1
          `.execute(trx);

          if (!platformVerification.rows[0]) {
            reason = "PLATFORM_VERIFICATION_MISSING";
          } else if (platformVerification.rows[0].status === "rejected") {
            reason = "PLATFORM_VERIFICATION_REJECTED";
          } else if (req.requires_organization_review) {
            const orgReview = await sql<{ id: string }>`
              SELECT id FROM organization_credential_reviews
              WHERE credential_id = ${credential.id} AND organization_id = ${organizationId}
                AND review_status = 'approved'
              LIMIT 1
            `.execute(trx);
            if (!orgReview.rows[0]) {
              reason = "ORGANIZATION_REVIEW_MISSING";
            } else {
              satisfied = true;
              reason = "OK";
            }
          } else {
            satisfied = true;
            reason = "OK";
          }
        }
      } else {
        // Preserve the normal "latest non-revoked credential" behavior so a
        // revoked historical record does not hide an older valid credential.
        // If no usable record exists at all, distinguish an explicitly
        // revoked credential from one that was never registered.
        const revokedCredential = await sql<{ id: string }>`
          SELECT id FROM credentials
          WHERE worker_id = ${membership.worker_id} AND credential_type_id = ${req.credential_type_id}
            AND status = 'revoked'
          ORDER BY created_at DESC
          LIMIT 1
        `.execute(trx);
        if (revokedCredential.rows[0]) reason = "CREDENTIAL_REVOKED";
      }

      requirementResults.push({
        credentialTypeCode: req.type_code,
        isMandatory: req.is_mandatory,
        requiresOrganizationReview: req.requires_organization_review,
        satisfied,
        reason,
      });

      if (req.is_mandatory && !satisfied) allMandatorySatisfied = false;
    }

    const eligibilityStatus = allMandatorySatisfied ? "eligible" : "not_eligible";
    await persistEligibility(trx, membershipId, organizationId, requirementSetId, eligibilityStatus);

    return { eligibilityStatus, requirementSetId, requirements: requirementResults };
  });
}

async function persistEligibility(
  trx: unknown,
  membershipId: string,
  organizationId: string,
  requirementSetId: string,
  status: string
): Promise<void> {
  const existing = await sql<{ id: string }>`
    SELECT id FROM worker_eligibility
    WHERE organization_worker_membership_id = ${membershipId} AND requirement_set_id = ${requirementSetId}
    LIMIT 1
  `.execute(trx as never);

  if (existing.rows[0]) {
    await sql`
      UPDATE worker_eligibility SET eligibility_status = ${status}, computed_at = now()
      WHERE id = ${existing.rows[0].id}
    `.execute(trx as never);
  } else {
    await sql`
      INSERT INTO worker_eligibility (organization_worker_membership_id, organization_id, requirement_set_id, eligibility_status)
      VALUES (${membershipId}, ${organizationId}, ${requirementSetId}, ${status})
    `.execute(trx as never);
  }
}

export interface ComplianceSummary {
  eligibility: string;
  requirements: Array<{
    requirement: string;
    status: string;
    isMandatory: boolean;
    requiresOrganizationReview: boolean;
  }>;
}

export async function getComplianceSummary(
  userId: string,
  organizationId: string,
  membershipId: string
): Promise<ComplianceSummary> {
  const result = await evaluateWorkerEligibility(userId, organizationId, membershipId);
  return {
    eligibility: result.eligibilityStatus,
    requirements: result.requirements.map((r) => ({
      requirement: r.credentialTypeCode,
      status: r.satisfied ? "satisfied" : r.reason,
      isMandatory: r.isMandatory,
      requiresOrganizationReview: r.requiresOrganizationReview,
    })),
  };
}

const policyRequirementSchema = z.object({
  credentialTypeCode: z.string().trim().min(1).max(80),
  isMandatory: z.boolean(),
  requiresOrganizationReview: z.boolean(),
});

export const saveCompliancePolicySchema = z.object({
  workerRole: z.string().trim().min(1).max(80),
  requirements: z.array(policyRequirementSchema).min(1).max(50),
}).superRefine((value, ctx) => {
  const codes = value.requirements.map((item) => item.credentialTypeCode.toUpperCase());
  if (new Set(codes).size !== codes.length) {
    ctx.addIssue({ code: "custom", message: "Credential types must be unique" });
  }
});
export type SaveCompliancePolicyInput = z.infer<typeof saveCompliancePolicySchema>;

interface PolicyRequirement {
  credentialTypeCode: string;
  credentialTypeName: string;
  isMandatory: boolean;
  requiresOrganizationReview: boolean;
}

export interface CompliancePolicy {
  workerRole: string;
  requirementSetId: string;
  source: "organization" | "platform";
  requirements: PolicyRequirement[];
}

export interface ComplianceConfiguration {
  workerRoles: string[];
  credentialTypes: Array<{ code: string; name: string }>;
  policies: CompliancePolicy[];
}

async function assertComplianceManager(trx: unknown): Promise<void> {
  const result = await sql<{ allowed: boolean }>`SELECT app_is_org_manager() AS allowed`.execute(trx as never);
  if (!result.rows[0]?.allowed) throw new ComplianceManagementForbiddenError();
}

async function readPolicy(
  trx: unknown,
  organizationId: string,
  workerRole: string
): Promise<CompliancePolicy | null> {
  const set = await sql<{ id: string; source: "organization" | "platform" }>`
    SELECT id,
           CASE WHEN organization_id IS NULL THEN 'platform' ELSE 'organization' END AS source
    FROM requirement_sets
    WHERE (organization_id = ${organizationId} OR organization_id IS NULL)
      AND (worker_role IS NULL OR lower(worker_role) = lower(${workerRole}))
    ORDER BY (organization_id IS NOT NULL) DESC, (worker_role IS NOT NULL) DESC, created_at
    LIMIT 1
  `.execute(trx as never);
  if (!set.rows[0]) return null;

  const requirements = await sql<{
    credential_type_code: string;
    credential_type_name: string;
    is_mandatory: boolean;
    requires_organization_review: boolean;
  }>`
    SELECT ct.code AS credential_type_code, ct.name AS credential_type_name,
           r.is_mandatory, r.requires_organization_review
    FROM requirements r
    JOIN credential_types ct ON ct.id = r.credential_type_id
    WHERE r.requirement_set_id = ${set.rows[0].id}
    ORDER BY ct.name
  `.execute(trx as never);

  return {
    workerRole,
    requirementSetId: set.rows[0].id,
    source: set.rows[0].source,
    requirements: requirements.rows.map((row) => ({
      credentialTypeCode: row.credential_type_code,
      credentialTypeName: row.credential_type_name,
      isMandatory: row.is_mandatory,
      requiresOrganizationReview: row.requires_organization_review,
    })),
  };
}

export async function getComplianceConfiguration(
  userId: string,
  organizationId: string
): Promise<ComplianceConfiguration> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertComplianceManager(trx);
    const roles = await sql<{ worker_role: string }>`
      SELECT worker_role
      FROM (
        SELECT DISTINCT internal_role AS worker_role
        FROM organization_worker_memberships
        WHERE organization_id = ${organizationId}
        UNION
        SELECT DISTINCT worker_role
        FROM requirement_sets
        WHERE organization_id = ${organizationId} AND worker_role IS NOT NULL
      ) configured_roles
      WHERE worker_role IS NOT NULL AND btrim(worker_role) <> ''
      ORDER BY worker_role
    `.execute(trx);
    const catalog = await sql<{ code: string; name: string }>`
      SELECT code, name FROM credential_types ORDER BY name
    `.execute(trx);
    const policies: CompliancePolicy[] = [];
    for (const row of roles.rows) {
      const policy = await readPolicy(trx, organizationId, row.worker_role);
      if (policy) policies.push(policy);
    }
    return {
      workerRoles: roles.rows.map((row) => row.worker_role),
      credentialTypes: catalog.rows,
      policies,
    };
  });
}

export async function saveCompliancePolicy(
  userId: string,
  organizationId: string,
  input: SaveCompliancePolicyInput
): Promise<CompliancePolicy> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertComplianceManager(trx);
    const workerRole = input.workerRole.trim();
    const previous = await readPolicy(trx, organizationId, workerRole);
    const codes = input.requirements.map((item) => item.credentialTypeCode.toUpperCase());
    const catalog = await sql<{ id: string; code: string }>`
      SELECT id, code FROM credential_types WHERE upper(code) IN (${sql.join(codes.map((code) => sql`${code}`))})
    `.execute(trx);
    if (catalog.rows.length !== codes.length) {
      throw new ComplianceCredentialTypeNotFoundError();
    }
    const typeIds = new Map(catalog.rows.map((row) => [row.code.toUpperCase(), row.id]));

    const existing = await sql<{ id: string }>`
      SELECT id FROM requirement_sets
      WHERE organization_id = ${organizationId} AND lower(worker_role) = lower(${workerRole})
      ORDER BY created_at LIMIT 1
    `.execute(trx);
    let requirementSetId = existing.rows[0]?.id;
    if (!requirementSetId) {
      const inserted = await sql<{ id: string }>`
        INSERT INTO requirement_sets (organization_id, worker_role, name)
        VALUES (${organizationId}, ${workerRole}, ${`Requisitos ${workerRole}`})
        RETURNING id
      `.execute(trx);
      requirementSetId = inserted.rows[0].id;
    }

    await sql`DELETE FROM requirements WHERE requirement_set_id = ${requirementSetId}`.execute(trx);
    for (const requirement of input.requirements) {
      await sql`
        INSERT INTO requirements (
          requirement_set_id, credential_type_id, is_mandatory, requires_organization_review
        ) VALUES (
          ${requirementSetId}, ${typeIds.get(requirement.credentialTypeCode.toUpperCase())!},
          ${requirement.isMandatory}, ${requirement.requiresOrganizationReview}
        )
      `.execute(trx);
    }

    const saved = await readPolicy(trx, organizationId, workerRole);
    if (!saved) throw new NoApplicableRequirementSetError();
    await sql`
      INSERT INTO audit_log (
        actor_user_id, organization_id, target_organization_id, action,
        entity_type, entity_id, previous_value, new_value
      ) VALUES (
        ${userId}, ${organizationId}, ${organizationId},
        'COMPLIANCE_REQUIREMENTS_UPDATED', 'requirement_set', ${requirementSetId},
        ${JSON.stringify(previous)}::jsonb, ${JSON.stringify(saved)}::jsonb
      )
    `.execute(trx);
    return saved;
  });
}

export interface ComplianceAuditEntry {
  id: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  occurredAt: string;
  previousValue: unknown;
  newValue: unknown;
}

export async function listComplianceAudit(
  userId: string,
  organizationId: string
): Promise<ComplianceAuditEntry[]> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertComplianceManager(trx);
    const result = await sql<{
      id: string;
      actor_user_id: string | null;
      action: string;
      entity_type: string;
      occurred_at: string;
      previous_value: unknown;
      new_value: unknown;
    }>`
      SELECT id, actor_user_id, action, entity_type, occurred_at, previous_value, new_value
      FROM audit_log
      WHERE organization_id = ${organizationId}
        AND action IN ('COMPLIANCE_REQUIREMENTS_UPDATED', 'WORKER_MEMBERSHIP_STATUS_CHANGED')
      ORDER BY occurred_at DESC
      LIMIT 100
    `.execute(trx);
    return result.rows.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      action: row.action,
      entityType: row.entity_type,
      occurredAt: row.occurred_at,
      previousValue: row.previous_value,
      newValue: row.new_value,
    }));
  });
}

type ComplianceAgentSeverity = "critical" | "warning";

type ComplianceAgentWorker = {
  membershipId: string;
  displayName: string;
  workerRole: string;
  nearestExpiry: string | null;
};

const CRITICAL_COMPLIANCE_REASONS = new Set([
  "CREDENTIAL_EXPIRED",
  "CREDENTIAL_REVOKED",
  "PLATFORM_VERIFICATION_REJECTED",
]);

const COMPLIANCE_AGENT_GUARDRAILS = [
  "No aprueba ni rechaza credenciales.",
  "No cambia la elegibilidad ni el estado laboral.",
  "No carga documentos ni modifica políticas.",
  "Toda acción final requiere confirmación humana.",
];

function complianceAgentRecommendation(blockers: string[], expiring: boolean) {
  if (blockers.includes("PLATFORM_VERIFICATION_REJECTED")) {
    return "Abrir el perfil, revisar el rechazo y solicitar una corrección o un documento nuevo.";
  }
  if (blockers.includes("CREDENTIAL_EXPIRED") || blockers.includes("CREDENTIAL_REVOKED")) {
    return "Abrir el perfil y solicitar una credencial vigente antes de asignar trabajo.";
  }
  if (blockers.includes("MISSING_CREDENTIAL")) {
    return "Abrir el perfil y solicitar la credencial obligatoria que falta.";
  }
  if (blockers.includes("PLATFORM_VERIFICATION_MISSING")) {
    return "Revisar el documento y dar seguimiento a la verificación de plataforma.";
  }
  if (blockers.includes("ORGANIZATION_REVIEW_MISSING")) {
    return "Abrir el perfil y realizar la revisión humana requerida por la agencia.";
  }
  if (blockers.includes("NO_APPLICABLE_REQUIREMENT_SET")) {
    return "Configurar los requisitos aplicables para este tipo de cuidador.";
  }
  if (blockers.includes("CREDENTIAL_NOT_ACTIVE")) {
    return "Abrir el perfil y revisar por qué la credencial todavía no está activa.";
  }
  if (expiring) {
    return "Solicitar la renovación antes del vencimiento para evitar una interrupción.";
  }
  return "Revisar el perfil y confirmar el próximo paso de cumplimiento.";
}

export async function generateComplianceAgentBriefing(
  userId: string,
  organizationId: string
) {
  const workers = await withTenantContext({ userId, organizationId }, async (trx) => {
    await assertComplianceManager(trx);
    const result = await sql<{
      membership_id: string;
      display_name: string | null;
      internal_role: string;
      nearest_expiry: string | null;
    }>`
      SELECT owm.id AS membership_id, w.display_name, owm.internal_role,
             MIN(c.expires_at) FILTER (
               WHERE c.status = 'active'
                 AND c.expires_at BETWEEN current_date AND current_date + 30
             ) AS nearest_expiry
      FROM organization_worker_memberships owm
      JOIN workers w ON w.id = owm.worker_id
      LEFT JOIN credentials c ON c.worker_id = owm.worker_id
      WHERE owm.organization_id = ${organizationId}
        AND owm.status = 'active'
      GROUP BY owm.id, w.display_name, owm.internal_role
      ORDER BY w.display_name NULLS LAST, owm.id
    `.execute(trx);
    return result.rows.map((row): ComplianceAgentWorker => ({
      membershipId: row.membership_id,
      displayName: row.display_name || "Cuidador sin nombre",
      workerRole: row.internal_role,
      nearestExpiry: row.nearest_expiry,
    }));
  });

  const analyzed: Array<{
    worker: ComplianceAgentWorker;
    eligible: boolean;
    blockers: string[];
    severity: ComplianceAgentSeverity | null;
  }> = [];

  for (const worker of workers) {
    try {
      const summary = await getComplianceSummary(userId, organizationId, worker.membershipId);
      const blockers = summary.requirements
        .filter((requirement) => requirement.isMandatory && requirement.status !== "satisfied")
        .map((requirement) => requirement.status);
      const critical = blockers.some((reason) => CRITICAL_COMPLIANCE_REASONS.has(reason));
      analyzed.push({
        worker,
        eligible: summary.eligibility === "eligible",
        blockers,
        severity: critical ? "critical" : blockers.length > 0 || worker.nearestExpiry ? "warning" : null,
      });
    } catch (error) {
      if (!(error instanceof NoApplicableRequirementSetError)) throw error;
      analyzed.push({
        worker,
        eligible: false,
        blockers: ["NO_APPLICABLE_REQUIREMENT_SET"],
        severity: "warning",
      });
    }
  }

  const severityRank: Record<ComplianceAgentSeverity, number> = { critical: 0, warning: 1 };
  const priorityCandidates = analyzed
    .filter((item) => item.severity)
    .sort((left, right) => {
      const severityDifference = severityRank[left.severity!] - severityRank[right.severity!];
      if (severityDifference !== 0) return severityDifference;
      const blockerDifference = right.blockers.length - left.blockers.length;
      if (blockerDifference !== 0) return blockerDifference;
      return left.worker.displayName.localeCompare(right.worker.displayName, "es");
    });
  const selected = priorityCandidates.slice(0, 5);
  const eligibleWorkerCount = analyzed.filter((item) => item.eligible).length;
  const blockedWorkerCount = analyzed.filter((item) => !item.eligible).length;
  const expiringWorkerCount = analyzed.filter((item) => item.worker.nearestExpiry).length;

  const recorded = await withTenantContext({ userId, organizationId }, async (trx) => {
    await assertComplianceManager(trx);
    return sql<{ id: string }>`
      SELECT app_record_compliance_agent_run(
        ${organizationId},
        ${workers.length},
        ${eligibleWorkerCount},
        ${blockedWorkerCount},
        ${expiringWorkerCount},
        CAST(${JSON.stringify(selected.map((item) => item.worker.membershipId))} AS jsonb)
      ) id
    `.execute(trx);
  });

  const headline = blockedWorkerCount > 0
    ? `${blockedWorkerCount} cuidador${blockedWorkerCount === 1 ? "" : "es"} no ${blockedWorkerCount === 1 ? "está apto" : "están aptos"} para trabajar.`
    : expiringWorkerCount > 0
      ? `${expiringWorkerCount} cuidador${expiringWorkerCount === 1 ? "" : "es"} requiere${expiringWorkerCount === 1 ? "" : "n"} renovación próxima.`
      : "El personal activo está al día con los requisitos actuales.";

  return {
    runId: recorded.rows[0].id,
    generatedAt: new Date().toISOString(),
    mode: "advisory" as const,
    headline,
    narrative: workers.length > 0
      ? `Analicé ${workers.length} cuidador${workers.length === 1 ? "" : "es"} activo${workers.length === 1 ? "" : "s"} usando elegibilidad, verificaciones y vencimientos reales. No ejecuté cambios.`
      : "No hay cuidadores activos que analizar en esta organización.",
    summary: {
      activeWorkers: workers.length,
      eligibleWorkers: eligibleWorkerCount,
      blockedWorkers: blockedWorkerCount,
      expiringWorkers: expiringWorkerCount,
    },
    priorities: selected.map((item, index) => ({
      rank: index + 1,
      membershipId: item.worker.membershipId,
      workerName: item.worker.displayName,
      workerRole: item.worker.workerRole,
      severity: item.severity!,
      title: item.blockers.length > 0
        ? "Requisito obligatorio pendiente"
        : "Credencial próxima a vencer",
      reason: item.blockers.length > 0
        ? `${item.blockers.length} bloqueo${item.blockers.length === 1 ? "" : "s"} de cumplimiento requiere${item.blockers.length === 1 ? "" : "n"} atención.`
        : `Una credencial vence el ${item.worker.nearestExpiry}.`,
      blockerCodes: item.blockers,
      nearestExpiry: item.worker.nearestExpiry,
      recommendedAction: complianceAgentRecommendation(
        item.blockers,
        Boolean(item.worker.nearestExpiry)
      ),
      actionPath: item.blockers.includes("NO_APPLICABLE_REQUIREMENT_SET")
        ? "/agency/compliance"
        : `/agency/workers/${item.worker.membershipId}`,
      requiresHumanConfirmation: true,
    })),
    guardrails: COMPLIANCE_AGENT_GUARDRAILS,
  };
}
