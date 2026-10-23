-- Phase 12.4: check-in / check-out without signal.
--
-- A caregiver's phone may have no signal at the door. The app stores the
-- check-in or check-out on the device (encrypted) and sends it when the
-- connection returns. Same safety as care events (083):
--
--   1. client_event_id: a UUID generated on the device. A retry of a record
--      the server already stored returns the existing row, never a duplicate.
--   2. occurred_at supplied by the client, validated by the service (not in
--      the future, not before the open check-in, at most 7 days old).
--   3. recorded_offline: true when the record reached the server more than
--      two minutes after it happened, so the agency sees
--      "registrada sin conexión".
--
-- Additive only. Existing rows keep client_event_id = NULL and
-- recorded_offline = false. RLS on verification_events is unchanged (086).

ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS client_event_id uuid NULL;
ALTER TABLE verification_events ADD COLUMN IF NOT EXISTS recorded_offline boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS verification_events_client_event_unique
    ON verification_events (organization_id, organization_worker_membership_id, client_event_id)
    WHERE client_event_id IS NOT NULL;

-- A retry can arrive after the visit closed, when the caregiver can no
-- longer read the shift's records (076). This lookup answers only for the
-- caller's own record, by its own device id, in the current organization.
CREATE OR REPLACE FUNCTION public.app_find_own_verification_event(p_client_event_id uuid, p_event_type text)
RETURNS TABLE (id uuid, shift_id uuid, event_type text, occurred_at timestamptz, recorded_offline boolean, client_event_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT ve.id, ve.shift_id, ve.event_type::text, ve.occurred_at, ve.recorded_offline, ve.client_event_id
    FROM public.verification_events ve
    JOIN public.organization_worker_memberships owm ON owm.id = ve.organization_worker_membership_id
    JOIN public.workers w ON w.id = owm.worker_id
    WHERE ve.client_event_id = p_client_event_id
      AND ve.event_type::text = p_event_type
      AND ve.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND app_has_active_membership()
    LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.app_find_own_verification_event(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_find_own_verification_event(uuid, text) TO app_runtime;
