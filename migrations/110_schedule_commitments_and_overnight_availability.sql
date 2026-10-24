-- Migration 110: schedule commitments (SmartMatch H1) and overnight availability (H2).
--
-- H2 -- weekly availability may cross midnight.
--   * A window whose end_time <= start_time ends on the NEXT day (22:00 -> 06:00).
--     An end_time of 23:59 means "until midnight" (a time input cannot say 24:00).
--   * app_availability_covers(membership, starts, ends) answers whether the
--     declared weekly windows cover a whole visit, in the worker's time zone,
--     merging consecutive windows across days (Mon 18:00-23:59 + Tue 00:00-08:00
--     covers Mon 20:00 -> Tue 04:00). Unavailability periods are checked apart.
--     SECURITY INVOKER: the caller's RLS decides which windows it can read.
--
-- H1 -- a caregiver approved in SmartMatch is committed to that time even before
--   the agency creates the shift. app_smartmatch_worker_has_commitment() lets the
--   approval and the Turnos assignment refuse an overlap. SECURITY DEFINER so a
--   supervisor (who cannot read SmartMatch rows) still gets the right answer; it
--   returns a boolean only and only for a membership of the caller's current agency.
--
-- Additive and backwards compatible: existing windows (start < end) keep their
-- meaning; no data is changed.

-- ------------------------------------------------------------------ H2: constraint
ALTER TABLE worker_weekly_availability DROP CONSTRAINT IF EXISTS worker_weekly_availability_check;
ALTER TABLE worker_weekly_availability
  ADD CONSTRAINT worker_weekly_availability_nonzero CHECK (start_time <> end_time);

-- ------------------------------------------------------------------ H2: coverage
CREATE OR REPLACE FUNCTION public.app_availability_covers(
  p_membership uuid, p_starts timestamptz, p_ends timestamptz
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH s AS (
    SELECT timezone FROM public.worker_availability_settings
    WHERE organization_worker_membership_id = p_membership
  ), days AS (
    -- the day before the visit (its overnight window may cover the start) .. the last day
    SELECT d::date AS day, s.timezone
    FROM s, generate_series((p_starts AT TIME ZONE s.timezone)::date - 1,
                            (p_ends AT TIME ZONE s.timezone)::date, interval '1 day') AS d
    WHERE p_ends > p_starts AND p_ends - p_starts <= interval '7 days'
  ), inst AS (
    SELECT (days.day + w.start_time) AT TIME ZONE days.timezone AS a,
           (days.day + CASE
              WHEN w.end_time >= time '23:59' THEN interval '1 day'            -- until midnight
              WHEN w.end_time <= w.start_time THEN interval '1 day' + w.end_time::interval -- ends next day
              ELSE w.end_time::interval END) AT TIME ZONE days.timezone AS b
    FROM days
    JOIN public.worker_weekly_availability w
      ON w.organization_worker_membership_id = p_membership
     AND w.weekday = extract(dow FROM days.day)::int
  ), ordered AS (
    SELECT a, b, max(b) OVER (ORDER BY a, b ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end
    FROM inst
  ), islands AS (
    SELECT a, b, sum(CASE WHEN prev_end IS NULL OR a > prev_end THEN 1 ELSE 0 END) OVER (ORDER BY a, b) AS grp
    FROM ordered
  )
  SELECT EXISTS (
    SELECT 1 FROM islands GROUP BY grp HAVING min(a) <= p_starts AND max(b) >= p_ends
  );
$$;
REVOKE ALL ON FUNCTION public.app_availability_covers(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_availability_covers(uuid, timestamptz, timestamptz) TO app_runtime;

-- ------------------------------------------------------------------ H1: SmartMatch commitments
CREATE OR REPLACE FUNCTION public.app_smartmatch_worker_has_commitment(
  p_membership uuid, p_starts timestamptz, p_ends timestamptz, p_except_opportunity uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_worker_memberships owm
    JOIN public.workers w ON w.id = owm.worker_id
    JOIN public.smartmatch_applications ap
      ON ap.caregiver_user_id = w.user_id AND ap.organization_id = owm.organization_id
    JOIN public.smartmatch_opportunities o
      ON o.id = ap.opportunity_id AND o.organization_id = ap.organization_id
    WHERE owm.id = p_membership
      -- only for the caller's current agency, and only for an active member of it
      AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND public.app_has_active_membership()
      AND ap.status = 'APPROVED'
      AND o.status = 'FILLED'
      AND o.shift_id IS NULL                 -- once the shift exists it is an assignment
      AND o.id IS DISTINCT FROM p_except_opportunity
      AND o.starts_at < p_ends
      AND o.ends_at > p_starts
  );
$$;
REVOKE ALL ON FUNCTION public.app_smartmatch_worker_has_commitment(uuid, timestamptz, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_smartmatch_worker_has_commitment(uuid, timestamptz, timestamptz, uuid) TO app_runtime;
