import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { insertShiftInTransaction, RecipientNotInOrgError } from "../scheduling/scheduling.service.js";
import { assignWorkerToShiftInTransaction } from "../assignments/assignments.service.js";
import {
  computeApprovalChecks, requireOrgAdmin, SmartMatchApplicationNotFoundError, SmartMatchConflictError,
  type LockedApplication, type LockedOpportunity,
} from "./smartmatch.applications.service.js";

type Trx = Parameters<Parameters<typeof withTenantContext>[1]>[0];

/**
 * "Crear turno con esta cuidadora": turns a FILLED SmartMatch opportunity into
 * ONE real shift of the existing Turnos module (shifts + assignments). The
 * schedule and role are the opportunity's (what the caregiver consented to);
 * the administrator only chooses the person receiving care from the agency's
 * own records and may add private operational instructions.
 */
export const smartMatchCreateShiftSchema = z.object({
  careRecipientId: z.string().uuid(),
  /** Gate 6: the administrator confirms which of the person's addresses applies. */
  serviceLocationId: z.string().uuid().optional(),
  instructions: z.string().trim().max(2000).optional(),
}).strict();
export type SmartMatchCreateShiftInput = z.infer<typeof smartMatchCreateShiftSchema>;

export const shiftPrivateInstructionsSchema = z.object({
  instructions: z.string().trim().min(1).max(2000),
}).strict();

interface LinkedOpportunity {
  id: string; status: string; visibility: string; starts_at: Date | string; ends_at: Date | string;
  role_label: string; region_label: string; shift_id: string | null; started: boolean;
}

const iso = (v: Date | string) => new Date(v).toISOString();

async function loadOpportunity(trx: Trx, organizationId: string, opportunityId: string, lock: boolean) {
  const r = await sql<LinkedOpportunity>`
    SELECT id, status, visibility, starts_at, ends_at, role_label, region_label, shift_id,
           starts_at <= now() AS started
    FROM smartmatch_opportunities
    WHERE id = ${opportunityId} AND organization_id = ${organizationId}
    ${lock ? sql`FOR UPDATE` : sql``}
  `.execute(trx);
  const opp = r.rows[0];
  if (!opp) throw new SmartMatchApplicationNotFoundError();
  return opp;
}

async function loadApprovedApplication(trx: Trx, organizationId: string, opportunityId: string) {
  const r = await sql<LockedApplication>`
    SELECT id, status, caregiver_user_id, opportunity_id, consented_at
    FROM smartmatch_applications
    WHERE opportunity_id = ${opportunityId} AND organization_id = ${organizationId} AND status = 'APPROVED'
    LIMIT 1
  `.execute(trx);
  return r.rows[0] ?? null;
}

/** Live checks for the shift: same rules as the approval, minus "still open/pending". */
async function readiness(trx: Trx, organizationId: string, app: LockedApplication, opp: LinkedOpportunity) {
  const locked: LockedOpportunity = {
    id: opp.id, status: opp.status, visibility: opp.visibility,
    starts_at: iso(opp.starts_at), ends_at: iso(opp.ends_at), open: false,
  };
  const { checks, caregiver } = await computeApprovalChecks(trx, organizationId, app, locked);
  const ready = checks.membershipActive && checks.credentialsVerifiable && checks.credentialsEligible
    && checks.availabilityCovers;
  return {
    caregiver,
    checks: {
      membershipActive: checks.membershipActive,
      credentialsEligible: checks.credentialsEligible,
      credentialsVerifiable: checks.credentialsVerifiable,
      unmetRequirementCodes: checks.unmetRequirementCodes,
      availabilityCovers: checks.availabilityCovers,
      ready,
    },
  };
}

/** Admin: what the "Crear turno" form needs. No patient data. */
export async function getSmartMatchShiftDraft(userId: string, organizationId: string, opportunityId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const opp = await loadOpportunity(trx, organizationId, opportunityId, false);
    const app = opp.status === "FILLED" ? await loadApprovedApplication(trx, organizationId, opportunityId) : null;
    const live = app ? await readiness(trx, organizationId, app, opp) : null;
    return {
      opportunity: {
        id: opp.id, status: opp.status, role_label: opp.role_label, region_label: opp.region_label,
        starts_at: iso(opp.starts_at), ends_at: iso(opp.ends_at), shift_id: opp.shift_id, started: opp.started,
      },
      caregiver: live?.caregiver ?? null,
      checks: live?.checks ?? null,
      canCreate: Boolean(opp.status === "FILLED" && !opp.shift_id && !opp.started && live?.checks.ready),
    };
  });
}

/**
 * One transaction: lock the opportunity, re-validate everything on the
 * server, create the shift and the assignment with the Turnos rules (agency
 * recipient, eligibility, duplicates, overlapping shifts, caregiver
 * notification), store private instructions, link the shift. Any failure
 * rolls back all of it, so a shift never exists without its link and a
 * second request (double tap, second administrator) gets 409.
 */
export async function createShiftFromSmartMatch(
  userId: string, organizationId: string, opportunityId: string, input: SmartMatchCreateShiftInput,
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const opp = await loadOpportunity(trx, organizationId, opportunityId, true);
    if (opp.shift_id) throw new SmartMatchConflictError("SHIFT_ALREADY_CREATED");
    if (opp.status !== "FILLED") throw new SmartMatchConflictError("OPPORTUNITY_NOT_FILLED");
    if (opp.started) throw new SmartMatchConflictError("OPPORTUNITY_STARTED");

    const app = await loadApprovedApplication(trx, organizationId, opportunityId);
    if (!app) throw new SmartMatchConflictError("OPPORTUNITY_NOT_FILLED");
    const live = await readiness(trx, organizationId, app, opp);
    if (!live.checks.ready || !live.caregiver.membershipId) throw new SmartMatchConflictError("CAREGIVER_NOT_READY");

    // The person receiving care must be an ACTIVE record of this agency.
    const recipient = await sql<{ id: string }>`
      SELECT id FROM care_recipients
      WHERE id = ${input.careRecipientId} AND organization_id = ${organizationId} AND status = 'active'
      LIMIT 1
    `.execute(trx);
    if (!recipient.rows[0]) throw new RecipientNotInOrgError();
    // Gate 6: when the person has registered addresses, one must be confirmed explicitly.
    if (!input.serviceLocationId) {
      const any = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM care_recipient_locations
        WHERE care_recipient_id = ${input.careRecipientId} AND organization_id = ${organizationId} AND archived_at IS NULL`.execute(trx);
      if (any.rows[0].n > 0) throw new SmartMatchConflictError("SERVICE_LOCATION_REQUIRED");
    }

    const shift = await insertShiftInTransaction(trx, organizationId, {
      careRecipientId: input.careRecipientId,
      scheduledStart: iso(opp.starts_at),
      scheduledEnd: iso(opp.ends_at),
      requiredRole: opp.role_label,
      ...(input.serviceLocationId ? { serviceLocationId: input.serviceLocationId } : {}),
    });
    // This opportunity's own approval is the commitment being turned into the shift.
    const saved = await assignWorkerToShiftInTransaction(trx, organizationId, shift.id, {
      organizationWorkerMembershipId: live.caregiver.membershipId,
    }, { exceptSmartMatchOpportunityId: opportunityId });

    const instructions = input.instructions?.trim();
    if (instructions) {
      await sql`
        INSERT INTO shift_private_instructions (shift_id, organization_id, instructions, created_by_user_id)
        VALUES (${shift.id}, ${organizationId}, ${instructions}, ${userId})
      `.execute(trx);
    }

    const linked = await sql<{ id: string }>`
      UPDATE smartmatch_opportunities SET shift_id = ${shift.id}, updated_at = now()
      WHERE id = ${opportunityId} AND organization_id = ${organizationId} AND shift_id IS NULL
      RETURNING id
    `.execute(trx);
    if (!linked.rows[0]) throw new SmartMatchConflictError("SHIFT_ALREADY_CREATED");

    return {
      shift: { id: shift.id, status: "confirmed", scheduled_start: shift.scheduled_start, scheduled_end: shift.scheduled_end },
      assignment: { id: saved.assignment.id, response_status: saved.assignment.response_status },
      hasInstructions: Boolean(instructions),
    };
  });
}

/** Managers of the agency and the assigned worker only (RLS, migration 099). */
export async function getShiftPrivateInstructions(userId: string, organizationId: string, shiftId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const r = await sql<{ instructions: string; updated_at: string }>`
      SELECT instructions, updated_at FROM shift_private_instructions
      WHERE shift_id = ${shiftId} AND organization_id = ${organizationId}
    `.execute(trx);
    return r.rows[0] ?? null;
  });
}

/** Managers of the agency: create or replace the instructions of one shift. */
export async function saveShiftPrivateInstructions(
  userId: string, organizationId: string, shiftId: string, instructions: string,
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const manager = await sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`.execute(trx);
    if (!manager.rows[0]?.ok) throw new SmartMatchApplicationNotFoundError();
    const shift = await sql<{ id: string }>`
      SELECT id FROM shifts WHERE id = ${shiftId} AND organization_id = ${organizationId}
    `.execute(trx);
    if (!shift.rows[0]) throw new SmartMatchApplicationNotFoundError();
    const r = await sql<{ instructions: string; updated_at: string }>`
      INSERT INTO shift_private_instructions (shift_id, organization_id, instructions, created_by_user_id)
      VALUES (${shiftId}, ${organizationId}, ${instructions}, ${userId})
      ON CONFLICT (shift_id) DO UPDATE SET instructions = EXCLUDED.instructions, updated_at = now()
      RETURNING instructions, updated_at
    `.execute(trx);
    return r.rows[0];
  });
}

// ------------------------------------------------------------------ Gate 6: cancel a FILLED opportunity
export const SMARTMATCH_CANCELLATION_REASONS = ["NO_LONGER_NEEDED", "SCHEDULE_CHANGED", "COVERED_OTHERWISE", "OTHER"] as const;
export const smartMatchCancelSchema = z.object({
  reason: z.enum(SMARTMATCH_CANCELLATION_REASONS),
  /** Internal only: never sent to the caregiver. */
  note: z.string().trim().max(300).optional(),
}).strict();

/**
 * Rules (migration 102, enforced again by the database trigger):
 *  - only FILLED opportunities, reason required, written once;
 *  - a linked shift that is not cancelled blocks it: the agency decides about the
 *    real shift in Turnos first (SmartMatch never cancels or reassigns shifts);
 *  - the approved caregiver is notified by trigger (reason category only).
 */
/**
 * Cancel an opportunity (agency administrator, reason category required).
 *   PUBLISHED: always; every PENDING application is closed (CLOSED /
 *     OPPORTUNITY_CANCELLED) and each applicant notified once (migration 109).
 *   FILLED: only when the linked shift no longer has an active caregiver (107).
 * The opportunity row is locked first, so a concurrent submission or decision
 * is serialized with the cancellation.
 */
export async function cancelSmartMatchOpportunity(
  userId: string, organizationId: string, opportunityId: string, input: z.infer<typeof smartMatchCancelSchema>,
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const opp = await loadOpportunity(trx, organizationId, opportunityId, true);
    if (opp.status !== "FILLED" && opp.status !== "PUBLISHED") throw new SmartMatchConflictError("OPPORTUNITY_NOT_CANCELLABLE");
    if (opp.status === "FILLED" && opp.shift_id) {
      const shift = (await sql<{ status: string }>`
        SELECT status::text AS status FROM shifts WHERE id = ${opp.shift_id} AND organization_id = ${organizationId}`.execute(trx)).rows[0];
      // Active = not cancelled AND (started/finished or still has a caregiver). A shift
      // that lost its caregiver (declined / removed) no longer pins the opportunity
      // (security audit M5); the shift itself stays in Turnos for the agency.
      const active = shift && shift.status !== "cancelled" && (["in_progress", "completed"].includes(shift.status) ||
        Boolean((await sql<{ n: number }>`SELECT count(*)::int AS n FROM assignments WHERE shift_id = ${opp.shift_id}
          AND organization_id = ${organizationId} AND response_status IN ('pending', 'accepted')`.execute(trx)).rows[0]?.n));
      if (active) throw new SmartMatchConflictError("LINKED_SHIFT_ACTIVE");
    }
    const r = await sql<{ id: string; status: string; cancelled_at: string }>`
      UPDATE smartmatch_opportunities SET status = 'CANCELLED', cancellation_reason = ${input.reason},
        cancellation_note = ${input.note?.trim() || null}, cancelled_at = now(), cancelled_by_user_id = ${userId}, updated_at = now()
      WHERE id = ${opportunityId} AND organization_id = ${organizationId} AND status = ${opp.status}
      RETURNING id, status, cancelled_at`.execute(trx);
    if (!r.rows[0]) throw new SmartMatchConflictError("OPPORTUNITY_NOT_CANCELLABLE");
    const closed = await sql<{ n: number }>`
      SELECT closed_applications AS n FROM smartmatch_opportunity_events
      WHERE opportunity_id = ${opportunityId} AND organization_id = ${organizationId} AND event_type = 'CANCELLED'
      ORDER BY occurred_at DESC LIMIT 1`.execute(trx);
    return { opportunity: r.rows[0], previousStatus: opp.status, closedApplications: closed.rows[0]?.n ?? 0 };
  });
}

/** Agency administrators: append-only status history of one opportunity (migration 109). */
export async function listSmartMatchOpportunityHistory(userId: string, organizationId: string, opportunityId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    await loadOpportunity(trx, organizationId, opportunityId, false);
    const rows = await sql<{
      event_type: string; previous_status: string | null; new_status: string; actor_name: string | null;
      automatic: boolean; reason: string | null; closed_applications: number; occurred_at: string;
    }>`
      SELECT e.event_type, e.previous_status, e.new_status,
             COALESCE(w.display_name, u.email) AS actor_name, e.actor_user_id IS NULL AS automatic,
             e.reason, e.closed_applications, e.occurred_at
      FROM smartmatch_opportunity_events e
      LEFT JOIN users u ON u.id = e.actor_user_id
      LEFT JOIN workers w ON w.user_id = e.actor_user_id
      WHERE e.opportunity_id = ${opportunityId} AND e.organization_id = ${organizationId}
      ORDER BY e.occurred_at, e.id`.execute(trx);
    return rows.rows.map((r) => ({
      eventType: r.event_type, previousStatus: r.previous_status, newStatus: r.new_status,
      actorName: r.automatic ? null : r.actor_name, automatic: r.automatic, reason: r.reason,
      closedApplications: r.closed_applications, occurredAt: r.occurred_at,
    }));
  });
}
