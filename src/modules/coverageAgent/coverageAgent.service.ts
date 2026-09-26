import { sql } from "kysely";
import { withTenantContext } from "../../context/tenantContext.js";
import { recommendCoverage } from "../coverage/coverage.service.js";

export class CoverageAgentForbiddenError extends Error {
  constructor() {
    super("COVERAGE_AGENT_FORBIDDEN");
    this.name = "CoverageAgentForbiddenError";
  }
}

type CampaignStatus = "open" | "closed" | "cancelled" | "exhausted";
type CoverageSeverity = "critical" | "warning";

interface UncoveredShiftRow {
  id: string;
  care_recipient_id: string;
  recipient_name: string;
  scheduled_start: string;
  scheduled_end: string;
  required_role: string;
  campaign_status: CampaignStatus | null;
  current_wave: number | null;
  next_wave_at: string | null;
  pending_count: number;
  queued_count: number;
  interested_count: number;
}

const COVERAGE_AGENT_GUARDRAILS = [
  "No envía ofertas ni contacta al personal.",
  "No asigna ni cancela turnos.",
  "No cambia elegibilidad, disponibilidad ni campañas.",
  "Toda acción final requiere confirmación humana.",
] as const;

async function requireManager(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const manager = await sql<{ is_manager: boolean }>`
      SELECT app_is_org_manager() AS is_manager
    `.execute(trx);
    if (!manager.rows[0]?.is_manager) throw new CoverageAgentForbiddenError();
  });
}

async function listUncoveredShifts(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const manager = await sql<{ is_manager: boolean }>`
      SELECT app_is_org_manager() AS is_manager
    `.execute(trx);
    if (!manager.rows[0]?.is_manager) throw new CoverageAgentForbiddenError();

    const result = await sql<UncoveredShiftRow>`
      SELECT
        shift.id,
        shift.care_recipient_id,
        COALESCE(recipient.preferred_name, recipient.first_name || ' ' || recipient.last_name) AS recipient_name,
        shift.scheduled_start,
        shift.scheduled_end,
        shift.required_role,
        campaign.status AS campaign_status,
        campaign.current_wave,
        campaign.next_wave_at,
        COALESCE(campaign.pending_count, 0)::int AS pending_count,
        COALESCE(campaign.queued_count, 0)::int AS queued_count,
        COALESCE(campaign.interested_count, 0)::int AS interested_count
      FROM shifts shift
      JOIN care_recipients recipient ON recipient.id = shift.care_recipient_id
      LEFT JOIN LATERAL (
        SELECT
          latest.status,
          latest.current_wave,
          latest.next_wave_at,
          count(*) FILTER (WHERE offer.response_status = 'pending')::int AS pending_count,
          count(*) FILTER (WHERE offer.response_status = 'queued')::int AS queued_count,
          count(*) FILTER (WHERE offer.response_status = 'interested')::int AS interested_count
        FROM coverage_campaigns latest
        LEFT JOIN coverage_offers offer ON offer.coverage_campaign_id = latest.id
        WHERE latest.organization_id = ${organizationId}
          AND latest.shift_id = shift.id
        GROUP BY latest.id
        ORDER BY latest.created_at DESC
        LIMIT 1
      ) campaign ON true
      WHERE shift.organization_id = ${organizationId}
        AND shift.status = 'unassigned'
        AND shift.care_recipient_id IS NOT NULL
        AND shift.scheduled_start >= now()
        AND shift.scheduled_start < now() + interval '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM assignments assignment
          WHERE assignment.shift_id = shift.id
            AND assignment.organization_id = ${organizationId}
            AND assignment.response_status = 'accepted'
        )
      ORDER BY shift.scheduled_start, shift.id
    `.execute(trx);
    return result.rows;
  });
}

function recommendedAction(shift: UncoveredShiftRow, candidateCount: number): string {
  if (shift.interested_count > 0) {
    return "Revisar las respuestas interesadas y confirmar manualmente una asignación.";
  }
  if (shift.campaign_status === "open" && (shift.pending_count > 0 || shift.queued_count > 0)) {
    return "Dar seguimiento a la campaña activa; la asignación final sigue siendo manual.";
  }
  if (candidateCount === 0) {
    return "Revisar cumplimiento, disponibilidad y planificación antes de intentar cobertura.";
  }
  if (shift.campaign_status === "exhausted") {
    return "Revisar las opciones elegibles actuales y reintentar la campaña si corresponde.";
  }
  return "Abrir el turno e iniciar manualmente una campaña con las opciones elegibles.";
}

export async function generateCoverageAgentBriefing(userId: string, organizationId: string) {
  await requireManager(userId, organizationId);
  const shifts = await listUncoveredShifts(userId, organizationId);
  const now = Date.now();
  const analyzed = await Promise.all(shifts.map(async (shift) => {
    const candidates = await recommendCoverage(userId, organizationId, {
      careRecipientId: shift.care_recipient_id,
      scheduledStart: shift.scheduled_start,
      scheduledEnd: shift.scheduled_end,
      requiredRole: shift.required_role,
    });
    const eligibleCandidateCount = candidates.filter((candidate) => candidate.recommended).length;
    const hoursUntilStart = Math.max(0, (new Date(shift.scheduled_start).getTime() - now) / 3_600_000);
    return {
      shift,
      eligibleCandidateCount,
      hoursUntilStart,
      severity: (hoursUntilStart < 24 ? "critical" : "warning") as CoverageSeverity,
    };
  }));

  analyzed.sort((left, right) =>
    (left.severity === right.severity ? 0 : left.severity === "critical" ? -1 : 1)
    || (right.shift.interested_count - left.shift.interested_count)
    || (left.eligibleCandidateCount - right.eligibleCandidateCount)
    || (left.hoursUntilStart - right.hoursUntilStart)
  );

  const selected = analyzed.slice(0, 5);
  const urgentShiftCount = analyzed.filter((item) => item.severity === "critical").length;
  const actionableShiftCount = analyzed.filter((item) =>
    item.shift.interested_count > 0
    || item.shift.campaign_status !== "open"
    || (item.shift.pending_count === 0 && item.shift.queued_count === 0)
  ).length;

  const recorded = await withTenantContext({ userId, organizationId }, async (trx) => {
    const manager = await sql<{ is_manager: boolean }>`SELECT app_is_org_manager() AS is_manager`.execute(trx);
    if (!manager.rows[0]?.is_manager) throw new CoverageAgentForbiddenError();
    return sql<{ id: string }>`
      SELECT app_record_coverage_agent_run(
        ${organizationId},
        ${analyzed.length},
        ${urgentShiftCount},
        ${actionableShiftCount},
        CAST(${JSON.stringify(selected.map((item) => item.shift.id))} AS jsonb)
      ) id
    `.execute(trx);
  });

  const headline = urgentShiftCount > 0
    ? `${urgentShiftCount} turno${urgentShiftCount === 1 ? " comienza" : "s comienzan"} en menos de 24 horas sin cobertura.`
    : analyzed.length > 0
      ? `${analyzed.length} turno${analyzed.length === 1 ? " requiere" : "s requieren"} seguimiento de cobertura.`
      : "No hay turnos sin cubrir en los próximos siete días.";

  return {
    runId: recorded.rows[0].id,
    generatedAt: new Date().toISOString(),
    mode: "advisory" as const,
    headline,
    narrative: analyzed.length > 0
      ? `Analicé ${analyzed.length} turno${analyzed.length === 1 ? "" : "s"}, las campañas vigentes y las opciones elegibles actuales. No envié ofertas ni hice asignaciones.`
      : "Revisé los turnos reales de los próximos siete días y no encontré brechas de cobertura.",
    summary: {
      uncoveredShifts: analyzed.length,
      urgentShifts: urgentShiftCount,
      actionableShifts: actionableShiftCount,
    },
    priorities: selected.map((item, index) => ({
      rank: index + 1,
      shiftId: item.shift.id,
      recipientName: item.shift.recipient_name,
      scheduledStart: item.shift.scheduled_start,
      scheduledEnd: item.shift.scheduled_end,
      requiredRole: item.shift.required_role,
      severity: item.severity,
      eligibleCandidateCount: item.eligibleCandidateCount,
      campaignStatus: item.shift.campaign_status,
      currentWave: item.shift.current_wave,
      interestedCount: item.shift.interested_count,
      pendingCount: item.shift.pending_count,
      queuedCount: item.shift.queued_count,
      reason: item.severity === "critical"
        ? "El turno comienza en menos de 24 horas y todavía no tiene una asignación aceptada."
        : "El turno comienza dentro de siete días y todavía no tiene una asignación aceptada.",
      recommendedAction: recommendedAction(item.shift, item.eligibleCandidateCount),
      actionPath: `/agency/shifts/${item.shift.id}`,
      requiresHumanConfirmation: true,
    })),
    guardrails: COVERAGE_AGENT_GUARDRAILS,
  };
}
