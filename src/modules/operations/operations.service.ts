import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";

export class OperationsForbiddenError extends Error {
  constructor() {
    super("OPERATIONS_FORBIDDEN");
  }
}

export const escalationSchema = z.object({
  alertKey: z.string().min(1).max(200),
  category: z.enum([
    "uncovered_shift",
    "missed_check_in",
    "expiring_credential",
    "open_incident",
    "pending_timesheet",
  ]),
  relatedEntityType: z.string().min(1).max(50),
  relatedEntityId: z.string().uuid(),
});

type AlertCategory = z.infer<typeof escalationSchema>["category"];
type AlertSeverity = "critical" | "warning" | "info";

export type OperationalAlert = {
  key: string;
  category: AlertCategory;
  severity: AlertSeverity;
  title: string;
  detail: string;
  relatedEntityType: string;
  relatedEntityId: string;
  actionPath: string;
  occurredAt: string;
  escalatedAt: string | null;
};

type OperationsCenter = {
  generatedAt: string;
  summary: { total: number; critical: number; warning: number; info: number };
  alerts: OperationalAlert[];
};

const AGENT_GUARDRAILS = [
  "No asigna ni cancela turnos.",
  "No aprueba credenciales, incidentes ni horas.",
  "No toma decisiones clínicas.",
  "Toda acción final requiere confirmación humana.",
];

async function requireManager(trx: unknown): Promise<void> {
  const result = await sql<{ ok: boolean }>`SELECT app_is_org_manager() ok`.execute(trx as never);
  if (!result.rows[0]?.ok) throw new OperationsForbiddenError();
}

async function buildOperationsCenter(trx: unknown, organizationId: string): Promise<OperationsCenter> {
  const shifts = await sql<any>`
    SELECT s.id, s.scheduled_start, s.scheduled_end,
      trim(concat_ws(' ', cr.first_name, cr.last_name)) recipient,
      EXISTS (
        SELECT 1 FROM assignments a
        WHERE a.shift_id = s.id
          AND a.organization_id = s.organization_id
          AND a.response_status = 'accepted'
      ) accepted,
      EXISTS (
        SELECT 1 FROM verification_events v
        WHERE v.shift_id = s.id AND v.event_type = 'check_in'
      ) checked_in
    FROM shifts s
    LEFT JOIN care_recipients cr ON cr.id = s.care_recipient_id
    WHERE s.organization_id = ${organizationId}
      AND s.status <> 'cancelled'
      AND s.scheduled_end > now()
      AND s.scheduled_start < now() + interval '7 days'
  `.execute(trx as never);

  const credentials = await sql<any>`
    SELECT c.id, c.expires_at, w.display_name
    FROM credentials c
    JOIN workers w ON w.id = c.worker_id
    JOIN organization_worker_memberships m ON m.worker_id = w.id
    WHERE m.organization_id = ${organizationId}
      AND m.status = 'active'
      AND c.status = 'active'
      AND c.expires_at BETWEEN current_date AND current_date + 30
  `.execute(trx as never);

  const incidents = await sql<any>`
    SELECT i.id, i.created_at, i.severity,
      trim(concat_ws(' ', cr.first_name, cr.last_name)) recipient
    FROM incidents i
    JOIN care_recipients cr ON cr.id = i.care_recipient_id
    WHERE i.organization_id = ${organizationId} AND i.status <> 'resolved'
  `.execute(trx as never);

  const sheets = await sql<any>`
    SELECT t.id, t.created_at, t.status, w.display_name
    FROM timesheets t
    JOIN organization_worker_memberships m ON m.id = t.organization_worker_membership_id
    JOIN workers w ON w.id = m.worker_id
    WHERE t.organization_id = ${organizationId} AND t.status IN ('pending', 'disputed')
  `.execute(trx as never);

  const escalations = await sql<any>`
    SELECT alert_key, escalated_at
    FROM operational_alert_escalations
    WHERE organization_id = ${organizationId}
  `.execute(trx as never);
  const escalatedAt = new Map<string, string>(
    escalations.rows.map((row: any) => [row.alert_key, row.escalated_at])
  );

  const alerts: OperationalAlert[] = [];
  const now = Date.now();

  for (const shift of shifts.rows) {
    const start = new Date(shift.scheduled_start).getTime();
    if (!shift.accepted) {
      const key = `uncovered_shift:${shift.id}`;
      alerts.push({
        key,
        category: "uncovered_shift",
        severity: start - now < 86_400_000 ? "critical" : "warning",
        title: "Turno sin cubrir",
        detail: `${shift.recipient || "Residente"} · ${new Date(shift.scheduled_start).toLocaleString("es-PR")}`,
        relatedEntityType: "shift",
        relatedEntityId: shift.id,
        actionPath: `/agency/shifts/${shift.id}`,
        occurredAt: shift.scheduled_start,
        escalatedAt: escalatedAt.get(key) || null,
      });
    } else if (
      start < now - 900_000
      && !shift.checked_in
      && new Date(shift.scheduled_end).getTime() > now
    ) {
      const key = `missed_check_in:${shift.id}`;
      alerts.push({
        key,
        category: "missed_check_in",
        severity: "critical",
        title: "Falta registrar entrada",
        detail: `${shift.recipient || "Residente"} · turno iniciado`,
        relatedEntityType: "shift",
        relatedEntityId: shift.id,
        actionPath: `/agency/shifts/${shift.id}`,
        occurredAt: shift.scheduled_start,
        escalatedAt: escalatedAt.get(key) || null,
      });
    }
  }

  for (const credential of credentials.rows) {
    const key = `expiring_credential:${credential.id}`;
    alerts.push({
      key,
      category: "expiring_credential",
      severity: "warning",
      title: "Credencial próxima a vencer",
      detail: `${credential.display_name || "Cuidador"} · vence ${credential.expires_at}`,
      relatedEntityType: "credential",
      relatedEntityId: credential.id,
      actionPath: "/agency/compliance",
      occurredAt: credential.expires_at,
      escalatedAt: escalatedAt.get(key) || null,
    });
  }

  for (const incident of incidents.rows) {
    const key = `open_incident:${incident.id}`;
    alerts.push({
      key,
      category: "open_incident",
      severity: String(incident.severity).toLowerCase().includes("high") ? "critical" : "warning",
      title: "Incidente pendiente",
      detail: `${incident.recipient || "Residente"} · ${incident.severity}`,
      relatedEntityType: "incident",
      relatedEntityId: incident.id,
      actionPath: `/agency/incidents/${incident.id}`,
      occurredAt: incident.created_at,
      escalatedAt: escalatedAt.get(key) || null,
    });
  }

  for (const timesheet of sheets.rows) {
    const key = `pending_timesheet:${timesheet.id}`;
    alerts.push({
      key,
      category: "pending_timesheet",
      severity: timesheet.status === "disputed" ? "warning" : "info",
      title: timesheet.status === "disputed" ? "Horas en disputa" : "Horas por revisar",
      detail: timesheet.display_name || "Cuidador",
      relatedEntityType: "timesheet",
      relatedEntityId: timesheet.id,
      actionPath: "/agency/timesheets",
      occurredAt: timesheet.created_at,
      escalatedAt: escalatedAt.get(key) || null,
    });
  }

  const rank: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
  alerts.sort((left, right) =>
    rank[left.severity] - rank[right.severity]
    || new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime()
  );
  const summary = {
    total: alerts.length,
    critical: alerts.filter((alert) => alert.severity === "critical").length,
    warning: alerts.filter((alert) => alert.severity === "warning").length,
    info: alerts.filter((alert) => alert.severity === "info").length,
  };
  return { generatedAt: new Date().toISOString(), summary, alerts };
}

function agentAdvice(alert: OperationalAlert): { reason: string; recommendedAction: string } {
  switch (alert.category) {
    case "missed_check_in":
      return {
        reason: "El turno ya comenzó y todavía no existe una entrada registrada.",
        recommendedAction: "Verificar el estado del turno y contactar al personal asignado.",
      };
    case "uncovered_shift":
      return {
        reason: alert.severity === "critical"
          ? "El turno comienza en menos de 24 horas y continúa sin personal aceptado."
          : "El turno está dentro de los próximos siete días y continúa sin cubrir.",
        recommendedAction: "Abrir el turno y revisar cobertura elegible antes de asignar.",
      };
    case "open_incident":
      return {
        reason: "El incidente permanece abierto y requiere revisión administrativa.",
        recommendedAction: "Revisar los hechos y decidir el seguimiento correspondiente.",
      };
    case "expiring_credential":
      return {
        reason: "Una credencial activa vence dentro de los próximos 30 días.",
        recommendedAction: "Revisar cumplimiento y solicitar renovación si corresponde.",
      };
    case "pending_timesheet":
      return {
        reason: alert.title.includes("disputa")
          ? "Las horas están en disputa y necesitan resolución administrativa."
          : "Las horas registradas todavía esperan revisión administrativa.",
        recommendedAction: "Abrir las horas, verificar el registro y tomar una decisión humana.",
      };
  }
}

export async function getOperationsCenter(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    return buildOperationsCenter(trx, organizationId);
  });
}

export async function generateOperationsAgentBriefing(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    const center = await buildOperationsCenter(trx, organizationId);
    const selected = center.alerts.slice(0, 5);
    const priorityKeys = selected.map((alert) => alert.key);
    const recorded = await sql<{ id: string }>`
      SELECT app_record_operational_agent_run(
        ${organizationId},
        ${center.summary.total},
        ${center.summary.critical},
        ${center.summary.warning},
        CAST(${JSON.stringify(priorityKeys)} AS jsonb)
      ) id
    `.execute(trx);

    const headline = center.summary.critical > 0
      ? `Atiende primero ${center.summary.critical} alerta${center.summary.critical === 1 ? " crítica" : "s críticas"}.`
      : center.summary.warning > 0
        ? `Hay ${center.summary.warning} asunto${center.summary.warning === 1 ? "" : "s"} que requiere${center.summary.warning === 1 ? "" : "n"} atención.`
        : center.summary.info > 0
          ? "La operación no tiene riesgos críticos; quedan revisiones rutinarias."
          : "La operación está al día y no requiere acciones prioritarias.";

    return {
      runId: recorded.rows[0].id,
      generatedAt: center.generatedAt,
      mode: "advisory" as const,
      headline,
      narrative: center.summary.total > 0
        ? `Analicé ${center.summary.total} alerta${center.summary.total === 1 ? " activa" : "s activas"} de turnos, cumplimiento, incidentes y horas. Organicé las más urgentes sin ejecutar cambios.`
        : "Analicé los registros operacionales actuales y no encontré alertas activas.",
      priorities: selected.map((alert, index) => ({
        rank: index + 1,
        alertKey: alert.key,
        category: alert.category,
        severity: alert.severity,
        title: alert.title,
        detail: alert.detail,
        ...agentAdvice(alert),
        actionPath: alert.actionPath,
        requiresHumanConfirmation: true,
      })),
      guardrails: AGENT_GUARDRAILS,
    };
  });
}

export async function escalateOperationalAlert(
  userId: string,
  organizationId: string,
  input: z.infer<typeof escalationSchema>
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireManager(trx);
    const result = await sql<{ id: string }>`
      SELECT app_escalate_operational_alert(
        ${organizationId},
        ${input.alertKey},
        ${input.category},
        ${input.relatedEntityType},
        ${input.relatedEntityId}
      ) id
    `.execute(trx);
    return { id: result.rows[0].id };
  });
}
