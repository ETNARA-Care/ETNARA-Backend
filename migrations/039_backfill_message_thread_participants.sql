-- Migration 039: Backfill message_thread_participants for existing
-- family_agency threads.
--
-- Purpose: 038 fixes the app-layer bug going forward (new/resolved threads
-- now get every authorized party added automatically), but existing
-- threads created before that fix may still be missing participants who
-- are demonstrably authorized right now. This is a pure, idempotent DATA
-- backfill (no schema change): every INSERT uses
-- ON CONFLICT (message_thread_id, user_id) DO NOTHING, so re-running this
-- file (or re-running it against a database where it partially applied)
-- can never create a duplicate participant row and never touches any
-- other table. No rows are deleted or modified.

-- Family members currently authorized for the thread's recipient.
INSERT INTO message_thread_participants (organization_id, message_thread_id, user_id, can_write)
SELECT mt.organization_id, mt.id, fr.user_id, true
FROM message_threads mt
JOIN family_relationships fr
  ON fr.care_recipient_id = mt.care_recipient_id
 AND fr.organization_id = mt.organization_id
 AND fr.status = 'active'
WHERE mt.thread_type = 'family_agency'
  AND mt.care_recipient_id IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN organization_memberships om ON ur.organization_membership_id = om.id
      JOIN roles r ON ur.role_id = r.id
      WHERE om.user_id = fr.user_id AND om.organization_id = mt.organization_id
        AND om.status = 'active' AND r.code = 'FAMILY'
  )
ON CONFLICT (message_thread_id, user_id) DO NOTHING;

-- Workers with an active assignment (direct, shift-based, or residential
-- room-based) to the thread's recipient -- same three branches as
-- app_worker_has_recipient_assignment() (030), evaluated here for every
-- worker rather than only the current session's.
INSERT INTO message_thread_participants (organization_id, message_thread_id, user_id, can_write)
SELECT DISTINCT mt.organization_id, mt.id, w.user_id, true
FROM message_threads mt
JOIN assignments a ON a.organization_id = mt.organization_id
JOIN organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id AND owm.status = 'active'
JOIN workers w ON w.id = owm.worker_id
LEFT JOIN shifts s ON s.id = a.shift_id
WHERE mt.thread_type = 'family_agency'
  AND mt.care_recipient_id IS NOT NULL
  AND (
        a.care_recipient_id = mt.care_recipient_id
        OR s.care_recipient_id = mt.care_recipient_id
        OR (s.room_id IS NOT NULL AND s.room_id = app_recipient_room_id(mt.care_recipient_id))
  )
ON CONFLICT (message_thread_id, user_id) DO NOTHING;

-- Org admins/supervisors: full-tenant messaging visibility, same
-- authority app_is_org_manager() already grants them elsewhere.
INSERT INTO message_thread_participants (organization_id, message_thread_id, user_id, can_write)
SELECT DISTINCT mt.organization_id, mt.id, om.user_id, true
FROM message_threads mt
JOIN organization_memberships om ON om.organization_id = mt.organization_id AND om.status = 'active'
JOIN user_roles ur ON ur.organization_membership_id = om.id
JOIN roles r ON r.id = ur.role_id AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
WHERE mt.thread_type = 'family_agency'
  AND mt.care_recipient_id IS NOT NULL
ON CONFLICT (message_thread_id, user_id) DO NOTHING;
