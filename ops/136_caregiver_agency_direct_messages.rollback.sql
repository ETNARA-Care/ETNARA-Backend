-- Rollback of 136 (mensajería directa agencia ↔ cuidadora). Run as the migrations superuser,
-- AFTER redeploying the previous backend build (the 136 code calls these functions).
-- Non-destructive: conversations, participants and messages are KEPT, and so are the column
-- message_threads.organization_worker_membership_id, its foreign key, the shape check and the
-- unique index (nothing in the previous code reads them). Only functions and policies go.
-- After this, existing direct conversations behave like any conversation without a resident
-- (readable by their participants), exactly as before 136.
BEGIN;
DROP POLICY IF EXISTS message_threads_caregiver_agency_guard ON message_threads;
DROP POLICY IF EXISTS messages_caregiver_agency_guard ON messages;
DROP POLICY IF EXISTS message_thread_participants_caregiver_agency_guard ON message_thread_participants;
DROP FUNCTION IF EXISTS public.app_open_caregiver_thread(uuid);
DROP FUNCTION IF EXISTS public.app_thread_direct_guard(uuid);
DROP FUNCTION IF EXISTS public.app_is_caregiver_thread(uuid);
DROP FUNCTION IF EXISTS public.app_user_can_access_caregiver_thread(uuid, uuid);
DELETE FROM schema_migrations WHERE filename = '136_caregiver_agency_direct_messages.sql';
COMMIT;
