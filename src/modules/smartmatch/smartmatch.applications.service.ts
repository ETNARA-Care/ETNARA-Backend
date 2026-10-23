import { sql } from "kysely";
import { withTenantContext } from "../../context/tenantContext.js";
import {
  evaluateWorkerEligibilityInTransaction,
  NoApplicableRequirementSetError,
  MembershipNotFoundError,
} from "../eligibility/eligibility.service.js";
import { SmartMatchForbiddenError } from "./smartmatch.service.js";

type Trx = Parameters<Parameters<typeof withTenantContext>[1]>[0];

/** Opportunity is not visible, not published, not internal, or already started. */
export class SmartMatchNotAvailableError extends Error {
  constructor() { super("SMARTMATCH_NOT_AVAILABLE"); }
}
/** An open (non-withdrawn) application already exists for this caregiver. */
export class SmartMatchDuplicateApplicationError extends Error {
  constructor() { super("SMARTMATCH_DUPLICATE_APPLICATION"); }
}
/** Application not found in the caller's agency (never reveals other tenants). */
export class SmartMatchApplicationNotFoundError extends Error {
  constructor() { super("SMARTMATCH_APPLICATION_NOT_FOUND"); }
}
/** The application or opportunity is no longer in a state that allows this action. */
export class SmartMatchConflictError extends Error {
  constructor(public readonly reason: string) { super("SMARTMATCH_CONFLICT"); }
}

const pgCode = (e: unknown) =>
  e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string"
    ? (e as { code: string }).code : "";
const pgMessage = (e: unknown) => (e instanceof Error ? e.message : "");

/** Server-side approval checks. Booleans and requirement codes only: no clinical or patient data. */
export interface SmartMatchApprovalChecks {
  membershipActive: boolean;
  credentialsEligible: boolean;
  credentialsVerifiable: boolean;
  unmetRequirementCodes: string[];
  availabilityConfigured: boolean;
  availabilityCovers: boolean;
  noUnavailabilityConflict: boolean;
  consentRecorded: boolean;
  opportunityOpen: boolean;
  applicationPending: boolean;
  approvable: boolean;
}

async function requireActiveWorker(trx: Trx): Promise<void> {
  const r = await sql<{ allowed: boolean }>`SELECT app_smartmatch_is_active_worker() AS allowed`.execute(trx);
  if (!r.rows[0]?.allowed) throw new SmartMatchForbiddenError();
}

export async function requireOrgAdmin(trx: Trx): Promise<void> {
  const r = await sql<{ allowed: boolean }>`SELECT app_is_org_admin() AS allowed`.execute(trx);
  if (!r.rows[0]?.allowed) throw new SmartMatchForbiddenError();
}

// ---------------------------------------------------------------- caregiver

/**
 * Submit (or re-submit after withdrawal) an application with explicit consent.
 * RLS enforces: own user, own agency, published internal future opportunity,
 * active worker. A partial unique index admits one open application per
 * caregiver and opportunity, so concurrent submissions cannot both succeed.
 * A deferred trigger re-checks at COMMIT that the opportunity is still open.
 */
export async function submitSmartMatchApplication(
  userId: string, organizationId: string, opportunityId: string, consentVersion: string,
) {
  try {
    return await withTenantContext({ userId, organizationId }, async (trx) => {
      await requireActiveWorker(trx);
      const inserted = await sql<{ id: string; status: string; created_at: string; consented_at: string }>`
        INSERT INTO smartmatch_applications (
          opportunity_id, organization_id, caregiver_user_id, consented_at, consent_version
        ) VALUES (
          ${opportunityId}, ${organizationId}, ${userId}, now(), ${consentVersion}
        )
        RETURNING id, status, created_at, consented_at
      `.execute(trx);
      return inserted.rows[0];
    });
  } catch (e) {
    const code = pgCode(e);
    if (code === "23505") throw new SmartMatchDuplicateApplicationError();
    // 42501: RLS rejected the row (not visible/published/own agency).
    // 23503: the opportunity does not exist in this agency.
    // 23514 from the deferred trigger: filled/closed before commit.
    if (code === "42501" || code === "23503" || (code === "23514" && pgMessage(e).includes("NOT_OPEN"))) {
      throw new SmartMatchNotAvailableError();
    }
    throw e;
  }
}

/** Withdraw one's own PENDING application. Row lock serializes with an agency decision. */
export async function withdrawSmartMatchApplication(
  userId: string, organizationId: string, applicationId: string,
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireActiveWorker(trx);
    const current = await sql<{ status: string }>`
      SELECT status FROM smartmatch_applications
      WHERE id = ${applicationId} AND organization_id = ${organizationId}
        AND caregiver_user_id = ${userId}
    `.execute(trx);
    if (!current.rows[0]) throw new SmartMatchApplicationNotFoundError();
    const updated = await sql<{ id: string; status: string; withdrawn_at: string }>`
      UPDATE smartmatch_applications
      SET status = 'WITHDRAWN', withdrawn_at = now()
      WHERE id = ${applicationId} AND organization_id = ${organizationId}
        AND caregiver_user_id = ${userId} AND status = 'PENDING'
      RETURNING id, status, withdrawn_at
    `.execute(trx);
    if (!updated.rows[0]) throw new SmartMatchConflictError("APPLICATION_NOT_PENDING");
    return updated.rows[0];
  });
}

/** "Mis solicitudes": own applications (including withdrawn history) with sanitized opportunity labels. */
export async function listMySmartMatchApplications(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireActiveWorker(trx);
    const rows = await sql<{
      id: string; status: string; created_at: string; withdrawn_at: string | null;
      decided_at: string | null; decision_reason: string | null;
      opportunity_id: string; region_label: string; role_label: string;
      starts_at: string; ends_at: string; opportunity_status: string; opportunity_cancellation_reason: string | null;
    }>`
      SELECT a.id, a.status, a.created_at, a.withdrawn_at, a.decided_at, a.decision_reason,
             o.id AS opportunity_id, o.region_label, o.role_label, o.starts_at, o.ends_at,
             o.status AS opportunity_status,
             -- Gate 6: reason category only (the internal note is never returned to caregivers).
             CASE WHEN a.status = 'APPROVED' THEN o.cancellation_reason END AS opportunity_cancellation_reason
      FROM smartmatch_applications a
      JOIN smartmatch_opportunities o ON o.id = a.opportunity_id
      WHERE a.caregiver_user_id = ${userId} AND a.organization_id = ${organizationId}
      ORDER BY a.created_at DESC, a.id
      LIMIT 200
    `.execute(trx);
    return rows.rows;
  });
}

// ------------------------------------------------------------------- agency

export interface LockedApplication {
  id: string; status: string; caregiver_user_id: string; opportunity_id: string;
  consented_at: string | null;
}
export interface LockedOpportunity {
  id: string; status: string; visibility: string; starts_at: string; ends_at: string; open: boolean;
}

/**
 * Computes approval checks for one application, inside the caller's
 * transaction. Missing or unverifiable data yields false: never assumed.
 */
export async function computeApprovalChecks(
  trx: Trx, organizationId: string, app: LockedApplication, opp: LockedOpportunity,
): Promise<{ checks: SmartMatchApprovalChecks; caregiver: { membershipId: string | null; displayName: string | null } }> {
  const worker = await sql<{ membership_id: string; worker_status: string; display_name: string | null; has_worker_role: boolean }>`
    SELECT owm.id AS membership_id, owm.status AS worker_status, w.display_name,
      EXISTS (
        SELECT 1 FROM organization_memberships om
        JOIN user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
        JOIN roles r ON r.id = ur.role_id
        WHERE om.user_id = ${app.caregiver_user_id} AND om.organization_id = ${organizationId}
          AND om.status = 'active' AND r.code = 'WORKER'
      ) AS has_worker_role
    FROM workers w
    JOIN organization_worker_memberships owm ON owm.worker_id = w.id
    WHERE w.user_id = ${app.caregiver_user_id} AND owm.organization_id = ${organizationId}
    ORDER BY (owm.status = 'active') DESC, owm.created_at DESC
    LIMIT 1
  `.execute(trx);
  const w = worker.rows[0];
  const membershipActive = Boolean(w && w.worker_status === "active" && w.has_worker_role);

  let credentialsEligible = false;
  let credentialsVerifiable = false;
  let unmetRequirementCodes: string[] = [];
  if (w && membershipActive) {
    try {
      const result = await evaluateWorkerEligibilityInTransaction(trx, organizationId, w.membership_id);
      credentialsVerifiable = true;
      credentialsEligible = result.eligibilityStatus === "eligible";
      unmetRequirementCodes = result.requirements
        .filter(r => r.isMandatory && !r.satisfied).map(r => r.credentialTypeCode);
    } catch (e) {
      // No requirement policy or membership not visible: unverifiable -> blocked.
      if (!(e instanceof NoApplicableRequirementSetError) && !(e instanceof MembershipNotFoundError)) throw e;
    }
  }

  let availabilityConfigured = false;
  let availabilityCovers = false;
  let noUnavailabilityConflict = false;
  if (w) {
    const availability = await sql<{ configured: boolean; covers: boolean; conflict: boolean }>`
      WITH s AS (
        SELECT timezone FROM worker_availability_settings
        WHERE organization_worker_membership_id = ${w.membership_id}
      ), local AS (
        SELECT s.timezone, (${opp.starts_at}::timestamptz AT TIME ZONE s.timezone)::date AS day FROM s
      )
      SELECT
        EXISTS (SELECT 1 FROM s) AS configured,
        EXISTS (
          SELECT 1 FROM local
          JOIN worker_weekly_availability wa
            ON wa.organization_worker_membership_id = ${w.membership_id}
           AND wa.weekday = extract(dow FROM local.day)::int
          WHERE ((local.day + wa.start_time) AT TIME ZONE local.timezone) <= ${opp.starts_at}::timestamptz
            AND ((local.day + wa.end_time) AT TIME ZONE local.timezone) >= ${opp.ends_at}::timestamptz
        ) AS covers,
        EXISTS (
          SELECT 1 FROM worker_unavailability_periods u
          WHERE u.organization_worker_membership_id = ${w.membership_id}
            AND u.starts_at < ${opp.ends_at}::timestamptz
            AND u.ends_at > ${opp.starts_at}::timestamptz
        ) AS conflict
    `.execute(trx);
    const a = availability.rows[0];
    availabilityConfigured = Boolean(a?.configured);
    availabilityCovers = availabilityConfigured && Boolean(a?.covers);
    noUnavailabilityConflict = availabilityConfigured && !a?.conflict;
  }

  const consentRecorded = app.consented_at !== null;
  const applicationPending = app.status === "PENDING";
  const checks: SmartMatchApprovalChecks = {
    membershipActive,
    credentialsEligible,
    credentialsVerifiable,
    unmetRequirementCodes,
    availabilityConfigured,
    availabilityCovers: availabilityCovers && noUnavailabilityConflict,
    noUnavailabilityConflict,
    consentRecorded,
    opportunityOpen: opp.open,
    applicationPending,
    approvable: false,
  };
  checks.approvable = membershipActive && credentialsVerifiable && credentialsEligible &&
    checks.availabilityCovers && consentRecorded && opp.open && applicationPending;
  return { checks, caregiver: { membershipId: w?.membership_id ?? null, displayName: w?.display_name ?? null } };
}

async function findApplicationOpportunity(trx: Trx, organizationId: string, applicationId: string): Promise<string> {
  const r = await sql<{ opportunity_id: string }>`
    SELECT opportunity_id FROM smartmatch_applications
    WHERE id = ${applicationId} AND organization_id = ${organizationId}
  `.execute(trx);
  if (!r.rows[0]) throw new SmartMatchApplicationNotFoundError();
  return r.rows[0].opportunity_id;
}

const opportunityColumns = sql`id, status, visibility, starts_at, ends_at,
  (status = 'PUBLISHED' AND visibility = 'INTERNAL' AND starts_at > now()) AS open`;

/** Admin review: candidate summary and live eligibility checks. Read-only, no locks. */
export async function getSmartMatchApplicationReview(
  userId: string, organizationId: string, applicationId: string,
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const opportunityId = await findApplicationOpportunity(trx, organizationId, applicationId);
    const opp = (await sql<LockedOpportunity>`
      SELECT ${opportunityColumns} FROM smartmatch_opportunities
      WHERE id = ${opportunityId} AND organization_id = ${organizationId}
    `.execute(trx)).rows[0];
    const app = (await sql<LockedApplication & { created_at: string; decided_by_user_id: string | null; decided_at: string | null; decision_reason: string | null }>`
      SELECT id, status, caregiver_user_id, opportunity_id, consented_at, created_at,
             decided_by_user_id, decided_at, decision_reason
      FROM smartmatch_applications WHERE id = ${applicationId} AND organization_id = ${organizationId}
    `.execute(trx)).rows[0];
    if (!opp || !app) throw new SmartMatchApplicationNotFoundError();
    const { checks, caregiver } = await computeApprovalChecks(trx, organizationId, app, opp);
    return {
      application: {
        id: app.id, status: app.status, createdAt: app.created_at, consentedAt: app.consented_at,
        decidedByUserId: app.decided_by_user_id, decidedAt: app.decided_at, decisionReason: app.decision_reason,
      },
      caregiver: { membershipId: caregiver.membershipId, displayName: caregiver.displayName },
      opportunity: { id: opp.id, status: opp.status, startsAt: opp.starts_at, endsAt: opp.ends_at },
      checks,
    };
  });
}

/** Admin queue: all applications of one opportunity in the caller's agency, with caregiver display names. */
export async function listSmartMatchOpportunityApplications(
  userId: string, organizationId: string, opportunityId: string,
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const rows = await sql<{
      id: string; status: string; created_at: string; decided_at: string | null;
      decision_reason: string | null; display_name: string | null;
    }>`
      SELECT a.id, a.status, a.created_at, a.decided_at, a.decision_reason, w.display_name
      FROM smartmatch_applications a
      LEFT JOIN workers w ON w.user_id = a.caregiver_user_id
      WHERE a.opportunity_id = ${opportunityId} AND a.organization_id = ${organizationId}
      ORDER BY a.created_at ASC, a.id ASC
      LIMIT 200
    `.execute(trx);
    return rows.rows;
  });
}

export type SmartMatchDecision = "APPROVE" | "REJECT";

/**
 * Agency decision in ONE transaction:
 *   1. lock the opportunity row (FOR UPDATE) -- serializes every decision and
 *      every new submission (FK key-share lock) on this opportunity;
 *   2. lock the application row (FOR UPDATE, visible only while PENDING);
 *   3. for APPROVE, recompute membership, credentials, availability, consent;
 *      any missing or unverifiable item blocks the approval;
 *   4. write the decision (signed by the session user via RLS), mark the
 *      opportunity FILLED and close the remaining pending applications.
 * No assignment is created.
 */
export async function decideSmartMatchApplication(
  userId: string, organizationId: string, applicationId: string, decision: SmartMatchDecision,
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    const opportunityId = await findApplicationOpportunity(trx, organizationId, applicationId);

    const opp = (await sql<LockedOpportunity>`
      SELECT ${opportunityColumns} FROM smartmatch_opportunities
      WHERE id = ${opportunityId} AND organization_id = ${organizationId}
      FOR UPDATE
    `.execute(trx)).rows[0];
    if (!opp) throw new SmartMatchApplicationNotFoundError();

    const locked = (await sql<LockedApplication>`
      SELECT id, status, caregiver_user_id, opportunity_id, consented_at
      FROM smartmatch_applications
      WHERE id = ${applicationId} AND organization_id = ${organizationId}
      FOR UPDATE
    `.execute(trx)).rows[0];
    // Not lockable = not PENDING any more, or the admin's own application.
    if (!locked) {
      const own = await sql<{ own: boolean }>`
        SELECT caregiver_user_id = ${userId} AS own FROM smartmatch_applications
        WHERE id = ${applicationId} AND organization_id = ${organizationId}
      `.execute(trx);
      if (own.rows[0]?.own) throw new SmartMatchForbiddenError();
      throw new SmartMatchConflictError("APPLICATION_NOT_PENDING");
    }
    if (locked.status !== "PENDING") throw new SmartMatchConflictError("APPLICATION_NOT_PENDING");

    if (decision === "REJECT") {
      const rejected = await sql<{ id: string; status: string; decided_by_user_id: string; decided_at: string }>`
        UPDATE smartmatch_applications
        SET status = 'REJECTED', decided_by_user_id = ${userId}, decided_at = now(),
            decision_reason = 'AGENCY_REJECTED'
        WHERE id = ${applicationId} AND organization_id = ${organizationId} AND status = 'PENDING'
        RETURNING id, status, decided_by_user_id, decided_at
      `.execute(trx);
      if (!rejected.rows[0]) throw new SmartMatchConflictError("APPLICATION_NOT_PENDING");
      return { outcome: "REJECTED" as const, application: rejected.rows[0] };
    }

    if (!opp.open) throw new SmartMatchConflictError("OPPORTUNITY_NOT_OPEN");
    const { checks } = await computeApprovalChecks(trx, organizationId, locked, opp);
    if (!checks.approvable) {
      return { outcome: "BLOCKED" as const, checks };
    }

    const approved = await sql<{ id: string; status: string; decided_by_user_id: string; decided_at: string }>`
      UPDATE smartmatch_applications
      SET status = 'APPROVED', decided_by_user_id = ${userId}, decided_at = now(),
          decision_reason = 'APPROVED_ELIGIBLE', decision_checks = ${JSON.stringify(checks)}::jsonb
      WHERE id = ${applicationId} AND organization_id = ${organizationId} AND status = 'PENDING'
      RETURNING id, status, decided_by_user_id, decided_at
    `.execute(trx);
    if (!approved.rows[0]) throw new SmartMatchConflictError("APPLICATION_NOT_PENDING");

    await sql`
      UPDATE smartmatch_opportunities SET status = 'FILLED', updated_at = now()
      WHERE id = ${opportunityId} AND organization_id = ${organizationId} AND status = 'PUBLISHED'
    `.execute(trx);

    const closed = await sql<{ id: string }>`
      UPDATE smartmatch_applications
      SET status = 'REJECTED', decided_by_user_id = ${userId}, decided_at = now(),
          decision_reason = 'OPPORTUNITY_FILLED'
      WHERE opportunity_id = ${opportunityId} AND organization_id = ${organizationId}
        AND status = 'PENDING' AND id <> ${applicationId}
        AND caregiver_user_id <> ${userId}
      RETURNING id
    `.execute(trx);

    return { outcome: "APPROVED" as const, application: approved.rows[0], checks, closedApplications: closed.rows.length };
  });
}

/** Admin: append-only decision history of one application. */
export async function listSmartMatchApplicationEvents(
  userId: string, organizationId: string, applicationId: string,
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireOrgAdmin(trx);
    await findApplicationOpportunity(trx, organizationId, applicationId);
    const rows = await sql<{
      event_type: string; previous_status: string | null; new_status: string;
      actor_user_id: string | null; decision_reason: string | null; occurred_at: string;
      consent_version: string | null;
    }>`
      SELECT event_type, previous_status, new_status, actor_user_id, decision_reason, occurred_at,
             CASE WHEN event_type = 'SUBMITTED' THEN consent_version END AS consent_version
      FROM smartmatch_application_events
      WHERE application_id = ${applicationId} AND organization_id = ${organizationId}
      ORDER BY occurred_at, id
    `.execute(trx);
    return rows.rows;
  });
}
