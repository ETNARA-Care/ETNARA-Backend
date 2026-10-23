-- Migration 102: Gate 6 -- cancelling a FILLED SmartMatch opportunity.
--
-- Rules (Gate 6, explicit, nothing automatic):
--   * FILLED -> CANCELLED needs a reason category (and optional internal note),
--     who and when. FILLED still can never go back to PUBLISHED (097).
--   * If the opportunity has a linked shift (099) that is not cancelled, the
--     opportunity cannot be cancelled: the agency first decides about the real
--     shift in Turnos. SmartMatch never cancels or reassigns shifts.
--   * The approved caregiver is notified (existing notifications table); the
--     internal note is never sent. History is kept (the row is not deleted).

ALTER TABLE smartmatch_opportunities
  ADD COLUMN IF NOT EXISTS cancellation_reason text NULL
    CHECK (cancellation_reason IS NULL OR cancellation_reason IN ('NO_LONGER_NEEDED','SCHEDULE_CHANGED','COVERED_OTHERWISE','OTHER')),
  ADD COLUMN IF NOT EXISTS cancellation_note text NULL
    CHECK (cancellation_note IS NULL OR char_length(cancellation_note) <= 300),
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by_user_id uuid NULL REFERENCES users(id);

-- A cancelled opportunity keeps its (cancelled) shift link for history.
ALTER TABLE smartmatch_opportunities DROP CONSTRAINT IF EXISTS smartmatch_opportunities_shift_only_when_filled;
ALTER TABLE smartmatch_opportunities ADD CONSTRAINT smartmatch_opportunities_shift_only_when_filled
  CHECK (shift_id IS NULL OR status IN ('FILLED', 'CANCELLED'));

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
    ) THEN
      RAISE EXCEPTION 'SMARTMATCH_LINKED_SHIFT_ACTIVE' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Cancellation data is written once, together with the cancellation.
  IF OLD.status = 'CANCELLED' AND (NEW.cancellation_reason, NEW.cancellation_note, NEW.cancelled_at, NEW.cancelled_by_user_id)
       IS DISTINCT FROM (OLD.cancellation_reason, OLD.cancellation_note, OLD.cancelled_at, OLD.cancelled_by_user_id) THEN
    RAISE EXCEPTION 'SMARTMATCH_CANCELLATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

GRANT UPDATE (cancellation_reason, cancellation_note, cancelled_at, cancelled_by_user_id)
  ON smartmatch_opportunities TO app_runtime;

-- Notify the approved caregiver (reason category only, never the note).
CREATE OR REPLACE FUNCTION public.app_smartmatch_notify_filled_cancelled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type,
                                    related_entity_id, channel, status, sent_at)
  SELECT a.caregiver_user_id, a.organization_id, 'SMARTMATCH_OPPORTUNITY_CANCELLED', 'smartmatch_application',
         a.id, 'in_app', 'sent', now()
  FROM public.smartmatch_applications a
  WHERE a.opportunity_id = NEW.id AND a.organization_id = NEW.organization_id AND a.status = 'APPROVED'
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_smartmatch_notify_filled_cancelled() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_smartmatch_notify_filled_cancelled ON smartmatch_opportunities;
CREATE TRIGGER trg_smartmatch_notify_filled_cancelled
  AFTER UPDATE OF status ON smartmatch_opportunities
  FOR EACH ROW WHEN (OLD.status = 'FILLED' AND NEW.status = 'CANCELLED')
  EXECUTE FUNCTION public.app_smartmatch_notify_filled_cancelled();
