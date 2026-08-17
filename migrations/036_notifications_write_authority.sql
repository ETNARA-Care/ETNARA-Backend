-- Migration 036: notifications write authority
--
-- ARCHITECTURE FINDING + SECURITY ISSUE FOUND, both confirmed via direct
-- execution:
--
-- 1. notifications_self_only (013/014) is FOR ALL with user_id =
--    current_user only -- this structurally BLOCKS the core "notify the
--    other participant when I send a message" flow: the sender's own
--    session context can never insert a notification row for a DIFFERENT
--    user_id. Confirmed: attempting to notify another participant fails
--    outright under app_runtime.
-- 2. The same broad policy also lets ANY user INSERT an arbitrary
--    self-notification with fabricated type/content. Confirmed: a plain
--    user successfully inserted a fake notification for themselves.
--
-- Fix: notifications are meant to be exclusively server/domain-generated
-- (never a client-exposed "create notification" endpoint -- none exists in
-- this codebase). RLS INSERT authority is scoped narrowly: an actor may
-- create a notification for a DIFFERENT user only if that user shares an
-- actual message_thread with the actor. SELECT/UPDATE remain strictly
-- self-only, unchanged.

DROP POLICY IF EXISTS notifications_self_only ON notifications;

CREATE POLICY notifications_read ON notifications
    FOR SELECT
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid OR app_is_superadmin());

CREATE POLICY notifications_update_own ON notifications
    FOR UPDATE
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid OR app_is_superadmin())
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid OR app_is_superadmin());

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
        OR app_is_superadmin()
    );
