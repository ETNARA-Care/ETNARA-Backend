-- Migration 109: SmartMatch -- cancel a PUBLISHED opportunity, automatic
-- expiry, and an auditable opportunity history.
--
--   * An agency administrator may cancel a PUBLISHED opportunity with a
--     mandatory reason category (optional internal note, never sent).
--   * A PUBLISHED opportunity whose start (or optional expires_at) has passed
--     is closed automatically as EXPIRED by the API's background worker.
--   * In both cases every PENDING application is closed with the new status
--     CLOSED (closed_reason OPPORTUNITY_CANCELLED | OPPORTUNITY_EXPIRED): it is
--     not an agency decision about the person, so it is not REJECTED.
--     Each affected caregiver gets exactly one notification (unique index,
--     098), carrying only the application id.
--   * Race safety: closing locks the opportunity row FOR UPDATE, which
--     conflicts with the KEY SHARE lock a concurrent submission takes through
--     its FK, so a submission either lands before (and is closed here) or is
--     refused at COMMIT by the deferred open-check (096).
--   * Every status change of an opportunity is written to an append-only
--     history with actor (NULL = automatic), reason and closed applications.

-- ------------------------------------------------------------ applications: CLOSED
ALTER TABLE smartmatch_applications
  ADD COLUMN IF NOT EXISTS closed_reason text NULL
    CHECK (closed_reason IS NULL OR closed_reason IN ('OPPORTUNITY_CANCELLED', 'OPPORTUNITY_EXPIRED')),
  ADD COLUMN IF NOT EXISTS closed_at timestamptz NULL;

ALTER TABLE smartmatch_applications DROP CONSTRAINT IF EXISTS smartmatch_applications_status_check;
ALTER TABLE smartmatch_applications ADD CONSTRAINT smartmatch_applications_status_check
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CLOSED'));
ALTER TABLE smartmatch_applications DROP CONSTRAINT IF EXISTS smartmatch_decision_consistency;
ALTER TABLE smartmatch_applications ADD CONSTRAINT smartmatch_decision_consistency
  CHECK (
    (status IN ('PENDING', 'WITHDRAWN', 'CLOSED') AND decided_by_user_id IS NULL AND decided_at IS NULL)
    OR
    (status IN ('APPROVED', 'REJECTED') AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
  );
ALTER TABLE smartmatch_applications DROP CONSTRAINT IF EXISTS smartmatch_application_closed_consistency;
ALTER TABLE smartmatch_applications ADD CONSTRAINT smartmatch_application_closed_consistency
  CHECK ((status = 'CLOSED') = (closed_reason IS NOT NULL AND closed_at IS NOT NULL));

ALTER TABLE smartmatch_application_events DROP CONSTRAINT IF EXISTS smartmatch_application_events_event_type_check;
ALTER TABLE smartmatch_application_events ADD CONSTRAINT smartmatch_application_events_event_type_check
  CHECK (event_type IN ('SUBMITTED', 'WITHDRAWN', 'APPROVED', 'REJECTED', 'CLOSED'));

-- History row of a closure carries its reason in decision_reason.
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
    NEW.status, COALESCE(NEW.decision_reason, NEW.closed_reason), NEW.decision_checks, NEW.consent_version
  );
  RETURN NULL;
END;
$$;

-- Notifications (098) + the two closure notices for the caregiver.
CREATE OR REPLACE FUNCTION public.app_smartmatch_notify_on_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_type text;
BEGIN
  IF NEW.event_type = 'SUBMITTED' THEN
    INSERT INTO public.notifications (
      user_id, organization_id, notification_type, related_entity_type,
      related_entity_id, channel, status, sent_at
    )
    SELECT DISTINCT om.user_id, NEW.organization_id, 'SMARTMATCH_APPLICATION_SUBMITTED',
           'smartmatch_application', NEW.application_id, 'in_app', 'sent', now()
    FROM public.organization_memberships om
    JOIN public.user_roles ur
      ON ur.organization_membership_id = om.id
     AND ur.organization_id = om.organization_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE om.organization_id = NEW.organization_id
      AND om.status = 'active'
      AND r.code = 'ORGANIZATION_ADMIN'
      AND om.user_id <> NEW.caregiver_user_id
    ON CONFLICT (user_id, notification_type, related_entity_id)
      WHERE related_entity_type = 'smartmatch_application'
    DO NOTHING;
    RETURN NULL;
  END IF;

  -- Decided, withdrawn or closed: the administrators' request for action is resolved.
  UPDATE public.notifications
     SET read_at = now()
   WHERE related_entity_type = 'smartmatch_application'
     AND related_entity_id = NEW.application_id
     AND notification_type = 'SMARTMATCH_APPLICATION_SUBMITTED'
     AND read_at IS NULL;

  v_type := CASE
    WHEN NEW.event_type = 'APPROVED' THEN 'SMARTMATCH_APPLICATION_APPROVED'
    WHEN NEW.event_type = 'REJECTED' AND NEW.decision_reason = 'OPPORTUNITY_FILLED'
      THEN 'SMARTMATCH_APPLICATION_CLOSED'
    WHEN NEW.event_type = 'REJECTED' THEN 'SMARTMATCH_APPLICATION_REJECTED'
    WHEN NEW.event_type = 'CLOSED' AND NEW.decision_reason = 'OPPORTUNITY_CANCELLED'
      THEN 'SMARTMATCH_APPLICATION_OPPORTUNITY_CANCELLED'
    WHEN NEW.event_type = 'CLOSED' AND NEW.decision_reason = 'OPPORTUNITY_EXPIRED'
      THEN 'SMARTMATCH_APPLICATION_OPPORTUNITY_EXPIRED'
    ELSE NULL
  END;
  IF v_type IS NOT NULL THEN
    INSERT INTO public.notifications (
      user_id, organization_id, notification_type, related_entity_type,
      related_entity_id, channel, status, sent_at
    ) VALUES (
      NEW.caregiver_user_id, NEW.organization_id, v_type,
      'smartmatch_application', NEW.application_id, 'in_app', 'sent', now()
    )
    ON CONFLICT (user_id, notification_type, related_entity_id)
      WHERE related_entity_type = 'smartmatch_application'
    DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

-- ------------------------------------------------------------ opportunities
ALTER TABLE smartmatch_opportunities ADD COLUMN IF NOT EXISTS expired_at timestamptz NULL;

-- 107's rules + PUBLISHED -> CANCELLED needs reason/actor/time like FILLED -> CANCELLED;
-- EXPIRED carries its time.
CREATE OR REPLACE FUNCTION public.app_smartmatch_opportunity_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT'     AND NEW.status IN ('PUBLISHED', 'CANCELLED'))
    OR (OLD.status = 'PUBLISHED' AND NEW.status IN ('FILLED', 'CANCELLED', 'EXPIRED'))
    OR (OLD.status = 'FILLED'    AND NEW.status = 'CANCELLED')
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
  IF OLD.status IN ('PUBLISHED', 'FILLED') AND NEW.status = 'CANCELLED' THEN
    IF NEW.cancellation_reason IS NULL OR NEW.cancelled_at IS NULL OR NEW.cancelled_by_user_id IS NULL THEN
      RAISE EXCEPTION 'SMARTMATCH_CANCELLATION_REASON_REQUIRED' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'FILLED' AND NEW.status = 'CANCELLED' THEN
    IF NEW.shift_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.shifts s WHERE s.id = NEW.shift_id AND s.status <> 'cancelled'
        AND (s.status IN ('in_progress', 'completed')
             OR EXISTS (SELECT 1 FROM public.assignments a WHERE a.shift_id = s.id AND a.organization_id = s.organization_id
                        AND a.response_status IN ('pending', 'accepted')))
    ) THEN
      RAISE EXCEPTION 'SMARTMATCH_LINKED_SHIFT_ACTIVE' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'EXPIRED' AND OLD.status = 'PUBLISHED' AND NEW.expired_at IS NULL THEN
    NEW.expired_at := now();
  END IF;
  IF OLD.status = 'CANCELLED' AND (NEW.cancellation_reason, NEW.cancellation_note, NEW.cancelled_at, NEW.cancelled_by_user_id)
       IS DISTINCT FROM (OLD.cancellation_reason, OLD.cancellation_note, OLD.cancelled_at, OLD.cancelled_by_user_id) THEN
    RAISE EXCEPTION 'SMARTMATCH_CANCELLATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'EXPIRED' AND NEW.expired_at IS DISTINCT FROM OLD.expired_at THEN
    RAISE EXCEPTION 'SMARTMATCH_EXPIRY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------ opportunity history
CREATE TABLE IF NOT EXISTS smartmatch_opportunity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  opportunity_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('CREATED', 'PUBLISHED', 'FILLED', 'CANCELLED', 'EXPIRED')),
  previous_status text NULL,
  new_status text NOT NULL,
  actor_user_id uuid NULL REFERENCES users(id),           -- NULL: automatic (expiry)
  reason text NULL,                                        -- cancellation category
  closed_applications integer NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_smartmatch_opportunity_events_opp
  ON smartmatch_opportunity_events (opportunity_id, occurred_at);
ALTER TABLE smartmatch_opportunity_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS smartmatch_opportunity_events_agency_read ON smartmatch_opportunity_events;
CREATE POLICY smartmatch_opportunity_events_agency_read
ON smartmatch_opportunity_events
FOR SELECT TO app_runtime
USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_admin()
);
DROP POLICY IF EXISTS platform_phi_deny ON smartmatch_opportunity_events;
CREATE POLICY platform_phi_deny ON smartmatch_opportunity_events
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());
GRANT SELECT ON smartmatch_opportunity_events TO app_runtime;

DROP TRIGGER IF EXISTS trg_smartmatch_opportunity_events_immutable ON smartmatch_opportunity_events;
CREATE TRIGGER trg_smartmatch_opportunity_events_immutable
  BEFORE UPDATE OR DELETE ON smartmatch_opportunity_events
  FOR EACH ROW EXECUTE FUNCTION public.app_smartmatch_events_immutable();

-- One place for every status change: close pending applications when a
-- PUBLISHED opportunity is cancelled or expires, then record the history row.
CREATE OR REPLACE FUNCTION public.app_smartmatch_opportunity_status_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_closed integer := 0;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'PUBLISHED' AND NEW.status IN ('CANCELLED', 'EXPIRED') THEN
    -- FOR UPDATE waits for any submission holding the FK's KEY SHARE lock, so
    -- its application is visible to the next statement and gets closed too.
    PERFORM 1 FROM public.smartmatch_opportunities WHERE id = NEW.id FOR UPDATE;
    UPDATE public.smartmatch_applications
       SET status = 'CLOSED',
           closed_reason = CASE WHEN NEW.status = 'CANCELLED' THEN 'OPPORTUNITY_CANCELLED' ELSE 'OPPORTUNITY_EXPIRED' END,
           closed_at = now()
     WHERE opportunity_id = NEW.id AND organization_id = NEW.organization_id AND status = 'PENDING';
    GET DIAGNOSTICS v_closed = ROW_COUNT;
  END IF;
  INSERT INTO public.smartmatch_opportunity_events (
    organization_id, opportunity_id, event_type, previous_status, new_status,
    actor_user_id, reason, closed_applications
  ) VALUES (
    NEW.organization_id, NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN 'CREATED' ELSE NEW.status END,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
    NEW.status,
    NULLIF(current_setting('app.current_user_id', true), '')::uuid,
    CASE WHEN NEW.status = 'CANCELLED' THEN NEW.cancellation_reason END,
    v_closed
  );
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.app_smartmatch_opportunity_status_changed() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_smartmatch_opportunity_status_changed ON smartmatch_opportunities;
CREATE TRIGGER trg_smartmatch_opportunity_status_changed
  AFTER INSERT OR UPDATE OF status ON smartmatch_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.app_smartmatch_opportunity_status_changed();

-- ------------------------------------------------------------ expiry job
-- Run by the API's background worker (no tenant context) every minute.
-- SKIP LOCKED: an opportunity being decided right now is retried next tick;
-- after an approval it is FILLED and no longer matches.
CREATE OR REPLACE FUNCTION public.app_smartmatch_expire_opportunities()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  total integer := 0;
  r record;
BEGIN
  PERFORM public.app_assert_background_job();
  FOR r IN
    SELECT o.id FROM public.smartmatch_opportunities o
    WHERE o.status = 'PUBLISHED'
      AND (o.starts_at <= now() OR (o.expires_at IS NOT NULL AND o.expires_at <= now()))
    ORDER BY o.starts_at
    LIMIT 500
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.smartmatch_opportunities SET status = 'EXPIRED', expired_at = now(), updated_at = now()
     WHERE id = r.id AND status = 'PUBLISHED';
    total := total + 1;
  END LOOP;
  RETURN total;
END;
$$;
REVOKE ALL ON FUNCTION public.app_smartmatch_expire_opportunities() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_smartmatch_expire_opportunities() TO app_runtime;
CREATE INDEX IF NOT EXISTS idx_smartmatch_opportunities_published_start
  ON smartmatch_opportunities (starts_at) WHERE status = 'PUBLISHED';
