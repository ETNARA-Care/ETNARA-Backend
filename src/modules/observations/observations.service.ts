import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";

export class WorkerNotLinkedError extends Error {
  constructor() {
    super("USER_HAS_NO_WORKER_PROFILE");
    this.name = "WorkerNotLinkedError";
  }
}
export class RecipientNotFoundError extends Error {
  constructor() {
    super("RECIPIENT_NOT_FOUND");
    this.name = "RecipientNotFoundError";
  }
}
export class ObservationNotFoundError extends Error {
  constructor() {
    super("OBSERVATION_NOT_FOUND");
    this.name = "ObservationNotFoundError";
  }
}
export class CareEventNotInContextError extends Error {
  constructor() {
    super("CARE_EVENT_NOT_IN_CONTEXT");
    this.name = "CareEventNotInContextError";
  }
}
export class NotOrgManagerError extends Error {
  constructor() {
    super("REQUIRES_ORG_MANAGER");
    this.name = "NotOrgManagerError";
  }
}
export class InvalidObservationStatusTransitionError extends Error {
  constructor() {
    super("INVALID_STATUS_TRANSITION");
    this.name = "InvalidObservationStatusTransitionError";
  }
}

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

const OBSERVATION_CATEGORIES = [
  "low_appetite",
  "drowsiness",
  "confusion",
  "pain",
  "behavior_change",
  "reduced_mobility",
  "elimination_change",
  "emotional_state",
  "other",
] as const;

export const createObservationSchema = z.object({
  careRecipientId: z.string().uuid(),
  category: z.enum(OBSERVATION_CATEGORIES),
  description: z.string().trim().max(4000).optional(),
  careEventId: z.string().uuid().optional(),
});
export type CreateObservationInput = z.infer<typeof createObservationSchema>;

interface ObservationRow {
  id: string;
  organization_id: string;
  care_recipient_id: string;
  organization_worker_membership_id: string;
  care_event_id: string | null;
  category: string;
  description: string | null;
  status: string;
  created_at: string;
}

async function resolveWorkerForUser(trx: unknown, userId: string): Promise<string> {
  const result = await sql<{ id: string }>`SELECT id FROM workers WHERE user_id = ${userId} LIMIT 1`.execute(
    trx as never
  );
  if (!result.rows[0]) throw new WorkerNotLinkedError();
  return result.rows[0].id;
}

async function resolveMembership(trx: unknown, workerId: string, organizationId: string) {
  const result = await sql<{ id: string; status: string }>`
    SELECT id, status FROM organization_worker_memberships
    WHERE worker_id = ${workerId} AND organization_id = ${organizationId}
    LIMIT 1
  `.execute(trx as never);
  return result.rows[0] ?? null;
}

export async function createObservation(
  userId: string,
  organizationId: string,
  input: CreateObservationInput
): Promise<ObservationRow> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const workerId = await resolveWorkerForUser(trx, userId);
    const membership = await resolveMembership(trx, workerId, organizationId);
    if (!membership) throw new RecipientNotFoundError();
    if (membership.status !== "active") throw new MembershipNotActiveError("Membership not active");

    const recipientRow = await sql<{ id: string }>`
      SELECT id FROM care_recipients WHERE id = ${input.careRecipientId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!recipientRow.rows[0]) throw new RecipientNotFoundError();

    if (input.careEventId) {
      const eventRow = await sql<{ id: string }>`
        SELECT id FROM care_events
        WHERE id = ${input.careEventId} AND organization_id = ${organizationId} AND care_recipient_id = ${input.careRecipientId}
        LIMIT 1
      `.execute(trx);
      if (!eventRow.rows[0]) throw new CareEventNotInContextError();
    }

    const result = await sql<ObservationRow>`
      INSERT INTO observations (organization_id, care_recipient_id, organization_worker_membership_id, care_event_id, category, description)
      VALUES (${organizationId}, ${input.careRecipientId}, ${membership.id}, ${input.careEventId ?? null}, ${input.category}, ${input.description ?? null})
      RETURNING id, organization_id, care_recipient_id, organization_worker_membership_id, care_event_id, category, description, status, created_at
    `.execute(trx);
    return result.rows[0];
  });
}

export interface ListObservationsFilter {
  careRecipientId?: string;
  status?: string;
}

export async function listObservations(userId: string, organizationId: string, filter: ListObservationsFilter = {}) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const conditions = [sql`organization_id = ${organizationId}`];
    if (filter.careRecipientId) conditions.push(sql`care_recipient_id = ${filter.careRecipientId}`);
    if (filter.status) conditions.push(sql`status = ${filter.status}`);
    const result = await sql<ObservationRow>`
      SELECT id, organization_id, care_recipient_id, organization_worker_membership_id, care_event_id, category, description, status, created_at
      FROM observations
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY created_at DESC
    `.execute(trx);
    return result.rows;
  });
}

export async function getObservation(userId: string, organizationId: string, observationId: string) {
  assertUuid(observationId, "observationId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<ObservationRow>`
      SELECT id, organization_id, care_recipient_id, organization_worker_membership_id, care_event_id, category, description, status, created_at
      FROM observations WHERE id = ${observationId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!result.rows[0]) throw new ObservationNotFoundError();
    return result.rows[0];
  });
}

export async function markObservationReviewed(
  userId: string,
  organizationId: string,
  observationId: string
): Promise<ObservationRow> {
  assertUuid(observationId, "observationId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const managerCheck = await sql<{ exists: boolean }>`SELECT app_is_org_manager() as exists`.execute(trx);
    if (!managerCheck.rows[0]?.exists) throw new NotOrgManagerError();

    const current = await sql<{ status: string }>`
      SELECT status FROM observations WHERE id = ${observationId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!current.rows[0]) throw new ObservationNotFoundError();
    if (current.rows[0].status !== "open") throw new InvalidObservationStatusTransitionError();

    const result = await sql<ObservationRow>`
      UPDATE observations SET status = 'reviewed'
      WHERE id = ${observationId} AND organization_id = ${organizationId}
      RETURNING id, organization_id, care_recipient_id, organization_worker_membership_id, care_event_id, category, description, status, created_at
    `.execute(trx);
    return result.rows[0];
  });
}
