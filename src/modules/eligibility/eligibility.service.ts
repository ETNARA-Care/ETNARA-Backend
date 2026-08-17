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
 * Requirement-set selection (documented simplification, matches "no motor
 * avanzado de reglas todavia"): prefer a requirement_set scoped to this
 * exact organization_id; fall back to the platform-global one
 * (organization_id IS NULL) if no org-specific set exists. If NEITHER
 * exists, there is nothing to evaluate against.
 */
async function findApplicableRequirementSet(trx: unknown, organizationId: string): Promise<string> {
  const orgSpecific = await sql<{ id: string }>`
    SELECT id FROM requirement_sets WHERE organization_id = ${organizationId} ORDER BY created_at LIMIT 1
  `.execute(trx as never);
  if (orgSpecific.rows[0]) return orgSpecific.rows[0].id;

  const global = await sql<{ id: string }>`
    SELECT id FROM requirement_sets WHERE organization_id IS NULL ORDER BY created_at LIMIT 1
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
    const membershipRow = await sql<{ id: string; worker_id: string; status: string }>`
      SELECT id, worker_id, status FROM organization_worker_memberships
      WHERE id = ${membershipId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    const membership = membershipRow.rows[0];
    if (!membership) throw new MembershipNotFoundError();

    const requirementSetId = await findApplicableRequirementSet(trx, organizationId);

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
      }>`
        SELECT id, status, expires_at FROM credentials
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
          const platformVerified = await sql<{ id: string }>`
            SELECT id FROM credential_platform_verifications
            WHERE credential_id = ${credential.id} AND status = 'verified'
            ORDER BY verified_at DESC LIMIT 1
          `.execute(trx);

          if (!platformVerified.rows[0]) {
            reason = "PLATFORM_VERIFICATION_MISSING";
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
      requiresOrganizationReview: r.requiresOrganizationReview,
    })),
  };
}
