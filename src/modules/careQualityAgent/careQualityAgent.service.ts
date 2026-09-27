import { sql } from "kysely";
import { withTenantContext } from "../../context/tenantContext.js";

export class CareQualityAgentForbiddenError extends Error {
  constructor() {
    super("CARE_QUALITY_AGENT_FORBIDDEN");
    this.name = "CareQualityAgentForbiddenError";
  }
}

type QualitySeverity = "critical" | "warning" | "info";

interface ShiftQualityRow {
  id: string;
  care_recipient_id: string;
  recipient_name: string;
  scheduled_end: string;
  checked_in: boolean;
  checked_out: boolean;
  event_count: number;
  missing_required_codes: string[];
}

interface ObservationQualityRow {
  id: string;
  care_recipient_id: string;
  recipient_name: string;
  category: string;
  created_at: string;
}

interface IncidentQualityRow {
  id: string;
  recipient_name: string;
  severity: string;
  created_at: string;
}

interface QualityPriority {
  key: string;
  entityType: "shift" | "observation" | "incident";
  entityId: string;
  severity: QualitySeverity;
  title: string;
  detail: string;
  reason: string;
  recommendedAction: string;
  actionPath: string;
  occurredAt: string;
  requiresHumanConfirmation: true;
}

const CARE_QUALITY_GUARDRAILS = [
  "No crea ni edita notas de cuidado.",
  "No marca observaciones como revisadas ni resuelve incidentes.",
  "No emite diagnósticos ni conclusiones clínicas.",
  "Toda acción final requiere confirmación humana.",
] as const;

const EVENT_LABELS: Record<string, string> = {
  MEAL: "comida",
  HYDRATION: "hidratación",
  TOILETING: "baño o aseo",
  MOBILITY: "movilidad",
  ACTIVITY: "actividad",
  MOOD: "estado de ánimo",
  NOTE: "nota general",
  PHOTO: "foto",
};

const OBSERVATION_LABELS: Record<string, string> = {
  low_appetite: "apetito reducido",
  drowsiness: "somnolencia",
  confusion: "confusión",
  pain: "dolor",
  behavior_change: "cambio de conducta",
  reduced_mobility: "movilidad reducida",
  elimination_change: "cambio de eliminación",
  emotional_state: "estado emocional",
  other: "otra observación",
};

async function requireManager(trx: unknown): Promise<void> {
  const result = await sql<{ is_manager: boolean }>`
    SELECT app_is_org_manager() AS is_manager
  `.execute(trx as never);
  if (!result.rows[0]?.is_manager) throw new CareQualityAgentForbiddenError();
}

function shiftPriority(row: ShiftQualityRow): QualityPriority | null {
  const verificationIncomplete = !row.checked_in || !row.checked_out;
  const missingDocumentation = row.event_count === 0;
  const missingRequired = row.missing_required_codes.length > 0;
  if (!verificationIncomplete && !missingDocumentation && !missingRequired) return null;

  const reasons: string[] = [];
  if (!row.checked_in && !row.checked_out) reasons.push("No hay entrada ni salida verificadas");
  else if (!row.checked_in) reasons.push("Falta la entrada verificada");
  else if (!row.checked_out) reasons.push("Falta la salida verificada");
  if (missingDocumentation) reasons.push("No hay eventos de cuidado registrados");
  if (missingRequired) {
    const labels = row.missing_required_codes.map((code) => EVENT_LABELS[code] ?? code.toLocaleLowerCase("es"));
    reasons.push(`Faltan registros obligatorios de ${labels.join(", ")}`);
  }

  return {
    key: `shift:${row.id}`,
    entityType: "shift",
    entityId: row.id,
    severity: verificationIncomplete ? "critical" : "warning",
    title: verificationIncomplete ? "Verificación del turno incompleta" : "Documentación del turno incompleta",
    detail: `${row.recipient_name} · ${new Date(row.scheduled_end).toLocaleString("es-PR")}`,
    reason: `${reasons.join(". ")}.`,
    recommendedAction: "Abrir el turno, contrastar el registro con los hechos y solicitar la documentación que corresponda.",
    actionPath: `/agency/shifts/${row.id}`,
    occurredAt: row.scheduled_end,
    requiresHumanConfirmation: true,
  };
}

function observationPriority(row: ObservationQualityRow): QualityPriority {
  const olderThanDay = Date.now() - new Date(row.created_at).getTime() >= 86_400_000;
  return {
    key: `observation:${row.id}`,
    entityType: "observation",
    entityId: row.id,
    severity: olderThanDay ? "warning" : "info",
    title: "Observación pendiente de revisión",
    detail: `${row.recipient_name} · ${OBSERVATION_LABELS[row.category] ?? row.category}`,
    reason: olderThanDay
      ? "La observación continúa abierta después de 24 horas."
      : "La observación está abierta y todavía no consta una revisión administrativa.",
    recommendedAction: "Revisar el contexto del residente y decidir si se marca revisada o se escala a incidente.",
    actionPath: `/agency/residents/${row.care_recipient_id}`,
    occurredAt: row.created_at,
    requiresHumanConfirmation: true,
  };
}

function incidentPriority(row: IncidentQualityRow): QualityPriority {
  return {
    key: `incident:${row.id}`,
    entityType: "incident",
    entityId: row.id,
    severity: "warning",
    title: "Incidente sin seguimiento documentado",
    detail: `${row.recipient_name} · ${row.severity}`,
    reason: "El incidente permanece abierto sin acciones tomadas ni entradas de seguimiento.",
    recommendedAction: "Abrir el incidente, verificar los hechos y documentar el seguimiento administrativo correspondiente.",
    actionPath: `/agency/incidents/${row.id}`,
    occurredAt: row.created_at,
    requiresHumanConfirmation: true,
  };
}

export async function generateCareQualityAgentBriefing(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);

    const shifts = await sql<ShiftQualityRow>`
      SELECT
        shift.id,
        shift.care_recipient_id,
        COALESCE(recipient.preferred_name, trim(concat_ws(' ', recipient.first_name, recipient.last_name))) AS recipient_name,
        shift.scheduled_end,
        EXISTS (
          SELECT 1 FROM verification_events event
          WHERE event.shift_id = shift.id AND event.event_type = 'check_in'
        ) AS checked_in,
        EXISTS (
          SELECT 1 FROM verification_events event
          WHERE event.shift_id = shift.id AND event.event_type = 'check_out'
        ) AS checked_out,
        (SELECT count(*)::int FROM care_events event WHERE event.shift_id = shift.id) AS event_count,
        COALESCE((
          SELECT array_agg(event_type.code ORDER BY config.display_order NULLS LAST, event_type.code)
          FROM organization_care_event_types config
          JOIN care_event_types event_type ON event_type.id = config.care_event_type_id
          WHERE config.organization_id = ${organizationId}
            AND config.is_enabled = true
            AND config.is_required = true
            AND NOT EXISTS (
              SELECT 1 FROM care_events event
              WHERE event.shift_id = shift.id
                AND event.care_event_type_id = config.care_event_type_id
            )
        ), ARRAY[]::text[]) AS missing_required_codes
      FROM shifts shift
      JOIN care_recipients recipient ON recipient.id = shift.care_recipient_id
      WHERE shift.organization_id = ${organizationId}
        AND shift.status <> 'cancelled'
        AND shift.care_recipient_id IS NOT NULL
        AND shift.scheduled_end <= now()
        AND shift.scheduled_end >= now() - interval '7 days'
        AND EXISTS (
          SELECT 1 FROM assignments assignment
          WHERE assignment.shift_id = shift.id
            AND assignment.organization_id = ${organizationId}
            AND assignment.response_status = 'accepted'
        )
      ORDER BY shift.scheduled_end
    `.execute(trx);

    const observations = await sql<ObservationQualityRow>`
      SELECT observation.id, observation.care_recipient_id,
        COALESCE(recipient.preferred_name, trim(concat_ws(' ', recipient.first_name, recipient.last_name))) AS recipient_name,
        observation.category, observation.created_at
      FROM observations observation
      JOIN care_recipients recipient ON recipient.id = observation.care_recipient_id
      WHERE observation.organization_id = ${organizationId}
        AND observation.status = 'open'
        AND observation.created_at >= now() - interval '30 days'
      ORDER BY observation.created_at
    `.execute(trx);

    const incidents = await sql<IncidentQualityRow>`
      SELECT incident.id,
        COALESCE(recipient.preferred_name, trim(concat_ws(' ', recipient.first_name, recipient.last_name))) AS recipient_name,
        incident.severity, incident.created_at
      FROM incidents incident
      JOIN care_recipients recipient ON recipient.id = incident.care_recipient_id
      WHERE incident.organization_id = ${organizationId}
        AND incident.status <> 'resolved'
        AND incident.created_at >= now() - interval '30 days'
        AND NULLIF(trim(incident.actions_taken), '') IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM incident_timeline_entries entry
          WHERE entry.incident_id = incident.id
        )
      ORDER BY incident.created_at
    `.execute(trx);

    const shiftPriorities = shifts.rows.map(shiftPriority).filter((item): item is QualityPriority => item !== null);
    const priorities = [
      ...shiftPriorities,
      ...observations.rows.map(observationPriority),
      ...incidents.rows.map(incidentPriority),
    ];
    const rank: Record<QualitySeverity, number> = { critical: 0, warning: 1, info: 2 };
    priorities.sort((left, right) =>
      rank[left.severity] - rank[right.severity]
      || new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime()
    );
    const selected = priorities.slice(0, 5);

    const recorded = await sql<{ id: string }>`
      SELECT app_record_care_quality_agent_run(
        ${organizationId},
        ${shifts.rows.length},
        ${shiftPriorities.length},
        ${observations.rows.length},
        ${incidents.rows.length},
        CAST(${JSON.stringify(selected.map((item) => item.key))} AS jsonb)
      ) id
    `.execute(trx);

    const criticalCount = priorities.filter((item) => item.severity === "critical").length;
    return {
      runId: recorded.rows[0].id,
      generatedAt: new Date().toISOString(),
      mode: "advisory" as const,
      headline: criticalCount > 0
        ? `${criticalCount} registro${criticalCount === 1 ? " requiere" : "s requieren"} revisión prioritaria.`
        : priorities.length > 0
          ? `${priorities.length} asunto${priorities.length === 1 ? " requiere" : "s requieren"} seguimiento de calidad.`
          : "La documentación reciente no presenta faltantes detectables.",
      narrative: `Revisé ${shifts.rows.length} turno${shifts.rows.length === 1 ? " terminado" : "s terminados"}, observaciones abiertas e incidentes sin seguimiento usando registros reales. No modifiqué ningún expediente.`,
      summary: {
        reviewedShifts: shifts.rows.length,
        shiftsNeedingReview: shiftPriorities.length,
        openObservations: observations.rows.length,
        incidentsWithoutFollowUp: incidents.rows.length,
      },
      priorities: selected.map((priority, index) => ({ ...priority, rank: index + 1 })),
      guardrails: CARE_QUALITY_GUARDRAILS,
    };
  });
}
