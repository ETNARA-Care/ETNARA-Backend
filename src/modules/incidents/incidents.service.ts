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
export class IncidentNotFoundError extends Error {
  constructor() {
    super("INCIDENT_NOT_FOUND");
    this.name = "IncidentNotFoundError";
  }
}
export class ObservationNotFoundError extends Error {
  constructor() {
    super("OBSERVATION_NOT_FOUND");
    this.name = "ObservationNotFoundError";
  }
}
export class ObservationAlreadyEscalatedError extends Error {
  constructor() {
    super("OBSERVATION_ALREADY_ESCALATED");
    this.name = "ObservationAlreadyEscalatedError";
  }
}
export class NotOrgManagerError extends Error {
  constructor() {
    super("REQUIRES_ORG_MANAGER");
    this.name = "NotOrgManagerError";
  }
}
export class InvalidStatusTransitionError extends Error {
  constructor() {
    super("INVALID_STATUS_TRANSITION");
    this.name = "InvalidStatusTransitionError";
  }
}
export class InvalidFileForAttachmentError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidFileForAttachmentError";
  }
}
export class AssigneeNotInOrgError extends Error {
  constructor() {
    super("ASSIGNEE_NOT_IN_ORGANIZATION");
    this.name = "AssigneeNotInOrgError";
  }
}

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

// severity is `text NOT NULL` in the real schema -- deliberately NOT an
// enum (unlike observation_category_enum). No app-level enum is invented
// here either; only a non-empty, length-bounded string is required.
export const createIncidentSchema = z.object({
  careRecipientId: z.string().uuid(),
  severity: z.string().trim().min(1).max(50),
  description: z.string().trim().min(1).max(4000),
  actionsTaken: z.string().trim().max(4000).optional(),
  escalatedFromObservationId: z.string().uuid().optional(),
});
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;

export const escalateObservationSchema = z.object({
  severity: z.string().trim().min(1).max(50),
  description: z.string().trim().min(1).max(4000),
  actionsTaken: z.string().trim().max(4000).optional(),
});
export type EscalateObservationInput = z.infer<typeof escalateObservationSchema>;

interface IncidentRow {
  id: string;
  organization_id: string;
  care_recipient_id: string;
  organization_worker_membership_id: string;
  escalated_from_observation_id: string | null;
  severity: string;
  description: string;
  actions_taken: string | null;
  assigned_to_user_id: string | null;
  resolution: string | null;
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

async function assertOrgManager(trx: unknown): Promise<void> {
  const check = await sql<{ exists: boolean }>`SELECT app_is_org_manager() as exists`.execute(trx as never);
  if (!check.rows[0]?.exists) throw new NotOrgManagerError();
}

export async function createIncident(
  userId: string,
  organizationId: string,
  input: CreateIncidentInput
): Promise<IncidentRow> {
  // Defense in depth: never trust that the route layer's Zod parse was the
  // only thing standing between empty required fields and the database --
  // re-check here too, matching every other check in this function.
  if (!input.severity || input.severity.trim().length === 0) {
    const err = new Error("SEVERITY_REQUIRED");
    err.name = "InvalidPayloadError";
    throw err;
  }
  if (!input.description || input.description.trim().length === 0) {
    const err = new Error("DESCRIPTION_REQUIRED");
    err.name = "InvalidPayloadError";
    throw err;
  }
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const workerId = await resolveWorkerForUser(trx, userId);
    const membership = await resolveMembership(trx, workerId, organizationId);
    if (!membership) throw new RecipientNotFoundError();
    if (membership.status !== "active") throw new MembershipNotActiveError("Membership not active");

    const recipientRow = await sql<{ id: string }>`
      SELECT id FROM care_recipients WHERE id = ${input.careRecipientId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!recipientRow.rows[0]) throw new RecipientNotFoundError();

    if (input.escalatedFromObservationId) {
      const obs = await sql<{ id: string; status: string; care_recipient_id: string }>`
        SELECT id, status, care_recipient_id FROM observations
        WHERE id = ${input.escalatedFromObservationId} AND organization_id = ${organizationId}
        LIMIT 1
      `.execute(trx);
      if (!obs.rows[0] || obs.rows[0].care_recipient_id !== input.careRecipientId) throw new ObservationNotFoundError();
      if (obs.rows[0].status === "escalated") throw new ObservationAlreadyEscalatedError();
    }

    const result = await sql<IncidentRow>`
      INSERT INTO incidents (
        organization_id, care_recipient_id, organization_worker_membership_id,
        escalated_from_observation_id, severity, description, actions_taken
      ) VALUES (
        ${organizationId}, ${input.careRecipientId}, ${membership.id},
        ${input.escalatedFromObservationId ?? null}, ${input.severity}, ${input.description}, ${input.actionsTaken ?? null}
      )
      RETURNING id, organization_id, care_recipient_id, organization_worker_membership_id,
                escalated_from_observation_id, severity, description, actions_taken,
                assigned_to_user_id, resolution, status, created_at
    `.execute(trx);

    if (input.escalatedFromObservationId) {
      await sql`UPDATE observations SET status = 'escalated' WHERE id = ${input.escalatedFromObservationId} AND organization_id = ${organizationId}`.execute(
        trx
      );
    }

    return result.rows[0];
  });
}

/**
 * A dedicated escalation action. DESIGN NOTE (corrected after real
 * testing): escalation is a supervisory judgment call, not a caregiving
 * act -- the manager reviewing and escalating an observation may have NO
 * worker profile at all (org admins commonly don't). This requires
 * org-manager authority instead of resolving the CALLER's own worker
 * identity. The resulting incident is attributed to the ORIGINAL
 * observation's organization_worker_membership_id (whoever actually
 * observed and documented it) -- preserving accurate provenance rather
 * than crediting the escalating manager as if they had witnessed it.
 */
export async function escalateObservationToIncident(
  userId: string,
  organizationId: string,
  observationId: string,
  input: EscalateObservationInput
): Promise<IncidentRow> {
  assertUuid(observationId, "observationId");
  if (!input.severity || input.severity.trim().length === 0) {
    const err = new Error("SEVERITY_REQUIRED");
    err.name = "InvalidPayloadError";
    throw err;
  }
  if (!input.description || input.description.trim().length === 0) {
    const err = new Error("DESCRIPTION_REQUIRED");
    err.name = "InvalidPayloadError";
    throw err;
  }
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertOrgManager(trx);

    const obs = await sql<{ id: string; status: string; care_recipient_id: string; organization_worker_membership_id: string }>`
      SELECT id, status, care_recipient_id, organization_worker_membership_id FROM observations
      WHERE id = ${observationId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!obs.rows[0]) throw new ObservationNotFoundError();
    if (obs.rows[0].status === "escalated") throw new ObservationAlreadyEscalatedError();

    const result = await sql<IncidentRow>`
      INSERT INTO incidents (
        organization_id, care_recipient_id, organization_worker_membership_id,
        escalated_from_observation_id, severity, description, actions_taken
      ) VALUES (
        ${organizationId}, ${obs.rows[0].care_recipient_id}, ${obs.rows[0].organization_worker_membership_id},
        ${observationId}, ${input.severity}, ${input.description}, ${input.actionsTaken ?? null}
      )
      RETURNING id, organization_id, care_recipient_id, organization_worker_membership_id,
                escalated_from_observation_id, severity, description, actions_taken,
                assigned_to_user_id, resolution, status, created_at
    `.execute(trx);

    await sql`UPDATE observations SET status = 'escalated' WHERE id = ${observationId} AND organization_id = ${organizationId}`.execute(
      trx
    );

    return result.rows[0];
  });
}

export interface ListIncidentsFilter {
  careRecipientId?: string;
  status?: string;
}

export async function listIncidents(userId: string, organizationId: string, filter: ListIncidentsFilter = {}) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const conditions = [sql`organization_id = ${organizationId}`];
    if (filter.careRecipientId) conditions.push(sql`care_recipient_id = ${filter.careRecipientId}`);
    if (filter.status) conditions.push(sql`status = ${filter.status}`);
    const result = await sql<IncidentRow>`
      SELECT id, organization_id, care_recipient_id, organization_worker_membership_id,
             escalated_from_observation_id, severity, description, actions_taken,
             assigned_to_user_id, resolution, status, created_at
      FROM incidents
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY created_at DESC
    `.execute(trx);
    return result.rows;
  });
}

export async function getIncident(userId: string, organizationId: string, incidentId: string) {
  assertUuid(incidentId, "incidentId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<IncidentRow>`
      SELECT id, organization_id, care_recipient_id, organization_worker_membership_id,
             escalated_from_observation_id, severity, description, actions_taken,
             assigned_to_user_id, resolution, status, created_at
      FROM incidents WHERE id = ${incidentId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!result.rows[0]) throw new IncidentNotFoundError();
    return result.rows[0];
  });
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  open: ["in_progress", "resolved"],
  in_progress: ["resolved"],
  resolved: [],
};

/**
 * Status transitions (workflow/supervision) require org-manager authority
 * -- the same principle as observations' review action. Incidents are
 * never deleted (schema comment: "part of the permanent historical
 * record"); this only ever moves status forward, never invents a delete
 * or archive path the schema doesn't have.
 */
export async function updateIncidentStatus(
  userId: string,
  organizationId: string,
  incidentId: string,
  newStatus: "in_progress" | "resolved",
  resolution?: string
): Promise<IncidentRow> {
  assertUuid(incidentId, "incidentId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertOrgManager(trx);
    const current = await sql<{ status: string }>`
      SELECT status FROM incidents WHERE id = ${incidentId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!current.rows[0]) throw new IncidentNotFoundError();
    if (!VALID_TRANSITIONS[current.rows[0].status]?.includes(newStatus)) {
      throw new InvalidStatusTransitionError();
    }
    if (newStatus === "resolved" && !resolution) {
      throw new InvalidStatusTransitionError();
    }

    const result = await sql<IncidentRow>`
      UPDATE incidents
      SET status = ${newStatus}, resolution = ${newStatus === "resolved" ? resolution : null}
      WHERE id = ${incidentId} AND organization_id = ${organizationId}
      RETURNING id, organization_id, care_recipient_id, organization_worker_membership_id,
                escalated_from_observation_id, severity, description, actions_taken,
                assigned_to_user_id, resolution, status, created_at
    `.execute(trx);
    return result.rows[0];
  });
}

export async function assignIncident(
  userId: string,
  organizationId: string,
  incidentId: string,
  assignedToUserId: string
): Promise<IncidentRow> {
  assertUuid(incidentId, "incidentId");
  assertUuid(assignedToUserId, "assignedToUserId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertOrgManager(trx);
    const incidentRow = await sql<{ id: string }>`
      SELECT id FROM incidents WHERE id = ${incidentId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!incidentRow.rows[0]) throw new IncidentNotFoundError();

    const assigneeRow = await sql<{ id: string }>`
      SELECT om.id FROM organization_memberships om
      WHERE om.user_id = ${assignedToUserId} AND om.organization_id = ${organizationId} AND om.status = 'active'
      LIMIT 1
    `.execute(trx);
    if (!assigneeRow.rows[0]) throw new AssigneeNotInOrgError();

    const result = await sql<IncidentRow>`
      UPDATE incidents SET assigned_to_user_id = ${assignedToUserId}
      WHERE id = ${incidentId} AND organization_id = ${organizationId}
      RETURNING id, organization_id, care_recipient_id, organization_worker_membership_id,
                escalated_from_observation_id, severity, description, actions_taken,
                assigned_to_user_id, resolution, status, created_at
    `.execute(trx);
    return result.rows[0];
  });
}

export const addTimelineEntrySchema = z.object({
  entryText: z.string().trim().min(1).max(4000),
});
export type AddTimelineEntryInput = z.infer<typeof addTimelineEntrySchema>;

interface TimelineEntryRow {
  id: string;
  organization_id: string;
  incident_id: string;
  entry_text: string;
  created_by_user_id: string | null;
  occurred_at: string;
}

export async function addTimelineEntry(
  userId: string,
  organizationId: string,
  incidentId: string,
  input: AddTimelineEntryInput
): Promise<TimelineEntryRow> {
  assertUuid(incidentId, "incidentId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const incidentRow = await sql<{ id: string }>`
      SELECT id FROM incidents WHERE id = ${incidentId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!incidentRow.rows[0]) throw new IncidentNotFoundError();

    const result = await sql<TimelineEntryRow>`
      INSERT INTO incident_timeline_entries (organization_id, incident_id, entry_text, created_by_user_id)
      VALUES (${organizationId}, ${incidentId}, ${input.entryText}, ${userId})
      RETURNING id, organization_id, incident_id, entry_text, created_by_user_id, occurred_at
    `.execute(trx);
    return result.rows[0];
  });
}

export async function listTimelineEntries(userId: string, organizationId: string, incidentId: string) {
  assertUuid(incidentId, "incidentId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const incidentRow = await sql<{ id: string }>`
      SELECT id FROM incidents WHERE id = ${incidentId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!incidentRow.rows[0]) throw new IncidentNotFoundError();

    const result = await sql<TimelineEntryRow>`
      SELECT id, organization_id, incident_id, entry_text, created_by_user_id, occurred_at
      FROM incident_timeline_entries WHERE incident_id = ${incidentId} AND organization_id = ${organizationId}
      ORDER BY occurred_at
    `.execute(trx);
    return result.rows;
  });
}

export const addAttachmentSchema = z.object({
  storedFileId: z.string().uuid(),
});
export type AddAttachmentInput = z.infer<typeof addAttachmentSchema>;

export async function addIncidentAttachment(
  userId: string,
  organizationId: string,
  incidentId: string,
  input: AddAttachmentInput
) {
  assertUuid(incidentId, "incidentId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const incidentRow = await sql<{ id: string }>`
      SELECT id FROM incidents WHERE id = ${incidentId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!incidentRow.rows[0]) throw new IncidentNotFoundError();

    const fileCheck = await sql<{ id: string; scope_type: string; organization_id: string | null }>`
      SELECT id, scope_type, organization_id FROM stored_files WHERE id = ${input.storedFileId} LIMIT 1
    `.execute(trx);
    const file = fileCheck.rows[0];
    if (!file) throw new InvalidFileForAttachmentError("FILE_NOT_FOUND");
    if (file.scope_type !== "ORGANIZATION_OPERATIONAL") {
      throw new InvalidFileForAttachmentError("FILE_MUST_BE_ORGANIZATION_OPERATIONAL");
    }
    if (file.organization_id !== organizationId) {
      throw new InvalidFileForAttachmentError("FILE_OWNER_MISMATCH");
    }

    const result = await sql<{ id: string; organization_id: string; incident_id: string; file_id: string; created_at: string }>`
      INSERT INTO incident_attachments (organization_id, incident_id, file_id)
      VALUES (${organizationId}, ${incidentId}, ${input.storedFileId})
      RETURNING id, organization_id, incident_id, file_id, created_at
    `.execute(trx);
    return result.rows[0];
  });
}

export async function listIncidentAttachments(userId: string, organizationId: string, incidentId: string) {
  assertUuid(incidentId, "incidentId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const incidentRow = await sql<{ id: string }>`
      SELECT id FROM incidents WHERE id = ${incidentId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!incidentRow.rows[0]) throw new IncidentNotFoundError();

    const result = await sql<{ id: string; organization_id: string; incident_id: string; file_id: string; created_at: string }>`
      SELECT id, organization_id, incident_id, file_id, created_at
      FROM incident_attachments WHERE incident_id = ${incidentId} AND organization_id = ${organizationId}
      ORDER BY created_at
    `.execute(trx);
    return result.rows;
  });
}
