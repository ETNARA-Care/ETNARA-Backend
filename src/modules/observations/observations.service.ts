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
/**
 * Thrown by the raw/full (non-curated) observation reads when the caller
 * is Family and only Family -- i.e. has no worker profile and is not an
 * org manager for this org. CRITICAL FIX (found via live testing, not
 * assumed): migration 038 grants Family row-level SELECT access to
 * observations for RECIPIENTS THEY ARE AUTHORIZED FOR, so it can (and
 * empirically does) leak full rows -- including the free-text
 * `description`, which may hold clinical/internal phrasing -- through
 * THIS endpoint if it isn't blocked here. Family must use the dedicated
 * family-safe endpoint (`listFamilyObservations`), which curates columns.
 */
export class FamilyMustUseFamilyEndpointError extends Error {
  constructor() {
    super("FAMILY_MUST_USE_FAMILY_SAFE_ENDPOINT");
    this.name = "FamilyMustUseFamilyEndpointError";
  }
}

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

/**
 * Staff = org manager (admin/supervisor) OR has an active worker
 * membership in this org. Anyone who is neither (i.e. a Family-only
 * caller) must be redirected to the family-safe, column-curated
 * endpoints instead of the raw ones this guards.
 */
async function assertStaffCaller(trx: unknown): Promise<void> {
  const check = await sql<{ is_staff: boolean }>`
    SELECT (
      app_is_org_manager()
      OR EXISTS (
        SELECT 1 FROM workers w
        JOIN organization_worker_memberships owm ON owm.worker_id = w.id AND owm.status = 'active'
        WHERE w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      )
    ) as is_staff
  `.execute(trx as never);
  if (!check.rows[0]?.is_staff) throw new FamilyMustUseFamilyEndpointError();
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
    await assertStaffCaller(trx);
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

export interface FamilyObservationItem {
  id: string;
  careRecipientId: string;
  category: string;
  status: string;
  createdAt: string;
}

/**
 * Family-safe view: category + status + timestamp only. The free-text
 * `description` field is deliberately NEVER returned here -- it may
 * contain clinical/internal phrasing not yet reviewed by a supervisor
 * (observations start as unreviewed "open" alerts), matching the
 * requirement that family never sees internal/clinical notes that aren't
 * meant for them. RLS (observations_family_read, migration 038) grants
 * row-level access; this function additionally narrows the columns
 * returned, the same defense-in-depth idiom already used for care_event
 * photo visibility (033).
 */
export async function listFamilyObservations(
  userId: string,
  organizationId: string,
  careRecipientId: string
): Promise<FamilyObservationItem[]> {
  assertUuid(careRecipientId, "careRecipientId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const relationship = await sql<{ id: string }>`
      SELECT id FROM family_relationships
      WHERE user_id = ${userId} AND organization_id = ${organizationId}
        AND care_recipient_id = ${careRecipientId} AND status = 'active'
      LIMIT 1
    `.execute(trx);
    if (!relationship.rows[0]) throw new RecipientNotFoundError();

    const result = await sql<{ id: string; care_recipient_id: string; category: string; status: string; created_at: string }>`
      SELECT id, care_recipient_id, category, status, created_at
      FROM observations
      WHERE organization_id = ${organizationId} AND care_recipient_id = ${careRecipientId}
      ORDER BY created_at DESC
    `.execute(trx);
    return result.rows.map((r) => ({
      id: r.id,
      careRecipientId: r.care_recipient_id,
      category: r.category,
      status: r.status,
      createdAt: r.created_at,
    }));
  });
}

export async function getObservation(userId: string, organizationId: string, observationId: string) {
  assertUuid(observationId, "observationId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertStaffCaller(trx);
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
