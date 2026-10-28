import { sql, type RawBuilder } from "kysely";
import { OrganizationAccessDeniedError } from "../modules/organizationContext/organizationContext.service.js";

/**
 * Explicit role and relationship checks for tenant requests (auditoría 26-oct-2026).
 *
 * Every function here runs inside a withTenantContext() transaction, so
 * app.current_user_id / app.current_org_id are already set and the caller's
 * active membership in that organization is already verified. These checks
 * add WHO inside the organization may read or change something.
 *
 * They mirror the RLS policies on purpose: RLS stays as the second layer, but
 * the application must never depend on it alone. In production the app may
 * connect with a role that bypasses RLS, and these checks are then the only
 * protection. scripts/verifyRoleAuthorizationMatrix.ts proves both modes.
 *
 * Only existing database helpers are used (no migration needed):
 *   app_is_org_manager()                       ORGANIZATION_ADMIN or SUPERVISOR
 *   app_is_org_admin()                         ORGANIZATION_ADMIN
 *   app_worker_has_recipient_assignment(id)    caregiver with a current assignment to that person
 *   app_worker_has_shift_assignment(id)        caregiver with a current assignment to that shift
 */

type Trx = unknown;
const run = <T extends object>(q: RawBuilder<T>, trx: Trx) => q.execute(trx as never);

/** Active FAMILY role plus an active relationship to the person, in the current organization. */
export function familyOfRecipientSql(recipientId: RawBuilder<unknown> | string): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM family_relationships fr
    WHERE fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND fr.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND fr.care_recipient_id = ${recipientId}
      AND fr.status = 'active'
      AND EXISTS (
        SELECT 1 FROM organization_memberships om
        JOIN user_roles ur ON ur.organization_membership_id = om.id
        JOIN roles r ON r.id = ur.role_id
        WHERE om.user_id = fr.user_id AND om.organization_id = fr.organization_id
          AND om.status = 'active' AND r.code = 'FAMILY'))`;
}

/**
 * Who may see a person in care: managers, caregivers currently assigned to
 * them, and their active family members. Same rule as the care_recipients RLS
 * policies (018, 075, 014/038).
 */
export function recipientVisibleSql(recipientId: RawBuilder<unknown> | string): RawBuilder<boolean> {
  return sql<boolean>`(app_is_org_manager()
    OR app_worker_has_recipient_assignment(${recipientId})
    OR ${familyOfRecipientSql(recipientId)})`;
}

/** Staff side only (no family): managers and caregivers currently assigned to the person. */
export function recipientStaffSql(recipientId: RawBuilder<unknown> | string): RawBuilder<boolean> {
  return sql<boolean>`(app_is_org_manager() OR app_worker_has_recipient_assignment(${recipientId}))`;
}

export async function isOrgManager(trx: Trx): Promise<boolean> {
  const r = await run(sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`, trx);
  return r.rows[0]?.ok === true;
}

export async function isOrgAdmin(trx: Trx): Promise<boolean> {
  const r = await run(sql<{ ok: boolean }>`SELECT app_is_org_admin() AS ok`, trx);
  return r.rows[0]?.ok === true;
}

/** ORGANIZATION_ADMIN or SUPERVISOR, or OrganizationAccessDeniedError (403). */
export async function assertOrgManager(trx: Trx): Promise<void> {
  if (!(await isOrgManager(trx))) throw new OrganizationAccessDeniedError();
}

export async function canSeeRecipient(trx: Trx, recipientId: string): Promise<boolean> {
  const r = await run(sql<{ ok: boolean }>`SELECT ${recipientVisibleSql(recipientId)} AS ok`, trx);
  return r.rows[0]?.ok === true;
}

export async function canSeeRecipientAsStaff(trx: Trx, recipientId: string): Promise<boolean> {
  const r = await run(sql<{ ok: boolean }>`SELECT ${recipientStaffSql(recipientId)} AS ok`, trx);
  return r.rows[0]?.ok === true;
}

/**
 * Who may see one shift: managers, caregivers currently assigned to it, and
 * the family of the person it is for (shifts_family_read, 038).
 */
export async function canSeeShift(trx: Trx, shiftId: string, opts: { family?: boolean } = {}): Promise<boolean> {
  const family = opts.family ?? true;
  const r = await run(sql<{ ok: boolean }>`
    SELECT (app_is_org_manager()
      OR app_worker_has_shift_assignment(${shiftId}::uuid)
      OR (${family} AND EXISTS (
        SELECT 1 FROM shifts s
        WHERE s.id = ${shiftId}::uuid
          AND s.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND s.care_recipient_id IS NOT NULL
          AND ${familyOfRecipientSql(sql`s.care_recipient_id`)}))) AS ok`, trx);
  return r.rows[0]?.ok === true;
}

/** The caller's own active caregiver membership in the current organization, if any. */
export async function ownWorkerMembershipId(trx: Trx): Promise<string | null> {
  const r = await run(sql<{ id: string }>`
    SELECT owm.id FROM organization_worker_memberships owm
    JOIN workers w ON w.id = owm.worker_id
    WHERE w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND owm.status = 'active'
    LIMIT 1`, trx);
  return r.rows[0]?.id ?? null;
}

/**
 * Raw care-event rows (with note_text and structured_data) for staff only:
 * managers, or the caregiver assigned to BOTH that event's shift and person
 * (care_events_worker_assigned_only, 018), plus the records a caregiver wrote
 * herself while her membership in this agency is active, so a completed visit
 * still shows her own records (history), never other caregivers' records. Family reads go through the family
 * timeline, which summarizes events. Expects the care_events alias `ce`.
 */
export function eventStaffVisibleSql(): RawBuilder<boolean> {
  return sql<boolean>`(app_is_org_manager()
    OR (app_worker_has_shift_assignment(ce.shift_id) AND app_worker_has_recipient_assignment(ce.care_recipient_id))
    OR app_is_own_worker_membership(ce.organization_worker_membership_id))`;
}

/**
 * A conversation is open to its participants only, and only while they are
 * still authorized for the person it is about (manager, assigned caregiver or
 * active family). Same rule as RLS message_threads_read / messages_read (038).
 */
export function threadAccessSql(threadId: RawBuilder<unknown>): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM message_threads mt_acl
    JOIN message_thread_participants mtp_acl
      ON mtp_acl.message_thread_id = mt_acl.id AND mtp_acl.organization_id = mt_acl.organization_id
    WHERE mt_acl.id = ${threadId}
      AND mt_acl.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND mtp_acl.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND (mt_acl.thread_type <> 'caregiver_agency'
        OR app_user_can_access_caregiver_thread(NULLIF(current_setting('app.current_user_id', true), '')::uuid, mt_acl.id))
      AND (app_is_org_manager()
        OR mt_acl.care_recipient_id IS NULL
        OR app_user_authorized_for_recipient(
             NULLIF(current_setting('app.current_user_id', true), '')::uuid,
             mt_acl.organization_id, mt_acl.care_recipient_id)))`;
}

/**
 * Who may schedule for one person: agency managers, or the administrator of
 * the establishment where that person lives (establishment admins manage
 * shifts and assignments of their own establishment, see establishmentAccess).
 */
export function scheduleManagerSql(recipientId: RawBuilder<unknown> | string | null): RawBuilder<boolean> {
  return sql<boolean>`(app_is_org_manager() OR EXISTS (
    SELECT 1 FROM care_recipients cr_acl
    WHERE cr_acl.id = ${recipientId}::uuid
      AND cr_acl.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND cr_acl.location_id IS NOT NULL
      AND app_is_establishment_admin(cr_acl.location_id)))`;
}

export async function canManageScheduleFor(trx: Trx, recipientId: string | null | undefined): Promise<boolean> {
  const r = await run(sql<{ ok: boolean }>`SELECT ${scheduleManagerSql(recipientId ?? null)} AS ok`, trx);
  return r.rows[0]?.ok === true;
}

/** Same as canManageScheduleFor, for an existing shift of the current organization. */
export async function canManageShift(trx: Trx, shiftId: string): Promise<boolean> {
  const r = await run(sql<{ ok: boolean }>`
    SELECT ${scheduleManagerSql(sql`(SELECT s.care_recipient_id FROM shifts s
      WHERE s.id = ${shiftId}::uuid
        AND s.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)`)} AS ok`, trx);
  return r.rows[0]?.ok === true;
}
