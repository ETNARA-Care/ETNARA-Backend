import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import {
  evaluateWorkerEligibility,
  NoApplicableRequirementSetError,
} from "../eligibility/eligibility.service.js";

export class WorkforcePlanningForbiddenError extends Error {
  constructor() {
    super("WORKFORCE_PLANNING_FORBIDDEN");
    this.name = "WorkforcePlanningForbiddenError";
  }
}

export const workforceForecastSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.coerce.number().int().refine((value) => [7, 14, 30].includes(value)),
  timezone: z.string().trim().min(1).max(80).default("America/Puerto_Rico"),
});

export type WorkforceForecastInput = z.infer<typeof workforceForecastSchema>;

interface DemandRow {
  day: string;
  required_role: string;
  required_minutes: number;
  total_shifts: number;
  uncovered_shifts: number;
}

interface WorkerRow {
  membership_id: string;
  display_name: string | null;
  internal_role: string;
  availability_configured: boolean;
}

interface CapacityRow {
  day: string;
  membership_id: string;
  available_minutes: number;
}

export interface CredentialRisk {
  membershipId: string;
  displayName: string | null;
  internalRole: string;
  credentialTypeCode: string;
  expiresAt: string;
}

type RiskLevel = "stable" | "watch" | "high" | "critical";

export interface RoleForecast {
  role: string;
  requiredMinutes: number;
  knownAvailableMinutes: number;
  coverageGapMinutes: number;
  totalShifts: number;
  uncoveredShifts: number;
  eligibleWorkers: number;
  unknownAvailabilityWorkers: number;
}

export interface DailyWorkforceForecast {
  date: string;
  risk: RiskLevel;
  requiredMinutes: number;
  knownAvailableMinutes: number;
  coverageGapMinutes: number;
  totalShifts: number;
  uncoveredShifts: number;
  unknownAvailabilityWorkers: number;
  roles: RoleForecast[];
  explanations: string[];
  recommendedActions: string[];
}

function normalizeRole(value: string): string {
  return value.trim().toLocaleLowerCase("es");
}

function isoDates(startDate: string, days: number): string[] {
  const start = new Date(`${startDate}T12:00:00.000Z`);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

function riskFor(coverageGapMinutes: number, uncoveredShifts: number): RiskLevel {
  if (uncoveredShifts > 0 && coverageGapMinutes > 0) return "critical";
  if (coverageGapMinutes > 0) return "high";
  if (uncoveredShifts > 0) return "watch";
  return "stable";
}

export async function getWorkforceForecast(
  userId: string,
  organizationId: string,
  input: WorkforceForecastInput
) {
  const raw = await withTenantContext({ userId, organizationId }, async (trx) => {
    const manager = await sql<{ is_manager: boolean }>`SELECT app_is_org_manager() AS is_manager`.execute(trx);
    if (!manager.rows[0]?.is_manager) throw new WorkforcePlanningForbiddenError();

    // PostgreSQL validates the IANA timezone before any operational query.
    const timezoneCheck = await sql<{ valid: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ${input.timezone}) AS valid
    `.execute(trx);
    if (!timezoneCheck.rows[0]?.valid) throw new RangeError("INVALID_TIMEZONE");

    const demand = await sql<DemandRow>`
      SELECT
        (s.scheduled_start AT TIME ZONE ${input.timezone})::date::text AS day,
        s.required_role,
        sum(extract(epoch FROM (s.scheduled_end - s.scheduled_start)) / 60)::int AS required_minutes,
        count(*)::int AS total_shifts,
        count(*) FILTER (
          WHERE NOT EXISTS (
            SELECT 1 FROM assignments a
            WHERE a.shift_id = s.id AND a.response_status IN ('pending', 'accepted')
          )
        )::int AS uncovered_shifts
      FROM shifts s
      WHERE s.organization_id = ${organizationId}
        AND s.status != 'cancelled'
        AND (s.scheduled_start AT TIME ZONE ${input.timezone})::date >= ${input.startDate}::date
        AND (s.scheduled_start AT TIME ZONE ${input.timezone})::date < ${input.startDate}::date + ${input.days}::integer
      GROUP BY day, s.required_role
      ORDER BY day, s.required_role
    `.execute(trx);

    const workers = await sql<WorkerRow>`
      SELECT
        owm.id AS membership_id,
        w.display_name,
        owm.internal_role,
        EXISTS (
          SELECT 1 FROM worker_availability_settings settings
          WHERE settings.organization_worker_membership_id = owm.id
        ) AS availability_configured
      FROM organization_worker_memberships owm
      JOIN workers w ON w.id = owm.worker_id
      WHERE owm.organization_id = ${organizationId} AND owm.status = 'active'
      ORDER BY owm.internal_role, w.display_name NULLS LAST
    `.execute(trx);

    const capacity = await sql<CapacityRow>`
      WITH forecast_dates AS (
        SELECT generate_series(
          ${input.startDate}::date,
          ${input.startDate}::date + (${input.days}::integer - 1),
          interval '1 day'
        )::date AS day
      )
      SELECT
        dates.day::text AS day,
        owm.id AS membership_id,
        COALESCE(sum(
          GREATEST(
            0,
            extract(epoch FROM (
              ((dates.day + weekly.end_time) AT TIME ZONE settings.timezone)
              - ((dates.day + weekly.start_time) AT TIME ZONE settings.timezone)
            )) / 60
            - COALESCE((
              SELECT sum(GREATEST(
                0,
                extract(epoch FROM (
                  LEAST(unavailable.ends_at, ((dates.day + weekly.end_time) AT TIME ZONE settings.timezone))
                  - GREATEST(unavailable.starts_at, ((dates.day + weekly.start_time) AT TIME ZONE settings.timezone))
                )) / 60
              ))
              FROM worker_unavailability_periods unavailable
              WHERE unavailable.organization_worker_membership_id = owm.id
                AND unavailable.starts_at < ((dates.day + weekly.end_time) AT TIME ZONE settings.timezone)
                AND unavailable.ends_at > ((dates.day + weekly.start_time) AT TIME ZONE settings.timezone)
            ), 0)
          )
        ), 0)::int AS available_minutes
      FROM forecast_dates dates
      CROSS JOIN organization_worker_memberships owm
      JOIN worker_availability_settings settings
        ON settings.organization_worker_membership_id = owm.id
      LEFT JOIN worker_weekly_availability weekly
        ON weekly.organization_worker_membership_id = owm.id
       AND weekly.weekday = extract(dow FROM dates.day)::int
      WHERE owm.organization_id = ${organizationId} AND owm.status = 'active'
      GROUP BY dates.day, owm.id
      ORDER BY dates.day, owm.id
    `.execute(trx);

    const credentialRisks = await sql<{
      membership_id: string;
      display_name: string | null;
      internal_role: string;
      type_code: string;
      expires_at: string;
    }>`
      WITH latest_credentials AS (
        SELECT DISTINCT ON (c.worker_id, c.credential_type_id)
          c.worker_id, c.credential_type_id, c.status, c.expires_at, c.created_at
        FROM credentials c
        WHERE c.status != 'revoked'
        ORDER BY c.worker_id, c.credential_type_id, c.created_at DESC
      )
      SELECT owm.id AS membership_id, w.display_name, owm.internal_role,
             ct.code AS type_code, latest.expires_at::text
      FROM organization_worker_memberships owm
      JOIN workers w ON w.id = owm.worker_id
      JOIN latest_credentials latest ON latest.worker_id = w.id AND latest.status = 'active'
      JOIN credential_types ct ON ct.id = latest.credential_type_id
      WHERE owm.organization_id = ${organizationId} AND owm.status = 'active'
        AND latest.expires_at >= ${input.startDate}::date
        AND latest.expires_at < ${input.startDate}::date + ${input.days}::integer
      ORDER BY latest.expires_at, w.display_name NULLS LAST
    `.execute(trx);

    return {
      demand: demand.rows,
      workers: workers.rows,
      capacity: capacity.rows,
      credentialRisks: credentialRisks.rows,
    };
  });

  const eligibility = new Map<string, boolean>();
  for (const worker of raw.workers) {
    try {
      const result = await evaluateWorkerEligibility(userId, organizationId, worker.membership_id);
      eligibility.set(worker.membership_id, result.eligibilityStatus === "eligible");
    } catch (error) {
      if (!(error instanceof NoApplicableRequirementSetError)) throw error;
      eligibility.set(worker.membership_id, false);
    }
  }

  const eligibleWorkers = raw.workers.filter((worker) => eligibility.get(worker.membership_id));
  const capacityByDayAndWorker = new Map(
    raw.capacity.map((row) => [`${row.day}:${row.membership_id}`, Number(row.available_minutes)])
  );
  const demandByDay = new Map<string, DemandRow[]>();
  for (const row of raw.demand) {
    const rows = demandByDay.get(row.day) ?? [];
    rows.push(row);
    demandByDay.set(row.day, rows);
  }

  const dates = isoDates(input.startDate, input.days);
  const days: DailyWorkforceForecast[] = dates.map((date) => {
    const demandRows = demandByDay.get(date) ?? [];
    const generalRoleKey = normalizeRole("Cuidador/a");
    const workerCapacity = new Map(
      eligibleWorkers.map((worker) => [worker.membership_id, worker.availability_configured
        ? (capacityByDayAndWorker.get(`${date}:${worker.membership_id}`) ?? 0)
        : 0])
    );
    const roleForecast = (demand: DemandRow, generalCapacity?: number): RoleForecast => {
      const roleKey = normalizeRole(demand.required_role);
      const roleWorkers = eligibleWorkers.filter((worker) =>
        roleKey === generalRoleKey || normalizeRole(worker.internal_role) === roleKey
      );
      const configuredWorkers = roleWorkers.filter((worker) => worker.availability_configured);
      const knownAvailableMinutes = generalCapacity ?? configuredWorkers.reduce(
        (total, worker) => total + (workerCapacity.get(worker.membership_id) ?? 0), 0
      );
      const requiredMinutes = Number(demand.required_minutes);
      return {
        role: demand.required_role,
        requiredMinutes,
        knownAvailableMinutes,
        coverageGapMinutes: Math.max(0, requiredMinutes - knownAvailableMinutes),
        totalShifts: Number(demand.total_shifts),
        uncoveredShifts: Number(demand.uncovered_shifts),
        eligibleWorkers: roleWorkers.length,
        unknownAvailabilityWorkers: roleWorkers.length - configuredWorkers.length,
      } satisfies RoleForecast;
    };
    const specificDemand = demandRows.filter((row) => normalizeRole(row.required_role) !== generalRoleKey);
    const specificRoles = specificDemand.map((row) => roleForecast(row));
    const allKnownCapacity = [...workerCapacity.values()].reduce((total, minutes) => total + minutes, 0);
    const capacityReservedForSpecificRoles = specificRoles.reduce(
      (total, role) => total + Math.min(role.requiredMinutes, role.knownAvailableMinutes), 0
    );
    const generalDemand = demandRows.find((row) => normalizeRole(row.required_role) === generalRoleKey);
    const roles = generalDemand
      ? [...specificRoles, roleForecast(generalDemand, Math.max(0, allKnownCapacity - capacityReservedForSpecificRoles))]
      : specificRoles;

    const requiredMinutes = roles.reduce((total, role) => total + role.requiredMinutes, 0);
    const knownAvailableMinutes = allKnownCapacity;
    const totalShifts = roles.reduce((total, role) => total + role.totalShifts, 0);
    const uncoveredShifts = roles.reduce((total, role) => total + role.uncoveredShifts, 0);
    const unknownAvailabilityWorkers = eligibleWorkers.filter((worker) => !worker.availability_configured).length;
    const coverageGapMinutes = roles.reduce((total, role) => total + role.coverageGapMinutes, 0);
    const risk = riskFor(coverageGapMinutes, uncoveredShifts);
    const explanations: string[] = [];
    const recommendedActions: string[] = [];

    if (requiredMinutes === 0) explanations.push("No hay turnos programados para este día.");
    else explanations.push(`${totalShifts} turno(s) requieren ${Math.round(requiredMinutes / 6) / 10} h de cuidado.`);
    if (coverageGapMinutes > 0) {
      explanations.push(`Faltan ${Math.round(coverageGapMinutes / 6) / 10} h de disponibilidad declarada.`);
      recommendedActions.push("Revisar horarios y disponibilidad del personal apto.");
    }
    if (uncoveredShifts > 0) {
      explanations.push(`${uncoveredShifts} turno(s) todavía no tienen cuidador asignado.`);
      recommendedActions.push("Abrir Turnos y comenzar la cobertura de los turnos sin asignar.");
    }
    if (unknownAvailabilityWorkers > 0) {
      explanations.push(`${unknownAvailabilityWorkers} cuidador(es) aptos aún no configuraron disponibilidad.`);
      recommendedActions.push("Solicitar que el personal complete su disponibilidad semanal.");
    }
    if (risk === "stable" && requiredMinutes > 0) recommendedActions.push("Mantener el plan y vigilar cambios de disponibilidad.");

    return {
      date,
      risk,
      requiredMinutes,
      knownAvailableMinutes,
      coverageGapMinutes,
      totalShifts,
      uncoveredShifts,
      unknownAvailabilityWorkers,
      roles,
      explanations,
      recommendedActions: [...new Set(recommendedActions)],
    };
  });

  const credentialRisks: CredentialRisk[] = raw.credentialRisks.map((row) => ({
    membershipId: row.membership_id,
    displayName: row.display_name,
    internalRole: row.internal_role,
    credentialTypeCode: row.type_code,
    expiresAt: row.expires_at,
  }));
  const riskyDays = days.filter((day) => day.risk === "high" || day.risk === "critical");
  const uncoveredShifts = days.reduce((total, day) => total + day.uncoveredShifts, 0);
  const assistantSummary = [
    riskyDays.length > 0
      ? `${riskyDays.length} día(s) presentan riesgo alto o crítico dentro del periodo.`
      : "No se detectaron déficits conocidos de capacidad dentro del periodo.",
    uncoveredShifts > 0
      ? `${uncoveredShifts} turno(s) continúan sin asignar y requieren decisión de Administración.`
      : "Todos los turnos programados tienen una asignación activa.",
    credentialRisks.length > 0
      ? `${credentialRisks.length} credencial(es) vencerán durante el periodo analizado.`
      : "No hay vencimientos de credenciales registrados dentro del periodo.",
  ];

  return {
    startDate: input.startDate,
    horizonDays: input.days,
    timezone: input.timezone,
    generatedAt: new Date().toISOString(),
    summary: {
      highRiskDays: riskyDays.length,
      uncoveredShifts,
      eligibleWorkers: eligibleWorkers.length,
      workersWithoutAvailability: eligibleWorkers.filter((worker) => !worker.availability_configured).length,
      credentialRisks: credentialRisks.length,
    },
    assistantSummary,
    credentialRisks,
    days,
  };
}
