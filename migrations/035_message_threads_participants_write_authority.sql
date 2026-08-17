-- Migration 035: message_threads / message_thread_participants / messages
-- write authority
--
-- SECURITY ISSUES FOUND during this gate's audit, confirmed via direct
-- execution against PostgreSQL (not assumed):
--
-- 1. message_threads_participant_only (013/014) is FOR ALL with no
--    separate INSERT branch -- the same bootstrap problem seen repeatedly
--    in this project (family_invitations, sessions, workers): creating a
--    NEW thread requires the actor to already be a participant, which is
--    impossible at creation time. Confirmed: thread creation fails
--    entirely under app_runtime.
--
-- 2. message_thread_participants_self_or_staff (013/014) allows ANY
--    active org member (app_has_active_membership(), no further check) to
--    INSERT a participant row into ANY thread in the org -- including
--    adding THEMSELVES or ANY OTHER USER to a conversation they have no
--    legitimate relationship to. Confirmed: a plain member with no
--    connection to a recipient successfully added themselves as a
--    participant of that recipient's family conversation thread.
--
-- 3. messages_via_participation (013/014) checks only that the sender is
--    A participant -- it never checks message_thread_participants.can_write.
--    Confirmed: a participant explicitly marked can_write=false could
--    still send messages.
--
-- Fix, following the same authorization chain already established and
-- approved for care_events/observations/incidents.

-- Narrow SECURITY DEFINER helper (same pattern as app_recipient_room_id()
-- in 030 and app_thread_recipient_id() below): the messaging service needs
-- to check "does a family_agency thread already exist for this recipient"
-- BEFORE the calling actor is a participant of it -- that is the entire
-- point of the lookup (reuse instead of duplicate for a newly-authorized
-- actor who isn't a participant yet). message_threads_read requires
-- already being a participant, so this exact lookup is invisible to a
-- legitimately-authorized-but-not-yet-joined actor without this helper.
-- Returns only an opaque thread id for a (org, recipient) pair the caller
-- already knows; the caller must still pass every other authorization
-- check independently before this is ever invoked.
CREATE OR REPLACE FUNCTION app_find_family_thread_id(p_organization_id uuid, p_care_recipient_id uuid)
RETURNS uuid AS $$
    SELECT id FROM message_threads
    WHERE organization_id = p_organization_id AND care_recipient_id = p_care_recipient_id AND thread_type = 'family_agency'
    LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DROP POLICY IF EXISTS message_threads_participant_only ON message_threads;

CREATE POLICY message_threads_read ON message_threads
    FOR SELECT
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM message_thread_participants mtp
            WHERE mtp.message_thread_id = message_threads.id
              AND mtp.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        )
        AND ( -- LIVE re-check, not just historical participation (section 21:
              -- revocation must apply immediately, even to a conversation the
              -- user was already a real participant of)
            app_is_org_manager()
            OR care_recipient_id IS NULL
            OR app_worker_has_recipient_assignment(care_recipient_id)
            OR EXISTS (
                SELECT 1 FROM family_relationships fr
                WHERE fr.care_recipient_id = message_threads.care_recipient_id
                  AND fr.organization_id = message_threads.organization_id
                  AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                  AND fr.status = 'active'
            )
        )
        OR app_is_superadmin()
    );

CREATE POLICY message_threads_create ON message_threads
    FOR INSERT
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR (care_recipient_id IS NOT NULL AND app_worker_has_recipient_assignment(care_recipient_id))
            OR (
                care_recipient_id IS NOT NULL
                AND EXISTS (
                    SELECT 1 FROM family_relationships fr
                    WHERE fr.care_recipient_id = message_threads.care_recipient_id
                      AND fr.organization_id = message_threads.organization_id
                      AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                      AND fr.status = 'active'
                )
            )
        )
        OR app_is_superadmin()
    );

DROP POLICY IF EXISTS message_thread_participants_self_or_staff ON message_thread_participants;

CREATE POLICY message_thread_participants_read ON message_thread_participants
    FOR SELECT
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid OR app_has_active_membership())
        OR app_is_superadmin()
    );

-- Narrow SECURITY DEFINER helper (same pattern as app_recipient_room_id()
-- in 030): reading a thread's care_recipient_id here is necessary to
-- authorize a user joining it as a participant, but message_threads' own
-- SELECT policy requires ALREADY being a participant -- exactly the
-- circularity being resolved (a user can't be checked against a thread
-- they're not yet visibly part of, in order to become part of it).
-- Exposes nothing beyond a care_recipient_id for a thread_id the caller
-- already possesses; not a general message_threads bypass.
CREATE OR REPLACE FUNCTION app_thread_recipient_id(p_thread_id uuid, p_organization_id uuid)
RETURNS uuid AS $$
    SELECT care_recipient_id FROM message_threads WHERE id = p_thread_id AND organization_id = p_organization_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

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
        )
        OR app_is_superadmin()
    );

DROP POLICY IF EXISTS messages_via_participation ON messages;

CREATE POLICY messages_read ON messages
    FOR SELECT
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM message_thread_participants mtp
            WHERE mtp.message_thread_id = messages.message_thread_id
              AND mtp.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        )
        AND EXISTS ( -- LIVE re-check via the thread's own (now-fixed) read policy
            SELECT 1 FROM message_threads mt WHERE mt.id = messages.message_thread_id
        )
        OR app_is_superadmin()
    );

CREATE POLICY messages_write ON messages
    FOR INSERT
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND sender_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM message_thread_participants mtp
            WHERE mtp.message_thread_id = messages.message_thread_id
              AND mtp.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND mtp.can_write = true
        )
        OR app_is_superadmin()
    );
