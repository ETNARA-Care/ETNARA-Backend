-- Migration 112: a caregiver cannot ACCEPT two overlapping shifts, even at
-- different agencies (layer 1, approved 24-oct-2026).
--
-- A caregiver can belong to several agencies (one workers row, one membership
-- per agency). The schedule checks of 110 are per agency. This adds the
-- caregiver's own check, at the moment SHE accepts a shift:
--
--   app_my_confirmed_commitment_overlaps(starts, ends, except_shift)
--     -> boolean, for the CALLER only (app.current_user_id), across all of
--        her agencies: shifts she already ACCEPTED (not cancelled) and
--        SmartMatch visits approved for her that have no shift yet.
--        Pending offers, rejected assignments and cancelled shifts never count.
--
-- Isolation: it answers only about the person making the request and only
-- yes/no. It takes no membership or user argument, so an agency can never ask
-- about a caregiver; there is no read endpoint. The answer goes only to her
-- ("Ya tienes otro turno confirmado en ese horario"); nothing is stored and no
-- agency is notified. SECURITY DEFINER because her other agencies' rows are
-- invisible under RLS in the current agency's context.
-- Concurrency: the API takes a transaction lock per PERSON (workers.id) before
-- calling it, so two acceptances at different agencies cannot both pass.

CREATE OR REPLACE FUNCTION public.app_my_confirmed_commitment_overlaps(
  p_starts timestamptz, p_ends timestamptz, p_except_shift uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH me AS (
    SELECT w.id AS worker_id, w.user_id
    FROM public.workers w
    WHERE w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  )
  SELECT p_ends > p_starts AND (
    EXISTS (
      SELECT 1
      FROM me
      JOIN public.organization_worker_memberships owm ON owm.worker_id = me.worker_id AND owm.status = 'active'
      JOIN public.assignments a ON a.organization_worker_membership_id = owm.id AND a.organization_id = owm.organization_id
      JOIN public.shifts s ON s.id = a.shift_id AND s.organization_id = a.organization_id
      WHERE a.response_status = 'accepted'
        AND s.status <> 'cancelled'
        AND s.id IS DISTINCT FROM p_except_shift
        AND s.scheduled_start < p_ends
        AND s.scheduled_end > p_starts
    )
    OR EXISTS (
      SELECT 1
      FROM me
      JOIN public.smartmatch_applications ap ON ap.caregiver_user_id = me.user_id
      JOIN public.smartmatch_opportunities o ON o.id = ap.opportunity_id AND o.organization_id = ap.organization_id
      WHERE ap.status = 'APPROVED'
        AND o.status = 'FILLED'
        AND o.shift_id IS NULL                 -- once the shift exists, only its accepted assignment counts
        AND o.starts_at < p_ends
        AND o.ends_at > p_starts
    )
  );
$$;
REVOKE ALL ON FUNCTION public.app_my_confirmed_commitment_overlaps(timestamptz, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_my_confirmed_commitment_overlaps(timestamptz, timestamptz, uuid) TO app_runtime;
