-- Migration 096: SmartMatch Gate 2 -- agency decisions, re-apply after
-- withdrawal, and an append-only decision history.
--
-- Decisions follow this project's pattern for FORCE-RLS tables: direct
-- app_runtime policies (no SECURITY DEFINER reads of FORCE tables). The
-- backend runs every decision as ONE transaction that locks the opportunity
-- row, then the application row (SELECT ... FOR UPDATE), re-validates
-- membership, credentials, availability and consent, and only then writes.
-- RLS independently guarantees: only an active ORGANIZATION_ADMIN of the
-- application's own agency, never the applicant themself, only from
-- PENDING, and the decision is signed by the session user.

-- 1. Re-apply after withdrawal --------------------------------------------
-- One open (non-withdrawn) application per caregiver and opportunity.
-- Withdrawn rows are kept as history; a REJECTED or APPROVED row still
-- blocks a new application. Concurrent submissions: the unique index admits
-- exactly one.
ALTER TABLE smartmatch_applications
  DROP CONSTRAINT IF EXISTS smartmatch_applications_opportunity_id_caregiver_user_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_smartmatch_one_open_application_per_caregiver
  ON smartmatch_applications (opportunity_id, caregiver_user_id)
  WHERE status <> 'WITHDRAWN';

-- An application may only be created while its opportunity is still open,
-- checked again at COMMIT. The composite FK takes a KEY SHARE lock on the
-- opportunity row, so a submission and an approval of the same opportunity
-- serialize; this deferred check then rejects a submission that would land
-- on an opportunity filled in the meantime.
CREATE OR REPLACE FUNCTION public.app_smartmatch_assert_opportunity_open()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'PENDING' AND NOT EXISTS (
    SELECT 1 FROM public.smartmatch_opportunities o
    WHERE o.id = NEW.opportunity_id
      AND o.organization_id = NEW.organization_id
      AND o.status = 'PUBLISHED'
      AND o.visibility = 'INTERNAL'
      AND o.starts_at > now()
  ) THEN
    RAISE EXCEPTION 'SMARTMATCH_OPPORTUNITY_NOT_OPEN' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_smartmatch_application_opportunity_open ON smartmatch_applications;
CREATE CONSTRAINT TRIGGER trg_smartmatch_application_opportunity_open
  AFTER INSERT ON smartmatch_applications
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.app_smartmatch_assert_opportunity_open();

-- 2. Decision record -------------------------------------------------------
ALTER TABLE smartmatch_applications
  ADD COLUMN IF NOT EXISTS decision_reason varchar(40),
  ADD COLUMN IF NOT EXISTS decision_checks jsonb;

ALTER TABLE smartmatch_applications
  ADD CONSTRAINT smartmatch_decision_reason_values CHECK (
    decision_reason IS NULL OR decision_reason IN
      ('APPROVED_ELIGIBLE', 'AGENCY_REJECTED', 'OPPORTUNITY_FILLED')
  ) NOT VALID;
ALTER TABLE smartmatch_applications
  ADD CONSTRAINT smartmatch_decision_reason_consistency CHECK (
    (status IN ('APPROVED', 'REJECTED')) = (decision_reason IS NOT NULL)
  ) NOT VALID;
-- An approval must carry the server-side checks that justified it. This is
-- a contract on every writer, not a substitute for the backend checks.
ALTER TABLE smartmatch_applications
  ADD CONSTRAINT smartmatch_approval_requires_checks CHECK (
    -- COALESCE: a NULL decision_checks must fail the CHECK, not pass it
    -- (a CHECK that evaluates to NULL is accepted by PostgreSQL).
    status <> 'APPROVED' OR COALESCE((
      decision_reason = 'APPROVED_ELIGIBLE'
      AND jsonb_typeof(decision_checks) = 'object'
      AND decision_checks->>'approvable' = 'true'
      AND decision_checks->>'membershipActive' = 'true'
      AND decision_checks->>'credentialsEligible' = 'true'
      AND decision_checks->>'availabilityCovers' = 'true'
      AND decision_checks->>'consentRecorded' = 'true'
    ), false)
  ) NOT VALID;

-- Agency decision: PENDING -> APPROVED | REJECTED, own agency, admin only,
-- never on one's own application, signed by the session user.
CREATE POLICY smartmatch_applications_agency_decision
ON smartmatch_applications
FOR UPDATE TO app_runtime
USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND status = 'PENDING'
  AND caregiver_user_id <> NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND app_is_org_admin()
)
WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND status IN ('APPROVED', 'REJECTED')
  AND decided_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND decided_at IS NOT NULL
  AND caregiver_user_id <> NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND app_is_org_admin()
);
GRANT UPDATE (decided_by_user_id, decided_at, decision_reason, decision_checks)
  ON smartmatch_applications TO app_runtime;

-- 3. Append-only decision history -----------------------------------------
-- Not audit_log: its policy lets every member of the organization (including
-- caregivers) read it, which would expose who applied and their checks.
-- RLS is ENABLED (not FORCED) so the SECURITY DEFINER trigger below -- the
-- only writer -- can insert; app_runtime has SELECT only.
CREATE TABLE IF NOT EXISTS smartmatch_application_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  application_id uuid NOT NULL REFERENCES smartmatch_applications(id),
  -- No FK on opportunity_id on purpose: an FK check would take a KEY SHARE
  -- lock on the opportunity row from a caregiver's withdrawal, inverting the
  -- lock order of an agency decision (opportunity -> application) and
  -- deadlocking. Integrity holds through application_id, whose row
  -- references the opportunity.
  opportunity_id uuid NOT NULL,
  caregiver_user_id uuid NOT NULL REFERENCES users(id),
  actor_user_id uuid REFERENCES users(id),
  event_type varchar(20) NOT NULL CHECK (event_type IN
    ('SUBMITTED', 'WITHDRAWN', 'APPROVED', 'REJECTED')),
  previous_status text,
  new_status text NOT NULL,
  decision_reason varchar(40),
  decision_checks jsonb,
  consent_version varchar(40),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_smartmatch_application_events_app
  ON smartmatch_application_events (application_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_smartmatch_application_events_org
  ON smartmatch_application_events (organization_id, occurred_at DESC);
ALTER TABLE smartmatch_application_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY smartmatch_application_events_agency_read
ON smartmatch_application_events
FOR SELECT TO app_runtime
USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_admin()
);
CREATE POLICY smartmatch_application_events_own_read
ON smartmatch_application_events
FOR SELECT TO app_runtime
USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND caregiver_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND app_smartmatch_is_active_worker()
);
GRANT SELECT ON smartmatch_application_events TO app_runtime;

-- The trigger takes nothing from the caller except the row being written;
-- the actor comes only from the authenticated session.
CREATE OR REPLACE FUNCTION public.app_smartmatch_record_application_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.smartmatch_application_events (
    organization_id, application_id, opportunity_id, caregiver_user_id,
    actor_user_id, event_type, previous_status, new_status,
    decision_reason, decision_checks, consent_version
  ) VALUES (
    NEW.organization_id, NEW.id, NEW.opportunity_id, NEW.caregiver_user_id,
    NULLIF(current_setting('app.current_user_id', true), '')::uuid,
    CASE WHEN TG_OP = 'INSERT' THEN 'SUBMITTED' ELSE NEW.status END,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
    NEW.status, NEW.decision_reason, NEW.decision_checks, NEW.consent_version
  );
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.app_smartmatch_record_application_event() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_smartmatch_application_event ON smartmatch_applications;
CREATE TRIGGER trg_smartmatch_application_event
  AFTER INSERT OR UPDATE OF status ON smartmatch_applications
  FOR EACH ROW EXECUTE FUNCTION public.app_smartmatch_record_application_event();

-- History is immutable for everyone, including the table owner path used by
-- the trigger (it only ever INSERTs).
CREATE OR REPLACE FUNCTION public.app_smartmatch_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'SMARTMATCH_EVENTS_APPEND_ONLY' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_smartmatch_events_immutable ON smartmatch_application_events;
CREATE TRIGGER trg_smartmatch_events_immutable
  BEFORE UPDATE OR DELETE ON smartmatch_application_events
  FOR EACH ROW EXECUTE FUNCTION public.app_smartmatch_events_immutable();

-- 4. Opportunity policy split ----------------------------------------------
-- The FOR ALL policy (092, kept in 095) required created_by_user_id = the
-- session user in WITH CHECK for every command, so an administrator other
-- than the creator could not mark an opportunity FILLED when approving.
-- "Created by me" now applies to INSERT only. created_by_user_id and
-- organization_id are no longer updatable at all (column privileges).
DROP POLICY IF EXISTS smartmatch_opportunities_agency_admin ON smartmatch_opportunities;
CREATE POLICY smartmatch_opportunities_agency_admin_read
ON smartmatch_opportunities
FOR SELECT TO app_runtime
USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_admin()
);
CREATE POLICY smartmatch_opportunities_agency_admin_insert
ON smartmatch_opportunities
FOR INSERT TO app_runtime
WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND created_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND app_is_org_admin()
);
CREATE POLICY smartmatch_opportunities_agency_admin_update
ON smartmatch_opportunities
FOR UPDATE TO app_runtime
USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_admin()
)
WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_admin()
);
REVOKE UPDATE ON smartmatch_opportunities FROM app_runtime;
GRANT UPDATE (status, visibility, region_label, role_label, starts_at, ends_at, expires_at, updated_at)
  ON smartmatch_opportunities TO app_runtime;
