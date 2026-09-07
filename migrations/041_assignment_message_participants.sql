-- Migration 041: make every currently assigned active worker a participant
-- in existing family_agency threads for the same care recipient.
--
-- Migration 039 repaired assignments that existed at that time. New
-- assignments are now handled transactionally by assignments.service.ts;
-- this idempotent backfill closes the gap for assignments created between
-- those two releases. It never deletes or broadens a relationship.

INSERT INTO message_thread_participants (organization_id, message_thread_id, user_id, can_write)
SELECT DISTINCT mt.organization_id, mt.id, w.user_id, true
FROM message_threads mt
JOIN assignments a ON a.organization_id = mt.organization_id
JOIN organization_worker_memberships owm
  ON owm.id = a.organization_worker_membership_id
 AND owm.status = 'active'
JOIN workers w ON w.id = owm.worker_id
LEFT JOIN shifts s ON s.id = a.shift_id
WHERE mt.thread_type = 'family_agency'
  AND mt.care_recipient_id IS NOT NULL
  AND w.user_id IS NOT NULL
  AND (
    a.care_recipient_id = mt.care_recipient_id
    OR s.care_recipient_id = mt.care_recipient_id
    OR (s.room_id IS NOT NULL AND s.room_id = app_recipient_room_id(mt.care_recipient_id))
  )
ON CONFLICT (message_thread_id, user_id) DO NOTHING;
