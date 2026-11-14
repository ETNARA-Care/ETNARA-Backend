-- Migration 154 — Centro operacional: resolución legítima de pendientes («Requiere atención»).
--
-- Additive. No existing row is rewritten, no history is deleted, no shift status changes.
-- (151–153 are reserved by open PRs #259/#261/#262; 154 is the next free number.)
--
-- 1. Activation marker. The moment this migration is applied is the activation of the
--    feature. Shifts that ended before it keep the old 7-day window in the operations
--    center (no flood of old history); shifts that end after it stay until a legitimate
--    resolution (no silent expiry).
-- 2. Shifts that ended without service: shift_attention_closures, one immutable row per
--    shift (who, when, outcome, reason, mandatory note). The shift row is NOT touched: its
--    status, assignments and history stay exactly as they were. A closure made by mistake is
--    RECTIFIED, never deleted: an ORGANIZATION_ADMIN adds, once, who/when/why to the same row
--    (app_rectify_shift_closure); the original stays readable and the shift becomes pending
--    again (it may then be closed again or corrected). Written only through
--    app_close_shift_without_service() (SECURITY DEFINER): org manager, same tenant, shift
--    already ended, still unassigned/confirmed, no check-in, not closed before. A closure is
--    never a service: it creates no verification event and no timesheet, so nothing becomes
--    billable (billing requires approved hours).
-- 3. Evidence of service: a shift may only become in_progress/completed when a real check-in
--    exists (app_shift_update_guard, 107 + this rule). Closes the manual PATCH hole that let a
--    manager mark an uncovered shift «completed».
-- 4. Exceptional correction of an omitted check-in keeps using verification_overrides (010/028):
--    events labelled SUPERVISOR_OVERRIDE with the real time of the correction and a reason.
--    Every override is now also written to audit_log. A check-in that arrives after a closure
--    (e.g. an offline check-in made in time) is real evidence and is kept; the contradiction is
--    audited for the agency to review.
-- 5. Incidents: resolved_by_user_id / resolved_at; resolved is final; the story (severity,
--    description, reporter, recipient, created_at) is immutable; incidents are never deleted.
--    Serious incidents (severity high/alta/grave/crítica…) need documented follow-up (state
--    «en seguimiento» + at least one follow-up note of 20+ characters), a resolution of 30+
--    characters, and a closer authorized by the agency: an ORGANIZATION_ADMIN, or a SUPERVISOR
--    expressly authorized by an admin (incident_closure_authorizers, 126 pattern). Other
--    incidents: an org manager and a resolution of 10+ characters. Every status change is
--    written to audit_log.
-- 6. Grants are explicit (066 lesson). ETNARA central is denied by platform_phi_deny (078).

-- 1. Activation marker ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operational_pending_activation (
  singleton     boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  activated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO operational_pending_activation (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION app_operational_pending_activation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'OPERATIONAL_ACTIVATION_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS operational_pending_activation_guard ON operational_pending_activation;
CREATE TRIGGER operational_pending_activation_guard BEFORE UPDATE OR DELETE ON operational_pending_activation
  FOR EACH ROW EXECUTE FUNCTION app_operational_pending_activation_guard();

ALTER TABLE operational_pending_activation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operational_pending_activation_read ON operational_pending_activation;
CREATE POLICY operational_pending_activation_read ON operational_pending_activation FOR SELECT TO app_runtime USING (true);

-- 2. Shifts closed without service -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shift_attention_closures (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  shift_id           uuid NOT NULL,
  outcome            text NOT NULL CHECK (outcome IN ('not_covered', 'not_performed')),
  reason_code        text NOT NULL CHECK (reason_code IN (
                       'no_caregiver_available', 'family_cancelled', 'recipient_absent_or_hospitalized',
                       'caregiver_no_show', 'other')),
  note               text NOT NULL CHECK (length(btrim(note)) BETWEEN 10 AND 2000),
  closed_by_user_id  uuid NOT NULL REFERENCES users(id),
  closed_at          timestamptz NOT NULL DEFAULT now(),
  -- Rectification of a closure made by mistake: set once, never cleared; the row is never deleted.
  rectified_at          timestamptz NULL,
  rectified_by_user_id  uuid NULL REFERENCES users(id),
  rectification_reason  text NULL,
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id),
  CONSTRAINT shift_attention_closures_rectification_complete CHECK (
    (rectified_at IS NULL AND rectified_by_user_id IS NULL AND rectification_reason IS NULL)
    OR (rectified_at IS NOT NULL AND rectified_by_user_id IS NOT NULL
        AND length(btrim(rectification_reason)) BETWEEN 20 AND 2000)),
  CONSTRAINT shift_attention_closures_other_explained CHECK (reason_code <> 'other' OR length(btrim(note)) >= 20),
  CONSTRAINT shift_attention_closures_reason_fits CHECK (
    (outcome = 'not_covered' AND reason_code <> 'caregiver_no_show')
    OR (outcome = 'not_performed' AND reason_code <> 'no_caregiver_available'))
);
CREATE INDEX IF NOT EXISTS idx_shift_attention_closures_org_closed
  ON shift_attention_closures (organization_id, closed_at DESC);
-- At most one ACTIVE (not rectified) closure per shift; rectified ones stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS shift_attention_closures_one_active
  ON shift_attention_closures (shift_id) WHERE rectified_at IS NULL;

-- A closure is part of the permanent record: never deleted, its content never edited (owner
-- included). The only change ever allowed is adding the rectification, once.
CREATE OR REPLACE FUNCTION app_shift_attention_closures_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SHIFT_CLOSURE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.rectified_at IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.shift_id IS DISTINCT FROM OLD.shift_id OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.closed_by_user_id IS DISTINCT FROM OLD.closed_by_user_id OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
     OR NEW.rectified_at IS NULL THEN
    RAISE EXCEPTION 'SHIFT_CLOSURE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS shift_attention_closures_guard ON shift_attention_closures;
CREATE TRIGGER shift_attention_closures_guard BEFORE UPDATE OR DELETE ON shift_attention_closures
  FOR EACH ROW EXECUTE FUNCTION app_shift_attention_closures_guard();

/** Any check-in recorded for the shift (own tenant when a request context is set). */
CREATE OR REPLACE FUNCTION app_shift_has_check_in(p_shift_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.verification_events ve
    WHERE ve.shift_id = p_shift_id AND ve.event_type = 'check_in'
      AND (NULLIF(current_setting('app.current_org_id', true), '') IS NULL
           OR ve.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
$$;

CREATE OR REPLACE FUNCTION app_close_shift_without_service(p_shift_id uuid, p_reason_code text, p_note text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_shift record;
  v_accepted boolean;
  v_outcome text;
  v_note text := btrim(coalesce(p_note, ''));
  v_id uuid;
BEGIN
  IF v_user IS NULL OR v_org IS NULL OR NOT app_is_org_manager() THEN
    RAISE EXCEPTION 'SHIFT_CLOSURE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT id, status, scheduled_end INTO v_shift
    FROM shifts WHERE id = p_shift_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHIFT_CLOSURE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_shift.scheduled_end > now() THEN RAISE EXCEPTION 'SHIFT_CLOSURE_NOT_ENDED' USING ERRCODE = '23514'; END IF;
  IF v_shift.status NOT IN ('unassigned', 'confirmed') THEN
    RAISE EXCEPTION 'SHIFT_CLOSURE_NOT_CLOSABLE' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM verification_events WHERE shift_id = p_shift_id AND organization_id = v_org AND event_type = 'check_in') THEN
    RAISE EXCEPTION 'SHIFT_CLOSURE_HAS_CHECK_IN' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM shift_attention_closures WHERE shift_id = p_shift_id AND rectified_at IS NULL) THEN
    RAISE EXCEPTION 'SHIFT_CLOSURE_ALREADY_CLOSED' USING ERRCODE = '23505';
  END IF;
  v_accepted := EXISTS (SELECT 1 FROM assignments
    WHERE shift_id = p_shift_id AND organization_id = v_org AND response_status = 'accepted');
  v_outcome := CASE WHEN v_accepted THEN 'not_performed' ELSE 'not_covered' END;
  IF p_reason_code IS NULL OR p_reason_code NOT IN ('no_caregiver_available', 'family_cancelled',
       'recipient_absent_or_hospitalized', 'caregiver_no_show', 'other')
     OR (v_outcome = 'not_covered' AND p_reason_code = 'caregiver_no_show')
     OR (v_outcome = 'not_performed' AND p_reason_code = 'no_caregiver_available') THEN
    RAISE EXCEPTION 'SHIFT_CLOSURE_REASON_INVALID' USING ERRCODE = '22023';
  END IF;
  IF length(v_note) < (CASE WHEN p_reason_code = 'other' THEN 20 ELSE 10 END) OR length(v_note) > 2000 THEN
    RAISE EXCEPTION 'SHIFT_CLOSURE_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  INSERT INTO shift_attention_closures (organization_id, shift_id, outcome, reason_code, note, closed_by_user_id)
  VALUES (v_org, p_shift_id, v_outcome, p_reason_code, v_note, v_user)
  RETURNING id INTO v_id;

  -- The note may describe the person; audit_log keeps the decision, not the text.
  INSERT INTO audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, previous_value, new_value)
  VALUES (v_user, v_org, v_org, 'SHIFT_CLOSED_WITHOUT_SERVICE', 'shift', p_shift_id,
          jsonb_build_object('status', v_shift.status),
          jsonb_build_object('closureId', v_id, 'outcome', v_outcome, 'reasonCode', p_reason_code));
  RETURN v_id;
END;
$$;

/** Rectify a closure made by mistake (ORGANIZATION_ADMIN only): the original stays, audited. */
CREATE OR REPLACE FUNCTION app_rectify_shift_closure(p_closure_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_closure record;
BEGIN
  IF v_user IS NULL OR v_org IS NULL OR NOT app_is_org_admin() THEN
    RAISE EXCEPTION 'SHIFT_CLOSURE_RECTIFY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT id, shift_id, outcome, reason_code, rectified_at INTO v_closure
    FROM shift_attention_closures WHERE id = p_closure_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHIFT_CLOSURE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_closure.rectified_at IS NOT NULL THEN
    RAISE EXCEPTION 'SHIFT_CLOSURE_ALREADY_RECTIFIED' USING ERRCODE = '23514';
  END IF;
  IF length(v_reason) < 20 OR length(v_reason) > 2000 THEN
    RAISE EXCEPTION 'SHIFT_CLOSURE_RECTIFY_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;
  UPDATE shift_attention_closures
     SET rectified_at = now(), rectified_by_user_id = v_user, rectification_reason = v_reason
   WHERE id = p_closure_id;
  INSERT INTO audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, previous_value, new_value)
  VALUES (v_user, v_org, v_org, 'SHIFT_CLOSURE_RECTIFIED', 'shift', v_closure.shift_id,
          jsonb_build_object('closureId', p_closure_id, 'outcome', v_closure.outcome, 'reasonCode', v_closure.reason_code),
          jsonb_build_object('closureId', p_closure_id, 'rectified', true));
  RETURN p_closure_id;
END;
$$;

ALTER TABLE shift_attention_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_attention_closures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shift_attention_closures_manager_read ON shift_attention_closures;
CREATE POLICY shift_attention_closures_manager_read ON shift_attention_closures FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
DROP POLICY IF EXISTS platform_phi_deny ON shift_attention_closures;
CREATE POLICY platform_phi_deny ON shift_attention_closures AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());

-- 3. Shift status needs evidence of service ----------------------------------------------------
-- Body of 107 unchanged, plus: in_progress / completed only with a real check-in.
CREATE OR REPLACE FUNCTION app_shift_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Status: a cancelled shift never comes back (it could revive a cancelled
  -- SmartMatch link, journey and alerts); a completed one only re-opens through a
  -- check-in (several caregivers on one shift).
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'SHIFT_STATUS_CANCELLED_IS_FINAL' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'completed' AND NEW.status NOT IN ('in_progress', 'cancelled') THEN
      RAISE EXCEPTION 'SHIFT_STATUS_COMPLETED_IS_FINAL' USING ERRCODE = '23514';
    END IF;
    -- 154: a shift is only «en curso» or «completado» with a real check-in. A closure without
    -- service never counts as a service.
    IF NEW.status IN ('in_progress', 'completed') AND NOT public.app_shift_has_check_in(OLD.id) THEN
      RAISE EXCEPTION 'SHIFT_STATUS_REQUIRES_CHECK_IN' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Non-managers (caregivers) may only change the status.
  IF current_user = 'app_runtime' AND NOT public.app_is_org_manager() AND (
       NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id
    OR NEW.room_id IS DISTINCT FROM OLD.room_id
    OR NEW.service_location_id IS DISTINCT FROM OLD.service_location_id
    OR NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start
    OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end
    OR NEW.required_role IS DISTINCT FROM OLD.required_role
    OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'SHIFT_FIELDS_LOCKED' USING ERRCODE = '42501';
  END IF;
  -- Once the caregiver declared the departure or arrived, the visit cannot be
  -- moved (a stale «En camino» would be shown and alerts suppressed): cancel it
  -- and create a new one instead.
  IF (NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end)
     AND (EXISTS (SELECT 1 FROM public.shift_journey_events e WHERE e.shift_id = OLD.id)
          OR EXISTS (SELECT 1 FROM public.shift_arrivals a WHERE a.shift_id = OLD.id)) THEN
    RAISE EXCEPTION 'SHIFT_SCHEDULE_LOCKED' USING ERRCODE = '23514';
  END IF;
  -- 154: the schedule of a shift closed without service is part of that record.
  IF (NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end)
     AND EXISTS (SELECT 1 FROM public.shift_attention_closures c WHERE c.shift_id = OLD.id AND c.rectified_at IS NULL) THEN
    RAISE EXCEPTION 'SHIFT_SCHEDULE_LOCKED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- 4. Audit of verification corrections and of evidence that contradicts a closure ----------------
CREATE OR REPLACE FUNCTION app_verification_override_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_event record;
BEGIN
  SELECT shift_id, event_type, organization_worker_membership_id, actor_context, occurred_at INTO v_event
    FROM verification_events WHERE id = NEW.verification_event_id;
  INSERT INTO audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
  VALUES (NEW.authorized_by_user_id, NEW.organization_id, NEW.organization_id, 'VERIFICATION_OVERRIDE_RECORDED', 'shift', v_event.shift_id,
          jsonb_build_object('overrideId', NEW.id, 'verificationEventId', NEW.verification_event_id,
                             'eventType', v_event.event_type, 'membershipId', v_event.organization_worker_membership_id,
                             'context', v_event.actor_context, 'recordedAt', v_event.occurred_at));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS verification_overrides_audit ON verification_overrides;
CREATE TRIGGER verification_overrides_audit AFTER INSERT ON verification_overrides
  FOR EACH ROW EXECUTE FUNCTION app_verification_override_audit();

CREATE OR REPLACE FUNCTION app_check_in_after_closure_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_closure uuid;
BEGIN
  IF NEW.event_type = 'check_in' THEN
    SELECT id INTO v_closure FROM shift_attention_closures WHERE shift_id = NEW.shift_id AND rectified_at IS NULL;
    IF v_closure IS NOT NULL THEN
      INSERT INTO audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
      VALUES (NEW.actor_user_id, NEW.organization_id, NEW.organization_id, 'SHIFT_CLOSURE_CONTRADICTED_BY_CHECK_IN', 'shift', NEW.shift_id,
              jsonb_build_object('closureId', v_closure, 'verificationEventId', NEW.id));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS verification_events_closure_audit ON verification_events;
CREATE TRIGGER verification_events_closure_audit AFTER INSERT ON verification_events
  FOR EACH ROW EXECUTE FUNCTION app_check_in_after_closure_audit();

-- 5. Incidents ------------------------------------------------------------------------------------
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolved_by_user_id uuid NULL REFERENCES users(id);
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolved_at timestamptz NULL;

CREATE OR REPLACE FUNCTION app_incident_is_serious(p_severity text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT lower(btrim(coalesce(p_severity, ''))) IN ('high', 'alta', 'grave', 'critical', 'critica', 'crítica', 'severe', 'severa');
$$;

-- Who may close serious incidents: admins always; supervisors only when an admin authorized them.
CREATE TABLE IF NOT EXISTS incident_closure_authorizers (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id),
  organization_membership_id  uuid NOT NULL REFERENCES organization_memberships(id),
  granted_by_user_id          uuid NOT NULL REFERENCES users(id),
  granted_at                  timestamptz NOT NULL DEFAULT now(),
  revoked_by_user_id          uuid NULL REFERENCES users(id),
  revoked_at                  timestamptz NULL,
  CONSTRAINT incident_closure_authorizers_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS incident_closure_authorizers_one_active
  ON incident_closure_authorizers (organization_membership_id) WHERE revoked_at IS NULL;

-- A grant is never edited or deleted, only revoked once (owner included).
CREATE OR REPLACE FUNCTION app_incident_closure_authorizers_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'INCIDENT_CLOSER_NOT_DELETABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     OR NEW.organization_id <> OLD.organization_id OR NEW.organization_membership_id <> OLD.organization_membership_id
     OR NEW.granted_by_user_id <> OLD.granted_by_user_id OR NEW.granted_at <> OLD.granted_at
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'INCIDENT_CLOSER_REVOKE_ONLY' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS incident_closure_authorizers_guard ON incident_closure_authorizers;
CREATE TRIGGER incident_closure_authorizers_guard BEFORE UPDATE OR DELETE ON incident_closure_authorizers
  FOR EACH ROW EXECUTE FUNCTION app_incident_closure_authorizers_guard();

CREATE OR REPLACE FUNCTION app_incident_closure_authorizers_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
  VALUES (CASE WHEN TG_OP = 'INSERT' THEN NEW.granted_by_user_id ELSE NEW.revoked_by_user_id END,
          NEW.organization_id, NEW.organization_id,
          CASE WHEN TG_OP = 'INSERT' THEN 'INCIDENT_CLOSER_GRANTED' ELSE 'INCIDENT_CLOSER_REVOKED' END,
          'organization_membership', NEW.organization_membership_id, jsonb_build_object('grantId', NEW.id));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS incident_closure_authorizers_audit ON incident_closure_authorizers;
CREATE TRIGGER incident_closure_authorizers_audit AFTER INSERT OR UPDATE ON incident_closure_authorizers
  FOR EACH ROW EXECUTE FUNCTION app_incident_closure_authorizers_audit();

/** Current user may close serious incidents of the current organization. */
CREATE OR REPLACE FUNCTION app_can_close_serious_incidents()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND om.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND om.status = 'active'
      AND (r.code = 'ORGANIZATION_ADMIN'
           OR (r.code = 'SUPERVISOR' AND EXISTS (
                 SELECT 1 FROM public.incident_closure_authorizers g
                 WHERE g.organization_membership_id = om.id AND g.organization_id = om.organization_id
                   AND g.revoked_at IS NULL)))
  );
$$;

/** Documented follow-up: at least one authored follow-up note of 20+ characters. */
CREATE OR REPLACE FUNCTION app_incident_has_documented_follow_up(p_incident_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.incident_timeline_entries e
    WHERE e.incident_id = p_incident_id AND e.created_by_user_id IS NOT NULL
      AND length(btrim(e.entry_text)) >= 20);
$$;

CREATE OR REPLACE FUNCTION app_incident_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'INCIDENT_NOT_DELETABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- From the app, an incident is always born open; a resolution is a later, audited act.
    IF v_user IS NOT NULL AND (NEW.status <> 'open' OR NEW.resolved_by_user_id IS NOT NULL OR NEW.resolved_at IS NOT NULL) THEN
      RAISE EXCEPTION 'INCIDENT_MUST_START_OPEN' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'INCIDENT_RESOLVED_IS_FINAL' USING ERRCODE = '23514';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id
     OR NEW.organization_worker_membership_id IS DISTINCT FROM OLD.organization_worker_membership_id
     OR NEW.escalated_from_observation_id IS DISTINCT FROM OLD.escalated_from_observation_id
     OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'INCIDENT_RECORD_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- Workflow transitions are supervision acts (the API already requires a manager; RLS
    -- would also let an assigned caregiver write the row).
    IF v_user IS NOT NULL AND NOT public.app_is_org_manager() THEN
      RAISE EXCEPTION 'INCIDENT_STATUS_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NOT ((OLD.status = 'open' AND NEW.status IN ('in_progress', 'resolved'))
            OR (OLD.status = 'in_progress' AND NEW.status = 'resolved')) THEN
      RAISE EXCEPTION 'INCIDENT_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'resolved' THEN
    IF NEW.resolved_by_user_id IS NULL OR NEW.resolved_at IS NULL
       OR (v_user IS NOT NULL AND NEW.resolved_by_user_id IS DISTINCT FROM v_user) THEN
      RAISE EXCEPTION 'INCIDENT_RESOLUTION_UNATTRIBUTED' USING ERRCODE = '23514';
    END IF;
    IF public.app_incident_is_serious(OLD.severity) THEN
      IF NOT public.app_can_close_serious_incidents() THEN
        RAISE EXCEPTION 'INCIDENT_SERIOUS_CLOSER_REQUIRED' USING ERRCODE = '42501';
      END IF;
      IF OLD.status <> 'in_progress' OR NOT public.app_incident_has_documented_follow_up(OLD.id) THEN
        RAISE EXCEPTION 'INCIDENT_SERIOUS_FOLLOW_UP_REQUIRED' USING ERRCODE = '23514';
      END IF;
      IF length(btrim(coalesce(NEW.resolution, ''))) < 30 THEN
        RAISE EXCEPTION 'INCIDENT_RESOLUTION_TOO_SHORT' USING ERRCODE = '23514';
      END IF;
    ELSIF length(btrim(coalesce(NEW.resolution, ''))) < 10 THEN
      RAISE EXCEPTION 'INCIDENT_RESOLUTION_TOO_SHORT' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.resolved_by_user_id IS NOT NULL OR NEW.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'INCIDENT_RESOLUTION_UNATTRIBUTED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS incidents_guard ON incidents;
CREATE TRIGGER incidents_guard BEFORE INSERT OR UPDATE OR DELETE ON incidents
  FOR EACH ROW EXECUTE FUNCTION app_incident_guard();

CREATE OR REPLACE FUNCTION app_incident_status_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, previous_value, new_value)
    VALUES (NULLIF(current_setting('app.current_user_id', true), '')::uuid, NEW.organization_id, NEW.organization_id,
            CASE WHEN NEW.status = 'resolved' THEN 'INCIDENT_RESOLVED' ELSE 'INCIDENT_FOLLOW_UP_STARTED' END,
            'incident', NEW.id,
            jsonb_build_object('status', OLD.status),
            jsonb_build_object('status', NEW.status, 'serious', app_incident_is_serious(NEW.severity)));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS incidents_status_audit ON incidents;
CREATE TRIGGER incidents_status_audit AFTER UPDATE OF status ON incidents
  FOR EACH ROW EXECUTE FUNCTION app_incident_status_audit();

ALTER TABLE incident_closure_authorizers ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_closure_authorizers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_closure_authorizers_manager_read ON incident_closure_authorizers;
CREATE POLICY incident_closure_authorizers_manager_read ON incident_closure_authorizers FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
DROP POLICY IF EXISTS incident_closure_authorizers_admin_write ON incident_closure_authorizers;
CREATE POLICY incident_closure_authorizers_admin_write ON incident_closure_authorizers FOR INSERT TO app_runtime
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_admin()
              AND granted_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND EXISTS (SELECT 1 FROM organization_memberships om
                          WHERE om.id = incident_closure_authorizers.organization_membership_id
                            AND om.organization_id = incident_closure_authorizers.organization_id));
DROP POLICY IF EXISTS incident_closure_authorizers_admin_revoke ON incident_closure_authorizers;
CREATE POLICY incident_closure_authorizers_admin_revoke ON incident_closure_authorizers FOR UPDATE TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_admin())
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_admin()
              AND revoked_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
DROP POLICY IF EXISTS platform_phi_deny ON incident_closure_authorizers;
CREATE POLICY platform_phi_deny ON incident_closure_authorizers AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());

-- 6. Grants --------------------------------------------------------------------------------------
REVOKE ALL ON operational_pending_activation, shift_attention_closures, incident_closure_authorizers FROM PUBLIC;
GRANT SELECT ON operational_pending_activation TO app_runtime;
GRANT SELECT ON shift_attention_closures TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON incident_closure_authorizers TO app_runtime;
REVOKE ALL ON FUNCTION app_operational_pending_activation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_shift_attention_closures_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_shift_has_check_in(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_close_shift_without_service(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_rectify_shift_closure(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_verification_override_audit() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_check_in_after_closure_audit() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_incident_closure_authorizers_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_incident_closure_authorizers_audit() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_can_close_serious_incidents() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_incident_has_documented_follow_up(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_incident_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_incident_status_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_shift_has_check_in(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION app_close_shift_without_service(uuid, text, text) TO app_runtime;
GRANT EXECUTE ON FUNCTION app_rectify_shift_closure(uuid, text) TO app_runtime;
GRANT EXECUTE ON FUNCTION app_can_close_serious_incidents() TO app_runtime;
GRANT EXECUTE ON FUNCTION app_incident_has_documented_follow_up(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION app_incident_is_serious(text) TO app_runtime;
