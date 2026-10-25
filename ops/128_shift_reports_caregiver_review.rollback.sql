-- Rollback of migration 128 (Informe de Turno F2). Run as the owner, ONLY after the
-- backend is back on a version without the F2 routes and worker.
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f ops/128_shift_reports_caregiver_review.rollback.sql
-- It aborts (and changes nothing) when any caregiver work exists: a final observation,
-- a submission or a return. Those are real data; fix forward instead.
-- F1 (126) keeps working afterwards: drafts are again created by the TS builder of the
-- previous backend; reports and their history stay.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shift_reports WHERE caregiver_note IS NOT NULL OR submitted_at IS NOT NULL OR status IN ('SUBMITTED', 'RETURNED'))
     OR EXISTS (SELECT 1 FROM shift_report_events WHERE event_type IN ('OBSERVATION_ADDED', 'SUBMITTED', 'RETURNED')) THEN
    RAISE EXCEPTION 'caregiver reviews exist: rollback aborted (fix forward)';
  END IF;
END $$;

DROP POLICY IF EXISTS shift_reports_own_visit_read ON shift_reports;
DROP POLICY IF EXISTS shift_report_events_own_visit_read ON shift_report_events;
DROP FUNCTION IF EXISTS app_shift_report_submit(uuid);
DROP FUNCTION IF EXISTS app_shift_report_set_observation(uuid, text);
DROP FUNCTION IF EXISTS app_shift_report_lock_own(uuid);
DROP FUNCTION IF EXISTS app_is_my_worker_membership(uuid);
DROP FUNCTION IF EXISTS app_shift_report_return(uuid, text);
DROP FUNCTION IF EXISTS app_shift_report_refresh(uuid);
DROP FUNCTION IF EXISTS app_shift_report_ensure(uuid);
DROP FUNCTION IF EXISTS app_shift_report_assert_reviewer();
DROP FUNCTION IF EXISTS app_shift_reports_generate_pending();
DROP FUNCTION IF EXISTS app_shift_report_create_draft(uuid, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS app_shift_report_build_content(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS app_shift_report_visits(uuid, uuid);
DROP FUNCTION IF EXISTS app_shift_report_text(text);
DROP FUNCTION IF EXISTS app_shift_report_str(jsonb);
DROP FUNCTION IF EXISTS app_shift_report_iso(timestamptz);

-- 126 guard, verbatim.
CREATE OR REPLACE FUNCTION app_shift_report_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SHIFT_REPORT_NOT_DELETABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.shift_id <> OLD.shift_id
     OR NEW.organization_worker_membership_id <> OLD.organization_worker_membership_id
     OR NEW.care_recipient_id <> OLD.care_recipient_id OR NEW.version <> OLD.version
     OR NEW.supersedes_report_id IS DISTINCT FROM OLD.supersedes_report_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'SHIFT_REPORT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('APPROVED', 'SUPERSEDED') THEN
    IF NOT (OLD.status = 'APPROVED' AND NEW.status = 'SUPERSEDED'
            AND NEW.content = OLD.content AND NEW.content_schema = OLD.content_schema
            AND NEW.family_sections IS NOT DISTINCT FROM OLD.family_sections
            AND NEW.agency_summary IS NOT DISTINCT FROM OLD.agency_summary
            AND NEW.generated_at = OLD.generated_at
            AND NEW.approved_at = OLD.approved_at AND NEW.approved_by_user_id = OLD.approved_by_user_id) THEN
      RAISE EXCEPTION 'SHIFT_REPORT_APPROVED_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Nobody approves the report of their own visit (also an admin who worked it).
  IF NEW.status = 'APPROVED' AND OLD.status <> 'APPROVED' AND EXISTS (
       SELECT 1 FROM public.organization_worker_memberships owm JOIN public.workers w ON w.id = owm.worker_id
       WHERE owm.id = NEW.organization_worker_membership_id AND w.user_id = NEW.approved_by_user_id) THEN
    RAISE EXCEPTION 'SHIFT_REPORT_SELF_APPROVAL' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP INDEX IF EXISTS shift_reports_member_idx;
ALTER TABLE shift_reports DROP CONSTRAINT IF EXISTS shift_reports_caregiver_note_pair;
ALTER TABLE shift_reports DROP CONSTRAINT IF EXISTS shift_reports_caregiver_note_len;
ALTER TABLE shift_reports DROP COLUMN IF EXISTS submitted_at;
ALTER TABLE shift_reports DROP COLUMN IF EXISTS caregiver_note_at;
ALTER TABLE shift_reports DROP COLUMN IF EXISTS caregiver_note;
ALTER TABLE shift_reports DROP COLUMN IF EXISTS review_deadline_at;

DELETE FROM schema_migrations WHERE filename = '128_shift_reports_caregiver_review.sql';

COMMIT;
