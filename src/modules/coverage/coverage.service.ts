import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { evaluateWorkerEligibility } from "../eligibility/eligibility.service.js";

export class CoverageRecommendationForbiddenError extends Error {
  constructor() {
    super("COVERAGE_RECOMMENDATION_FORBIDDEN");
    this.name = "CoverageRecommendationForbiddenError";
  }
}

export class CoverageRecipientNotFoundError extends Error {
  constructor() {
    super("CARE_RECIPIENT_NOT_FOUND");
    this.name = "CoverageRecipientNotFoundError";
  }
}

export const coverageRecommendationSchema = z
  .object({
    careRecipientId: z.string().uuid(),
    scheduledStart: z.string().datetime(),
    scheduledEnd: z.string().datetime(),
  })
  .refine((value) => new Date(value.scheduledStart).getTime() < new Date(value.scheduledEnd).getTime(), {
    message: "scheduledStart must be strictly before scheduledEnd",
  });

export type CoverageRecommendationInput = z.infer<typeof coverageRecommendationSchema>;

interface CandidateRow {
  membership_id: string;
  display_name: string | null;
  internal_role: string;
  has_schedule_conflict: boolean;
  continuity_count: number;
  scheduled_minutes_next_7_days: number;
}

export interface CoverageCandidate {
  membershipId: string;
  displayName: string | null;
  internalRole: string;
  eligibility: "eligible" | "not_eligible";
  hasScheduleConflict: boolean;
  continuityCount: number;
  scheduledMinutesNext7Days: number;
  recommended: boolean;
  rank: number | null;
  reasons: string[];
  blockers: string[];
}

export async function recommendCoverage(
  userId: string,
  organizationId: string,
  input: CoverageRecommendationInput
): Promise<CoverageCandidate[]> {
  const workers = await withTenantContext({ userId, organizationId }, async (trx) => {
    const manager = await sql<{ is_manager: boolean }>`SELECT app_is_org_manager() AS is_manager`.execute(trx);
    if (!manager.rows[0]?.is_manager) throw new CoverageRecommendationForbiddenError();

    const recipient = await sql<{ id: string }>`
      SELECT id FROM care_recipients
      WHERE id = ${input.careRecipientId} AND organization_id = ${organizationId} AND status = 'active'
      LIMIT 1
    `.execute(trx);
    if (!recipient.rows[0]) throw new CoverageRecipientNotFoundError();

    const result = await sql<CandidateRow>`
      SELECT
        owm.id AS membership_id,
        w.display_name,
        owm.internal_role,
        EXISTS (
          SELECT 1
          FROM assignments conflict_assignment
          JOIN shifts conflict_shift ON conflict_shift.id = conflict_assignment.shift_id
          WHERE conflict_assignment.organization_worker_membership_id = owm.id
            AND conflict_assignment.response_status IN ('pending', 'accepted')
            AND conflict_shift.status != 'cancelled'
            AND conflict_shift.scheduled_start < ${input.scheduledEnd}
            AND conflict_shift.scheduled_end > ${input.scheduledStart}
        ) AS has_schedule_conflict,
        COALESCE((
          SELECT count(*)::int
          FROM assignments history_assignment
          JOIN shifts history_shift ON history_shift.id = history_assignment.shift_id
          WHERE history_assignment.organization_worker_membership_id = owm.id
            AND history_assignment.response_status = 'accepted'
            AND history_shift.status = 'completed'
            AND history_shift.care_recipient_id = ${input.careRecipientId}
        ), 0)::int AS continuity_count,
        COALESCE((
          SELECT sum(extract(epoch FROM (load_shift.scheduled_end - load_shift.scheduled_start)) / 60)::int
          FROM assignments load_assignment
          JOIN shifts load_shift ON load_shift.id = load_assignment.shift_id
          WHERE load_assignment.organization_worker_membership_id = owm.id
            AND load_assignment.response_status IN ('pending', 'accepted')
            AND load_shift.status != 'cancelled'
            AND load_shift.scheduled_start >= ${input.scheduledStart}
            AND load_shift.scheduled_start < ${input.scheduledStart}::timestamptz + interval '7 days'
        ), 0)::int AS scheduled_minutes_next_7_days
      FROM organization_worker_memberships owm
      JOIN workers w ON w.id = owm.worker_id
      WHERE owm.organization_id = ${organizationId} AND owm.status = 'active'
      ORDER BY w.display_name NULLS LAST, owm.internal_role
    `.execute(trx);
    return result.rows;
  });

  const candidates: CoverageCandidate[] = [];
  for (const worker of workers) {
    const eligibility = await evaluateWorkerEligibility(userId, organizationId, worker.membership_id);
    const mandatoryFailures = eligibility.requirements
      .filter((requirement) => requirement.isMandatory && !requirement.satisfied)
      .map((requirement) => `${requirement.credentialTypeCode}: ${requirement.reason}`);
    const isEligible = eligibility.eligibilityStatus === "eligible";
    const recommended = isEligible && !worker.has_schedule_conflict;
    const reasons = isEligible ? ["Cumple los requisitos obligatorios"] : [];
    const blockers = [...mandatoryFailures];

    if (worker.has_schedule_conflict) blockers.push("Tiene otro turno que coincide con este horario");
    else reasons.push("No se encontró conflicto con otro turno");
    if (worker.continuity_count > 0) {
      reasons.push(`Continuidad: ${worker.continuity_count} turno(s) completado(s) con esta persona`);
    }
    const scheduledHours = Math.round((worker.scheduled_minutes_next_7_days / 60) * 10) / 10;
    reasons.push(`Carga próxima: ${scheduledHours} h programadas en 7 días`);

    candidates.push({
      membershipId: worker.membership_id,
      displayName: worker.display_name,
      internalRole: worker.internal_role,
      eligibility: isEligible ? "eligible" : "not_eligible",
      hasScheduleConflict: worker.has_schedule_conflict,
      continuityCount: worker.continuity_count,
      scheduledMinutesNext7Days: worker.scheduled_minutes_next_7_days,
      recommended,
      rank: null,
      reasons,
      blockers,
    });
  }

  candidates.sort((left, right) => {
    if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
    if (left.continuityCount !== right.continuityCount) return right.continuityCount - left.continuityCount;
    if (left.scheduledMinutesNext7Days !== right.scheduledMinutesNext7Days) {
      return left.scheduledMinutesNext7Days - right.scheduledMinutesNext7Days;
    }
    return (left.displayName ?? left.internalRole).localeCompare(right.displayName ?? right.internalRole, "es");
  });

  let rank = 0;
  return candidates.map((candidate) => {
    if (!candidate.recommended) return candidate;
    rank += 1;
    return { ...candidate, rank };
  });
}
