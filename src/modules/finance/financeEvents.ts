import { sql } from "kysely";

/**
 * ETNARA Finanzas (migration 118). Financial values live in finance_events,
 * which only the agency's ORGANIZATION_ADMIN can read and nobody can change.
 * audit_log keeps the general trail with identifiers only, never amounts.
 */

/** Agency days are Puerto Rico days (not UTC days) for every financial range. */
export const AGENCY_TIME_ZONE = "America/Puerto_Rico";

export interface FinanceEvent {
  organizationId: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  previousValue?: unknown;
  newValue?: unknown;
}

export async function recordFinanceEvent(trx: unknown, event: FinanceEvent): Promise<void> {
  await sql`
    INSERT INTO finance_events (
      organization_id, actor_user_id, action, entity_type, entity_id, previous_value, new_value
    ) VALUES (
      ${event.organizationId}, ${event.actorUserId}, ${event.action}, ${event.entityType}, ${event.entityId},
      ${event.previousValue === undefined ? null : JSON.stringify(event.previousValue)}::jsonb,
      ${event.newValue === undefined ? null : JSON.stringify(event.newValue)}::jsonb
    )
  `.execute(trx as never);
}

/** audit_log entry for a financial action: who, what and which record, no amounts. */
export async function recordFinancialAudit(
  trx: unknown,
  entry: { organizationId: string; actorUserId: string; action: string; entityType: string; entityId: string; reference?: Record<string, string | number | null> },
): Promise<void> {
  await sql`
    INSERT INTO audit_log (
      actor_user_id, organization_id, target_organization_id,
      action, entity_type, entity_id, new_value
    ) VALUES (
      ${entry.actorUserId}, ${entry.organizationId}, ${entry.organizationId},
      ${entry.action}, ${entry.entityType}, ${entry.entityId},
      ${entry.reference ? JSON.stringify(entry.reference) : null}::jsonb
    )
  `.execute(trx as never);
}
