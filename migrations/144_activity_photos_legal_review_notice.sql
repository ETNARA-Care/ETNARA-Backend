-- Activity photos v2 — D2 (2-nov-2026): daily in-app notice to the agency's
-- administration when photos under a LEGAL HOLD have an overdue review.
--
-- Decisions approved by Rafa (D2):
--  - Only the number of overdue reviews and a link to the administrative screen.
--    Never a photo, a resident, clinical data, the legal basis or the reference.
--  - In-app only: no e-mail and no SMS (channel 'in_app').
--  - Works whether the expiry / purge job is off, simulate or on: it is a
--    separate background function with its own worker.
--  - No duplicates: at most one notice per administrator, per agency, per day
--    (Puerto Rico calendar day), enforced by a unique index.
--  - Agencies are separated: each agency's count is computed only from its own
--    photos and goes only to its own active administrators.
--
-- Additive only: two nullable columns on notifications, one partial unique
-- index, one function. Nothing existing changes.

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS item_count integer NULL;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS notice_day date NULL;

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_legal_review_shape;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_legal_review_shape CHECK (
  CASE WHEN notification_type = 'PHOTO_LEGAL_HOLD_REVIEW_OVERDUE'
       THEN organization_id IS NOT NULL AND item_count BETWEEN 1 AND 100000 AND notice_day IS NOT NULL
            AND related_entity_type = 'organization' AND related_entity_id = organization_id
            AND care_recipient_id IS NULL AND channel = 'in_app'
       ELSE item_count IS NULL AND notice_day IS NULL
  END);

-- One notice per administrator, per agency, per day.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_legal_review_daily
  ON public.notifications (user_id, organization_id, notice_day)
  WHERE notification_type = 'PHOTO_LEGAL_HOLD_REVIEW_OVERDUE';

/**
 * Background job only (no request context; ETNARA central refused). For every
 * agency with ACTIVITY_PHOTOS on and at least one photo under a legal hold whose
 * review date has passed, creates today's notice for each ACTIVE administrator
 * of THAT agency, with the count only. Returns how many notices were created
 * (0 when today's notices already exist).
 */
CREATE OR REPLACE FUNCTION public.app_photo_legal_review_notify()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_day date := (now() AT TIME ZONE 'America/Puerto_Rico')::date;
  v_total integer := 0;
  v_n integer;
  r record;
BEGIN
  PERFORM public.app_assert_background_job();
  IF public.app_is_superadmin() THEN RAISE EXCEPTION 'BACKGROUND_JOB_ONLY' USING ERRCODE = '42501'; END IF;
  FOR r IN
    SELECT p.organization_id AS org, count(*)::integer AS n
      FROM public.care_event_photos p
     WHERE p.deleted_at IS NULL
       AND p.legal_hold_basis IS NOT NULL
       AND p.legal_hold_review_at <= now()
     GROUP BY p.organization_id
  LOOP
    -- With the switch off the administrative screen is not available (and the
    -- legal-hold actions are refused), so no link can be offered.
    CONTINUE WHEN NOT public.app_org_feature_enabled(r.org, 'ACTIVITY_PHOTOS');
    WITH inserted AS (
      INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id,
                                        care_recipient_id, channel, status, sent_at, item_count, notice_day)
      SELECT DISTINCT om.user_id, r.org, 'PHOTO_LEGAL_HOLD_REVIEW_OVERDUE', 'organization', r.org,
                      NULL::uuid, 'in_app', 'sent', now(), r.n, v_day
        FROM public.organization_memberships om
        JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
        JOIN public.roles ro ON ro.id = ur.role_id
        JOIN public.users u ON u.id = om.user_id
       WHERE om.organization_id = r.org AND om.status = 'active' AND u.status = 'active'
         AND ro.code = 'ORGANIZATION_ADMIN'
      ON CONFLICT DO NOTHING
      RETURNING 1)
    SELECT count(*)::integer INTO v_n FROM inserted;
    v_total := v_total + v_n;
  END LOOP;
  RETURN v_total;
END $$;

REVOKE ALL ON FUNCTION public.app_photo_legal_review_notify() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_legal_review_notify() TO app_runtime;
