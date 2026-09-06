-- Migration 038: Cross-portal connectivity fixes (messaging participants,
-- notifications scoping, and family-safe read access to observations,
-- incidents, shifts, and verification_events).
--
-- CONTEXT: an audit confirmed (via live execution against a real
-- PostgreSQL instance, not just static review) that:
--   1. message_thread_participants_write (035) only lets an actor add
--      THEMSELVES as a participant (except org managers, who may already
--      add anyone). This blocks the app-layer fix that auto-adds every
--      OTHER legitimately-authorized party (family/worker/admin) when a
--      family_agency thread is resolved -- the actual root cause of
--      "the other portal never sees the conversation".
--   2. notifications_insert (036) only allows notifying a user who already
--      shares a message_thread with the actor. Care events and incidents
--      have no thread at all, so a worker could never create a
--      notification for family/admin about either.
--   3. observations, incidents, shifts, and verification_events have no
--      FAMILY-role read policy at all (unlike care_events, fixed in 033).
--
-- All changes below are additive/narrowing (least privilege): no existing
-- policy's authority is broadened beyond what is required for the actor to
-- act on behalf of the SAME care_recipient they are already independently
-- authorized for.

-- ---------------------------------------------------------------------
-- A. Generic "is this OTHER user authorized for this recipient" helper
-- ---------------------------------------------------------------------
-- Every existing helper (app_worker_has_recipient_assignment,
-- app_is_org_manager) evaluates the CURRENT session's user via
-- current_setting(...). Auto-adding OTHER users as message thread
-- participants (or notifying them) requires checking a DIFFERENT user's
-- authorization for a recipient, independent of who is calling. This is a
-- read-only, narrowly-scoped SECURITY DEFINER helper: given a user id, an
-- organization id and a care_recipient id it already knows, it returns
-- only a boolean -- it exposes no rows and no other user's data.
CREATE OR REPLACE FUNCTION app_user_authorized_for_recipient(
    p_user_id uuid,
    p_organization_id uuid,
    p_care_recipient_id uuid
)
RETURNS boolean AS $$
    SELECT
        EXISTS ( -- org admin/supervisor
            SELECT 1
            FROM organization_memberships om
            JOIN user_roles ur ON ur.organization_membership_id = om.id
            JOIN roles r ON ur.role_id = r.id
            WHERE om.user_id = p_user_id
              AND om.organization_id = p_organization_id
              AND om.status = 'active'
              AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
        )
        OR EXISTS ( -- worker with an active assignment to this recipient
            SELECT 1
            FROM assignments a
            JOIN organization_worker_memberships owm ON a.organization_worker_membership_id = owm.id
            JOIN workers w ON w.id = owm.worker_id
            WHERE a.organization_id = p_organization_id
              AND w.user_id = p_user_id
              AND owm.status = 'active'
              AND (
                    a.care_recipient_id = p_care_recipient_id
                    OR EXISTS (
                        SELECT 1 FROM shifts s
                        WHERE s.id = a.shift_id AND s.care_recipient_id = p_care_recipient_id
                    )
                    OR EXISTS ( -- residential (room-based) linkage, same helper as 030
                        SELECT 1 FROM shifts s
                        WHERE s.id = a.shift_id
                          AND s.room_id IS NOT NULL
                          AND s.room_id = app_recipient_room_id(p_care_recipient_id)
                    )
              )
        )
        OR EXISTS ( -- family member with an active relationship + FAMILY role still held
            SELECT 1 FROM family_relationships fr
            WHERE fr.user_id = p_user_id
              AND fr.organization_id = p_organization_id
              AND fr.care_recipient_id = p_care_recipient_id
              AND fr.status = 'active'
              AND EXISTS (
                  SELECT 1 FROM user_roles ur
                  JOIN organization_memberships om ON ur.organization_membership_id = om.id
                  JOIN roles r ON ur.role_id = r.id
                  WHERE om.user_id = p_user_id AND om.organization_id = p_organization_id AND r.code = 'FAMILY'
              )
        );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ---------------------------------------------------------------------
-- B. message_thread_participants: allow an authorized actor to add any
--    OTHER user who is independently authorized for the SAME recipient
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS message_thread_participants_write ON message_thread_participants;

CREATE POLICY message_thread_participants_write ON message_thread_participants
    FOR INSERT
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR (
                user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                AND app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id) IS NOT NULL
                AND (
                    app_worker_has_recipient_assignment(
                        app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id)
                    )
                    OR EXISTS (
                        SELECT 1 FROM family_relationships fr
                        WHERE fr.care_recipient_id = app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id)
                          AND fr.organization_id = message_thread_participants.organization_id
                          AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                          AND fr.status = 'active'
                    )
                )
            )
            OR ( -- NEW: adding a DIFFERENT user, only if (a) the calling
                 -- actor is themselves independently authorized for the
                 -- thread's recipient, and (b) the target user is ALSO
                 -- independently authorized for that exact same recipient.
                 -- Neither side can add a stranger; both must already have
                 -- a legitimate, pre-existing relationship to the recipient.
                app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id) IS NOT NULL
                AND app_user_authorized_for_recipient(
                        NULLIF(current_setting('app.current_user_id', true), '')::uuid,
                        message_thread_participants.organization_id,
                        app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id)
                    )
                AND app_user_authorized_for_recipient(
                        message_thread_participants.user_id,
                        message_thread_participants.organization_id,
                        app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id)
                    )
            )
        )
        OR app_is_superadmin()
    );

-- ---------------------------------------------------------------------
-- C. notifications: allow inserting a notification for another user when
--    both the actor and the target are independently authorized for the
--    SAME care_recipient (in addition to the existing self/thread-shared
--    branches, unchanged).
-- ---------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN care_recipient_id uuid NULL;
-- Nullable: only populated for recipient-scoped notification types
-- (NEW_CARE_EVENT, NEW_INCIDENT below); NEW_MESSAGE and any future
-- non-recipient-scoped notification types leave this NULL and keep using
-- the existing thread-shared branch instead.
ALTER TABLE notifications ADD CONSTRAINT notifications_care_recipient_fk
    FOREIGN KEY (care_recipient_id, organization_id) REFERENCES care_recipients (id, organization_id);

DROP POLICY IF EXISTS notifications_insert ON notifications;

CREATE POLICY notifications_insert ON notifications
    FOR INSERT
    WITH CHECK (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        OR EXISTS (
            SELECT 1 FROM message_thread_participants mine
            JOIN message_thread_participants theirs
              ON theirs.message_thread_id = mine.message_thread_id
            WHERE mine.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND theirs.user_id = notifications.user_id
        )
        OR (
            notifications.care_recipient_id IS NOT NULL
            AND notifications.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
            AND app_user_authorized_for_recipient(
                    NULLIF(current_setting('app.current_user_id', true), '')::uuid,
                    notifications.organization_id,
                    notifications.care_recipient_id
                )
            AND app_user_authorized_for_recipient(
                    notifications.user_id,
                    notifications.organization_id,
                    notifications.care_recipient_id
                )
        )
        OR app_is_superadmin()
    );

-- ---------------------------------------------------------------------
-- D. Family-safe read access: observations, incidents, shifts,
--    verification_events. Row-level only -- the family-facing service
--    layer (observations/incidents/scheduling) additionally selects only
--    a reduced, non-clinical/non-administrative subset of columns for
--    FAMILY callers (e.g. never actions_taken/resolution/assigned_to on
--    incidents, never description on observations, never lat/lng or
--    verification method on shifts), matching the same defense-in-depth
--    idiom already used for care_event photo visibility (033).
-- ---------------------------------------------------------------------
CREATE POLICY observations_family_read ON observations
    FOR SELECT
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM family_relationships fr
            WHERE fr.care_recipient_id = observations.care_recipient_id
              AND fr.organization_id = observations.organization_id
              AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND fr.status = 'active'
        )
    );

CREATE POLICY incidents_family_read ON incidents
    FOR SELECT
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM family_relationships fr
            WHERE fr.care_recipient_id = incidents.care_recipient_id
              AND fr.organization_id = incidents.organization_id
              AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND fr.status = 'active'
        )
    );

CREATE POLICY shifts_family_read ON shifts
    FOR SELECT
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            (shifts.care_recipient_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM family_relationships fr
                WHERE fr.care_recipient_id = shifts.care_recipient_id
                  AND fr.organization_id = shifts.organization_id
                  AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                  AND fr.status = 'active'
            ))
            OR (shifts.room_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM family_relationships fr
                WHERE fr.organization_id = shifts.organization_id
                  AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                  AND fr.status = 'active'
                  AND app_recipient_room_id(fr.care_recipient_id) = shifts.room_id
            ))
        )
    );

CREATE POLICY verification_events_family_read ON verification_events
    FOR SELECT
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM shifts s
            WHERE s.id = verification_events.shift_id
              AND s.organization_id = verification_events.organization_id
              AND (
                    (s.care_recipient_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM family_relationships fr
                        WHERE fr.care_recipient_id = s.care_recipient_id
                          AND fr.organization_id = s.organization_id
                          AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                          AND fr.status = 'active'
                    ))
                    OR (s.room_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM family_relationships fr
                        WHERE fr.organization_id = s.organization_id
                          AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                          AND fr.status = 'active'
                          AND app_recipient_room_id(fr.care_recipient_id) = s.room_id
                    ))
              )
        )
    );
