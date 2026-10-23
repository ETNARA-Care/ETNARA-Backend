-- Migration 107: security & production-readiness audit (SmartMatch Gates 4-7).
-- Every change is additive or narrows access; no data is deleted. Findings are
-- referenced by the audit report ids (claude/smartmatch-audit-report.md).

-- ============================================================ A. users (CRITICAL, pre-existing 014)
-- users_self_or_shared_org was FOR ALL without WITH CHECK: any member of an agency
-- could UPDATE another member's email / phone / password_hash at DB level.
-- Reads unchanged; writes only on one's own row (the password-reset flow sets
-- app.current_user_id to the owner). User creation happens only inside SECURITY
-- DEFINER activation functions, so app_runtime needs no INSERT/DELETE.
DROP POLICY IF EXISTS users_self_or_shared_org ON users;
DROP POLICY IF EXISTS users_read_self_or_shared_org ON users;
DROP POLICY IF EXISTS users_update_self ON users;
CREATE POLICY users_read_self_or_shared_org ON users
  FOR SELECT
  USING (
    id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    OR EXISTS (
      SELECT 1 FROM organization_memberships om1
      JOIN organization_memberships om2 ON om1.organization_id = om2.organization_id
      WHERE om1.user_id = users.id
        AND om2.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        AND om1.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND om1.status = 'active' AND om2.status = 'active')
    OR app_is_superadmin()
  );
CREATE POLICY users_update_self ON users
  FOR UPDATE
  USING (id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
REVOKE INSERT, DELETE ON users FROM app_runtime;
REVOKE UPDATE ON users FROM app_runtime;
GRANT UPDATE (password_hash, updated_at) ON users TO app_runtime;

-- ============================================================ B. shifts (HIGH)
-- shifts_worker_assigned_only (018) was FOR ALL without WITH CHECK: an assigned
-- caregiver could, at DB level, move the shift's times (extending their access to
-- the person's address and record), re-point it to another person/address, or
-- delete it. Caregivers keep SELECT and the status changes check-in/out and
-- «Rechazar» need; everything else is for managers.
DROP POLICY IF EXISTS shifts_worker_assigned_only ON shifts;
DROP POLICY IF EXISTS shifts_worker_assigned_read ON shifts;
DROP POLICY IF EXISTS shifts_worker_assigned_status ON shifts;
CREATE POLICY shifts_worker_assigned_read ON shifts
  FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_worker_has_shift_assignment(id));
CREATE POLICY shifts_worker_assigned_status ON shifts
  FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_worker_has_shift_assignment(id))
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

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
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS shifts_update_guard ON shifts;
CREATE TRIGGER shifts_update_guard BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION app_shift_update_guard();

-- A cancelled shift or a rejected assignment closes the open «sin salida» /
-- late-arrival / delay alerts of that visit.
CREATE OR REPLACE FUNCTION app_close_journey_alerts(p_shift_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.notifications SET read_at = COALESCE(read_at, now())
  WHERE related_entity_type = 'shift' AND related_entity_id = p_shift_id AND read_at IS NULL
    AND notification_type IN ('SHIFT_NOT_EN_ROUTE', 'SHIFT_LATE_ARRIVAL', 'SHIFT_DELAY_REPORTED');
$$;
REVOKE ALL ON FUNCTION app_close_journey_alerts(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_shift_cancel_closes_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN PERFORM public.app_close_journey_alerts(NEW.id); END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_shift_cancel_closes_alerts() FROM PUBLIC;
DROP TRIGGER IF EXISTS shifts_close_journey_alerts ON shifts;
CREATE TRIGGER shifts_close_journey_alerts AFTER UPDATE OF status ON shifts
  FOR EACH ROW EXECUTE FUNCTION app_shift_cancel_closes_alerts();

CREATE OR REPLACE FUNCTION app_assignment_rejection_closes_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.response_status::text = 'rejected' AND OLD.response_status IS DISTINCT FROM NEW.response_status THEN
    PERFORM public.app_close_journey_alerts(NEW.shift_id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_assignment_rejection_closes_alerts() FROM PUBLIC;
DROP TRIGGER IF EXISTS assignments_close_journey_alerts ON assignments;
CREATE TRIGGER assignments_close_journey_alerts AFTER UPDATE OF response_status ON assignments
  FOR EACH ROW EXECUTE FUNCTION app_assignment_rejection_closes_alerts();

-- ============================================================ C. shift address pinning (MEDIUM M1)
-- Shifts without a stored address followed «the current primary», so changing the
-- primary silently moved them. Pin upcoming shifts to the address they use now,
-- and keep pinning whenever a primary is created or replaced.
UPDATE shifts s SET service_location_id = l.id
FROM care_recipient_locations l
WHERE s.service_location_id IS NULL AND s.care_recipient_id IS NOT NULL
  AND l.care_recipient_id = s.care_recipient_id AND l.organization_id = s.organization_id
  AND l.is_primary AND l.archived_at IS NULL
  AND s.status IN ('unassigned', 'confirmed', 'in_progress') AND s.scheduled_end > now();

CREATE OR REPLACE FUNCTION app_pin_shifts_to_primary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Primary being replaced: shifts that relied on it keep it.
  IF TG_OP = 'UPDATE' AND OLD.is_primary AND NOT NEW.is_primary THEN
    UPDATE public.shifts SET service_location_id = OLD.id, updated_at = now()
    WHERE care_recipient_id = OLD.care_recipient_id AND organization_id = OLD.organization_id
      AND service_location_id IS NULL AND status IN ('unassigned', 'confirmed', 'in_progress') AND scheduled_end > now();
  END IF;
  -- First primary of a person: shifts created before any address get it.
  IF NEW.is_primary AND NEW.archived_at IS NULL AND (TG_OP = 'INSERT' OR NOT OLD.is_primary) THEN
    UPDATE public.shifts SET service_location_id = NEW.id, updated_at = now()
    WHERE care_recipient_id = NEW.care_recipient_id AND organization_id = NEW.organization_id
      AND service_location_id IS NULL AND status IN ('unassigned', 'confirmed', 'in_progress') AND scheduled_end > now();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_pin_shifts_to_primary() FROM PUBLIC;
DROP TRIGGER IF EXISTS care_recipient_locations_pin_shifts ON care_recipient_locations;
CREATE TRIGGER care_recipient_locations_pin_shifts
  AFTER INSERT OR UPDATE OF is_primary ON care_recipient_locations
  FOR EACH ROW EXECUTE FUNCTION app_pin_shifts_to_primary();

-- A shift never points at an archived address (LOW L4, race with archive).
CREATE OR REPLACE FUNCTION app_shift_service_location_matches()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.service_location_id IS NOT NULL
     AND NEW.service_location_id IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.service_location_id END)
     AND NOT EXISTS (
       SELECT 1 FROM public.care_recipient_locations l
       WHERE l.id = NEW.service_location_id AND l.organization_id = NEW.organization_id
         AND l.care_recipient_id = NEW.care_recipient_id AND l.archived_at IS NULL
       FOR SHARE) THEN
    RAISE EXCEPTION 'SHIFT_SERVICE_LOCATION_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.service_location_id IS NOT NULL AND NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id
     AND NOT EXISTS (SELECT 1 FROM public.care_recipient_locations l WHERE l.id = NEW.service_location_id
                     AND l.care_recipient_id = NEW.care_recipient_id) THEN
    RAISE EXCEPTION 'SHIFT_SERVICE_LOCATION_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================ D. family relationships (MEDIUM)
-- Reads: a relative or caregiver saw every relationship in the agency. Now: own
-- row, managers, and people authorised for that same person (the caregiver who
-- serves them, co-relatives for shared conversations).
DROP POLICY IF EXISTS family_relationships_read ON family_relationships;
CREATE POLICY family_relationships_read ON family_relationships
  FOR SELECT
  USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
      user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      OR app_is_org_manager()
      OR app_user_authorized_for_recipient(NULLIF(current_setting('app.current_user_id', true), '')::uuid,
                                           organization_id, care_recipient_id)
    )
    OR app_is_superadmin()
  );
-- Inserts: the legacy self-insert path (104) trusted the invitee's e-mail and did
-- not consume the invitation; the product uses app_activate_access_invitation
-- (SECURITY DEFINER). Managers only.
DROP POLICY IF EXISTS family_relationships_insert ON family_relationships;
CREATE POLICY family_relationships_insert ON family_relationships
  FOR INSERT
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
REVOKE ALL ON FUNCTION app_family_invitation_allows_self_insert(uuid, uuid, uuid, text, boolean) FROM app_runtime;

-- ============================================================ E. ETNARA central / Tower (MEDIUM, LOW)
-- Tower read every agency's notifications (visit timelines per person). A
-- platform admin keeps only their own.
DROP POLICY IF EXISTS platform_phi_deny ON notifications;
CREATE POLICY platform_phi_deny ON notifications
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin() OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (NOT app_is_superadmin() OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['smartmatch_opportunities', 'smartmatch_applications', 'smartmatch_application_events', 'smartmatch_location_preferences'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS platform_phi_deny ON %I', t);
    EXECUTE format('CREATE POLICY platform_phi_deny ON %I AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin())', t);
  END LOOP;
END $$;

-- ============================================================ F. cross-agency jobs (LOW)
-- Only the API's background worker (no tenant context) may run them.
CREATE OR REPLACE FUNCTION app_assert_background_job()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NULLIF(current_setting('app.current_user_id', true), '') IS NOT NULL
     OR NULLIF(current_setting('app.current_org_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'BACKGROUND_JOB_ONLY' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app_notify_late_shift_arrivals()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  total integer := 0;
  late record;
BEGIN
  PERFORM public.app_assert_background_job();
  FOR late IN
    SELECT s.id, s.organization_id
    FROM public.shifts s
    WHERE s.status IN ('unassigned', 'confirmed')
      AND s.scheduled_start <= now() - interval '15 minutes'
      AND s.scheduled_start > now() - interval '12 hours'
      AND s.scheduled_end > now()
      AND EXISTS (SELECT 1 FROM public.assignments a WHERE a.shift_id = s.id AND a.organization_id = s.organization_id
                  AND a.response_status IN ('pending', 'accepted'))
      AND NOT EXISTS (SELECT 1 FROM public.shift_arrivals sa WHERE sa.shift_id = s.id AND sa.organization_id = s.organization_id)
      AND NOT EXISTS (SELECT 1 FROM public.verification_events ve WHERE ve.shift_id = s.id
                      AND ve.organization_id = s.organization_id AND ve.event_type = 'check_in')
      -- already notified: skip (LOW L8, no re-insert attempts every minute)
      AND NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.related_entity_id = s.id AND n.notification_type = 'SHIFT_LATE_ARRIVAL')
  LOOP
    total := total + public.app_notify_shift_managers(late.organization_id, late.id, 'SHIFT_LATE_ARRIVAL');
  END LOOP;
  RETURN total;
END;
$$;

CREATE OR REPLACE FUNCTION app_notify_shifts_not_en_route()
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
    SELECT s.id, s.organization_id
    FROM public.shifts s
    WHERE s.status = 'confirmed'
      AND s.scheduled_start <= now() + interval '30 minutes'
      AND s.scheduled_start > now()
      AND EXISTS (SELECT 1 FROM public.assignments a WHERE a.shift_id = s.id AND a.organization_id = s.organization_id
                  AND a.response_status IN ('pending', 'accepted'))
      AND NOT EXISTS (SELECT 1 FROM public.shift_journey_events e WHERE e.shift_id = s.id AND e.organization_id = s.organization_id
                      AND e.event_type = 'EN_ROUTE')
      AND NOT EXISTS (SELECT 1 FROM public.shift_arrivals sa WHERE sa.shift_id = s.id AND sa.organization_id = s.organization_id)
      AND NOT EXISTS (SELECT 1 FROM public.verification_events ve WHERE ve.shift_id = s.id
                      AND ve.organization_id = s.organization_id AND ve.event_type = 'check_in')
      AND NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.related_entity_id = s.id AND n.notification_type = 'SHIFT_NOT_EN_ROUTE')
  LOOP
    total := total + public.app_notify_shift_managers(r.organization_id, r.id, 'SHIFT_NOT_EN_ROUTE');
  END LOOP;
  RETURN total;
END;
$$;
CREATE INDEX IF NOT EXISTS idx_shifts_active_by_start ON shifts (scheduled_start) WHERE status IN ('unassigned', 'confirmed');
CREATE INDEX IF NOT EXISTS idx_notifications_entity_type ON notifications (related_entity_id, notification_type);

-- ============================================================ G. arrivals and access log
-- «Llegué» only around the visit (MEDIUM M3): from 2 h before the start to its end.
CREATE OR REPLACE FUNCTION app_shift_arrival_window()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE s record;
BEGIN
  SELECT scheduled_start, scheduled_end INTO s FROM public.shifts WHERE id = NEW.shift_id AND organization_id = NEW.organization_id;
  IF NOT FOUND OR NEW.occurred_at < s.scheduled_start - interval '2 hours' OR NEW.occurred_at > s.scheduled_end THEN
    RAISE EXCEPTION 'ARRIVAL_OUTSIDE_WINDOW' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_shift_arrival_window() FROM PUBLIC;
DROP TRIGGER IF EXISTS shift_arrivals_window ON shift_arrivals;
CREATE TRIGGER shift_arrivals_window BEFORE INSERT ON shift_arrivals
  FOR EACH ROW EXECUTE FUNCTION app_shift_arrival_window();

-- The access log only names an address the caregiver may read (LOW).
DROP POLICY IF EXISTS location_access_log_self_insert ON care_recipient_location_access_log;
CREATE POLICY location_access_log_self_insert ON care_recipient_location_access_log
  FOR INSERT TO app_runtime
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND app_worker_has_shift_assignment(shift_id)
    AND EXISTS (SELECT 1 FROM care_recipient_locations l WHERE l.id = location_id)
  );

-- ============================================================ H. history is append-only (LOW L7)
CREATE OR REPLACE FUNCTION app_history_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'HISTORY_APPEND_ONLY' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS care_recipient_location_events_append_only ON care_recipient_location_events;
CREATE TRIGGER care_recipient_location_events_append_only BEFORE UPDATE OR DELETE ON care_recipient_location_events
  FOR EACH ROW EXECUTE FUNCTION app_history_append_only();
DROP TRIGGER IF EXISTS shift_service_location_changes_append_only ON shift_service_location_changes;
CREATE TRIGGER shift_service_location_changes_append_only BEFORE UPDATE OR DELETE ON shift_service_location_changes
  FOR EACH ROW EXECUTE FUNCTION app_history_append_only();
DROP TRIGGER IF EXISTS shift_arrivals_no_delete ON shift_arrivals;
CREATE TRIGGER shift_arrivals_no_delete BEFORE DELETE ON shift_arrivals
  FOR EACH ROW EXECUTE FUNCTION app_history_append_only();

-- ============================================================ I. journey (LOW L2, MEDIUM M6)
-- Delay limits count only the current caregiver's own reports.
CREATE OR REPLACE FUNCTION app_shift_journey_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  s record;
  last_delay record;
  delays integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('journey:' || NEW.shift_id::text, 0));
  SELECT id, status::text AS status, scheduled_start, scheduled_end INTO s
  FROM public.shifts WHERE id = NEW.shift_id AND organization_id = NEW.organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOURNEY_SHIFT_NOT_FOUND' USING ERRCODE = '23514'; END IF;
  IF s.status <> 'confirmed' THEN RAISE EXCEPTION 'JOURNEY_SHIFT_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.assignments a WHERE a.shift_id = NEW.shift_id AND a.organization_id = NEW.organization_id
                 AND a.organization_worker_membership_id = NEW.organization_worker_membership_id AND a.response_status = 'accepted') THEN
    RAISE EXCEPTION 'JOURNEY_ASSIGNMENT_NOT_ACCEPTED' USING ERRCODE = '23514';
  END IF;
  IF NEW.occurred_at > now() + interval '1 minute' OR NEW.occurred_at < now() - interval '60 minutes' THEN
    RAISE EXCEPTION 'JOURNEY_TIME_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.occurred_at < s.scheduled_start - interval '2 hours' OR NEW.occurred_at > s.scheduled_start + interval '1 hour' THEN
    RAISE EXCEPTION 'JOURNEY_OUTSIDE_WINDOW' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.shift_arrivals sa WHERE sa.shift_id = NEW.shift_id AND sa.organization_id = NEW.organization_id)
     OR EXISTS (SELECT 1 FROM public.verification_events ve WHERE ve.shift_id = NEW.shift_id
                AND ve.organization_id = NEW.organization_id AND ve.event_type = 'check_in') THEN
    RAISE EXCEPTION 'JOURNEY_ALREADY_ARRIVED' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'DELAY_REPORTED' THEN
    SELECT count(*) INTO delays FROM public.shift_journey_events
    WHERE shift_id = NEW.shift_id AND event_type = 'DELAY_REPORTED' AND organization_worker_membership_id = NEW.organization_worker_membership_id;
    IF delays >= 3 THEN RAISE EXCEPTION 'JOURNEY_DELAY_LIMIT' USING ERRCODE = '23514'; END IF;
    SELECT declared_delay_minutes, delay_reason INTO last_delay FROM public.shift_journey_events
    WHERE shift_id = NEW.shift_id AND event_type = 'DELAY_REPORTED' AND organization_worker_membership_id = NEW.organization_worker_membership_id
    ORDER BY occurred_at DESC, created_at DESC LIMIT 1;
    IF FOUND AND last_delay.declared_delay_minutes = NEW.declared_delay_minutes AND last_delay.delay_reason = NEW.delay_reason THEN
      RAISE EXCEPTION 'JOURNEY_DELAY_UNCHANGED' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Many shifts in one round trip («Hoy en ruta», family view).
CREATE OR REPLACE FUNCTION app_shift_journey_states(p_shift_ids uuid[])
RETURNS TABLE (
  shift_id uuid, state text, en_route_at timestamptz, delay_minutes smallint, delay_reason text,
  delay_reported_at timestamptz, arrived_at timestamptz, arrival_needs_review boolean,
  started_at timestamptz, finished_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT st.* FROM unnest(p_shift_ids) AS ids(id), LATERAL public.app_shift_journey_state(ids.id) AS st;
$$;
REVOKE ALL ON FUNCTION app_shift_journey_states(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_shift_journey_states(uuid[]) TO app_runtime;

-- ============================================================ J. SmartMatch (MEDIUM M5)
-- A FILLED opportunity whose shift lost its caregiver (declined / removed) can be
-- cancelled; only a started/finished shift or one with a caregiver still pins it.
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
  IF OLD.status = 'FILLED' AND NEW.status = 'CANCELLED' THEN
    IF NEW.cancellation_reason IS NULL OR NEW.cancelled_at IS NULL OR NEW.cancelled_by_user_id IS NULL THEN
      RAISE EXCEPTION 'SMARTMATCH_CANCELLATION_REASON_REQUIRED' USING ERRCODE = '23514';
    END IF;
    IF NEW.shift_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.shifts s WHERE s.id = NEW.shift_id AND s.status <> 'cancelled'
        AND (s.status IN ('in_progress', 'completed')
             OR EXISTS (SELECT 1 FROM public.assignments a WHERE a.shift_id = s.id AND a.organization_id = s.organization_id
                        AND a.response_status IN ('pending', 'accepted')))
    ) THEN
      RAISE EXCEPTION 'SMARTMATCH_LINKED_SHIFT_ACTIVE' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'CANCELLED' AND (NEW.cancellation_reason, NEW.cancellation_note, NEW.cancelled_at, NEW.cancelled_by_user_id)
       IS DISTINCT FROM (OLD.cancellation_reason, OLD.cancellation_note, OLD.cancelled_at, OLD.cancelled_by_user_id) THEN
    RAISE EXCEPTION 'SMARTMATCH_CANCELLATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
