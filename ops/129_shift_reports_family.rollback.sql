-- Rollback of 129 (Informe de Turno F3). Functions only; no data is changed or removed.
-- PDF_DOWNLOADED history rows written by 129 stay (append-only history; 126 already allows that type).
BEGIN;
DROP FUNCTION IF EXISTS app_shift_report_family_pdf(uuid, uuid);
DROP FUNCTION IF EXISTS app_shift_report_family_get(uuid, uuid);
DROP FUNCTION IF EXISTS app_shift_report_family_list(uuid);
DROP FUNCTION IF EXISTS app_shift_report_family_project(uuid);
DROP FUNCTION IF EXISTS app_shift_report_family_pick(jsonb, text[]);
DROP FUNCTION IF EXISTS app_is_my_family_recipient(uuid);
DELETE FROM schema_migrations WHERE filename = '129_shift_reports_family.sql';
COMMIT;
