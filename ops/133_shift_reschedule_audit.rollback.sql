-- Rollback of 133 (cambios de horario auditados y avisados). Trigger and function only.
-- The SHIFT_RESCHEDULED audit_log rows and notifications already written stay
-- (append-only history; nothing reads them in a way that breaks without the trigger).
-- Code needs no redeploy: 133 has no application code.
BEGIN;
DROP TRIGGER IF EXISTS shifts_reschedule_audit ON shifts;
DROP FUNCTION IF EXISTS app_shift_reschedule_audit();
DELETE FROM schema_migrations WHERE filename = '133_shift_reschedule_audit.sql';
COMMIT;
