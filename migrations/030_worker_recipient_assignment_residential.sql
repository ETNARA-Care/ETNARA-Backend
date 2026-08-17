-- Migration 030: app_worker_has_recipient_assignment() -- residential support
-- ARCHITECTURE FINDING (confirmed via real execution, not by inspection
-- alone): this shared function, relied upon by care_recipients, care_events
-- and other tables' RLS since 018, only recognizes two cases:
--   1. assignments.care_recipient_id matches (home care assignment);
--   2. shifts.care_recipient_id matches (home care shift).
-- Neither branch can ever be true for a RESIDENTIAL (room-based) shift,
-- because both assignments.care_recipient_id and shifts.care_recipient_id
-- are NULL by design for room-based shifts. This means a worker assigned
-- to a ROOM has, under the current function, NO way to be recognized as
-- having a legitimate relationship to any specific resident housed in that
-- room -- RLS blocks visibility of that resident's care_recipients row
-- entirely, which in turn blocks Care Events (and anything else gated by
-- this function) for Residential mode structurally, not just apparently.
--
-- FIRST FIX ATTEMPT CAUSED INFINITE RECURSION (caught by real execution,
-- not assumed away): querying care_recipients directly inside this
-- function re-triggers care_recipients' own RLS policy, which calls this
-- very function again. The corrected fix isolates the ONE piece of data
-- actually needed (a recipient's room_id) behind a narrow, SECURITY
-- DEFINER helper that bypasses RLS strictly for that single column lookup
-- -- the standard, accepted PostgreSQL pattern for this exact class of
-- self-referential RLS problem. It exposes nothing beyond a room_id for a
-- recipient whose id the caller already possesses; it is not a general
-- care_recipients bypass.
CREATE OR REPLACE FUNCTION app_recipient_room_id(p_care_recipient_id uuid)
RETURNS uuid AS $$
    SELECT room_id FROM care_recipients WHERE id = p_care_recipient_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION app_worker_has_recipient_assignment(p_care_recipient_id uuid)
RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
        FROM assignments a
        JOIN organization_worker_memberships owm
          ON a.organization_worker_membership_id = owm.id
        WHERE a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND owm.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
          AND owm.status = 'active'
          AND (
                a.care_recipient_id = p_care_recipient_id
                OR EXISTS (
                    SELECT 1 FROM shifts s
                    WHERE s.id = a.shift_id
                      AND s.care_recipient_id = p_care_recipient_id
                )
                OR EXISTS ( -- residential (room-based) linkage, recursion-safe
                    SELECT 1 FROM shifts s
                    WHERE s.id = a.shift_id
                      AND s.room_id IS NOT NULL
                      AND s.room_id = app_recipient_room_id(p_care_recipient_id)
                )
          )
    );
$$ LANGUAGE sql STABLE;
