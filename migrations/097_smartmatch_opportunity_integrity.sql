-- Migration 097: SmartMatch Gate 3 -- opportunity integrity hardening.
--
-- Found by a catalog audit and confirmed as app_runtime on PostgreSQL 16:
--   1. an agency administrator could move a FILLED opportunity back to
--      PUBLISHED (reopening it after an approval) or to any other status;
--   2. schedule, municipality and role of a PUBLISHED opportunity could be
--      changed after caregivers had consented to the original terms;
--   3. an opportunity could be INSERTed directly as PUBLISHED or FILLED,
--      bypassing the draft -> publish step;
--   4. a caregiver could attach decision_checks/decision_reason while
--      withdrawing, polluting the decision history.
--
-- The state machine is a trigger, so it binds every writer (including
-- direct privileged SQL), not only app_runtime.

-- 1 + 2. Status transitions and immutable terms ---------------------------
CREATE OR REPLACE FUNCTION public.app_smartmatch_opportunity_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT'     AND NEW.status IN ('PUBLISHED', 'CANCELLED'))
    OR (OLD.status = 'PUBLISHED' AND NEW.status IN ('FILLED', 'CANCELLED', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'SMARTMATCH_INVALID_STATUS_TRANSITION % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       NEW.region_label IS DISTINCT FROM OLD.region_label
    OR NEW.role_label   IS DISTINCT FROM OLD.role_label
    OR NEW.starts_at    IS DISTINCT FROM OLD.starts_at
    OR NEW.ends_at      IS DISTINCT FROM OLD.ends_at
    OR NEW.visibility   IS DISTINCT FROM OLD.visibility
  ) THEN
    RAISE EXCEPTION 'SMARTMATCH_TERMS_LOCKED_AFTER_PUBLISH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_smartmatch_opportunity_transition ON smartmatch_opportunities;
CREATE TRIGGER trg_smartmatch_opportunity_transition
  BEFORE UPDATE ON smartmatch_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.app_smartmatch_opportunity_transition();

-- 3. New opportunities start as INTERNAL drafts ---------------------------
DROP POLICY IF EXISTS smartmatch_opportunities_agency_admin_insert ON smartmatch_opportunities;
CREATE POLICY smartmatch_opportunities_agency_admin_insert
ON smartmatch_opportunities
FOR INSERT TO app_runtime
WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND created_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND status = 'DRAFT'
  AND visibility = 'INTERNAL'
  AND app_is_org_admin()
);
-- id and timestamps come from defaults, never from the client.
REVOKE INSERT ON smartmatch_opportunities FROM app_runtime;
GRANT INSERT (organization_id, created_by_user_id, visibility, status,
              region_label, role_label, starts_at, ends_at, expires_at)
  ON smartmatch_opportunities TO app_runtime;

-- 4. Withdrawal carries no decision data ----------------------------------
DROP POLICY IF EXISTS smartmatch_applications_worker_withdraw ON smartmatch_applications;
CREATE POLICY smartmatch_applications_worker_withdraw
ON smartmatch_applications
FOR UPDATE TO app_runtime
USING (
  caregiver_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND status = 'PENDING'
  AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_smartmatch_is_active_worker()
)
WITH CHECK (
  caregiver_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND status = 'WITHDRAWN'
  AND withdrawn_at IS NOT NULL
  AND decided_by_user_id IS NULL
  AND decided_at IS NULL
  AND decision_reason IS NULL
  AND decision_checks IS NULL
);
