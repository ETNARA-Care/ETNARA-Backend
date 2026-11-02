-- Migration 141: activity photos v2 — family authorization, direct sending,
-- caregiver window, provisional retention, removal, exceptional holds.
--
-- Product decisions of 2-nov-2026 (Rafa):
--  * Each relative decides expressly whether to receive photos. It starts at
--    "not answered" (= no). Only the relative changes it, through
--    app_set_family_photo_receipt. It is separate from the resident's (or
--    representative's) consent to be photographed / to share (115).
--  * A2: a relative only sees photos SENT AFTER the effective time of their
--    authorization (photo created_at >= photo_receipt_at). No retroactivity.
--  * No manual approval: if every condition holds when the caregiver sends the
--    photo, it is shared at once; otherwise it stays "agency only" (pending).
--    The agency can withdraw (with reason) and show again; everything audited.
--  * The caregiver has no permanent gallery: she sees her photo only during
--    her window (check-out + 1 h, at most 24 h after sending) and may remove it.
--  * Retention: 30 days PROVISIONAL (photo_retention_policies). Access ends at
--    expiry for everyone (unless an exceptional hold: managers only). Physical
--    deletion by expiry is V2 and can only run with an APPROVED policy.
--  * Exceptional holds: reason, responsible manager, review date <= 90 days,
--    at most 3 hold actions in total (place + 2 renewals), absolute cap 270
--    days from the first hold; lapses by itself at the review date.
--  * Visit end, end of the care relationship and revocation cut ACCESS only;
--    they never delete. Deletion: manager (MANUAL, reason), caregiver within
--    her window (CAREGIVER_UNDO), expiry (RETENTION, V2), reconciliation (V2).
--  * Deleted = tombstone: the row and its history stay, the image is purged
--    and the storage key, size and checksum are removed. No hidden copies.
--
-- ETNARA central (app_is_superadmin) gets nothing. app_runtime only receives
-- EXECUTE on the new functions. ACTIVITY_PHOTOS stays off. Production has no
-- photo rows (the switch was never on); local rows are backfilled below.

-- ---------------------------------------------------------------- 1. retention policy (provisional)
CREATE TABLE IF NOT EXISTS photo_retention_policies (
  purpose text PRIMARY KEY CHECK (purpose IN ('ACTIVITY_PHOTO')),
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  status text NOT NULL CHECK (status IN ('PROVISIONAL', 'APPROVED')),
  -- Physical deletion by expiry can only be enabled for an APPROVED policy.
  purge_enabled boolean NOT NULL DEFAULT false CHECK (status = 'APPROVED' OR purge_enabled = false),
  legal_reference text NULL,
  approved_by text NULL,
  approved_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'APPROVED') = (approved_at IS NOT NULL AND approved_by IS NOT NULL))
);
INSERT INTO photo_retention_policies (purpose, retention_days, status, purge_enabled)
VALUES ('ACTIVITY_PHOTO', 30, 'PROVISIONAL', false)
ON CONFLICT (purpose) DO NOTHING;

CREATE TABLE IF NOT EXISTS photo_retention_policy_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL,
  retention_days integer NOT NULL,
  status text NOT NULL,
  purge_enabled boolean NOT NULL,
  legal_reference text NULL,
  changed_by text NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO photo_retention_policy_events (purpose, retention_days, status, purge_enabled, changed_by)
SELECT purpose, retention_days, status, purge_enabled, 'migration 141' FROM photo_retention_policies
WHERE NOT EXISTS (SELECT 1 FROM photo_retention_policy_events);

CREATE OR REPLACE FUNCTION public.app_photo_retention_policy_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.photo_retention_policy_events (purpose, retention_days, status, purge_enabled, legal_reference, changed_by)
  VALUES (NEW.purpose, NEW.retention_days, NEW.status, NEW.purge_enabled, NEW.legal_reference, coalesce(NEW.approved_by, current_user));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_retention_policy_history() FROM PUBLIC;
DROP TRIGGER IF EXISTS photo_retention_policies_history ON photo_retention_policies;
CREATE TRIGGER photo_retention_policies_history AFTER UPDATE ON photo_retention_policies
  FOR EACH ROW EXECUTE FUNCTION public.app_photo_retention_policy_history();

CREATE OR REPLACE FUNCTION public.app_append_only_141() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'HISTORY_APPEND_ONLY' USING ERRCODE = '23514'; END $$;
DROP TRIGGER IF EXISTS photo_retention_policy_events_append_only ON photo_retention_policy_events;
CREATE TRIGGER photo_retention_policy_events_append_only BEFORE UPDATE OR DELETE ON photo_retention_policy_events
  FOR EACH ROW EXECUTE FUNCTION public.app_append_only_141();

-- Only an administrative connection changes the policy; app_runtime reads the days through a function.
ALTER TABLE photo_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_retention_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE photo_retention_policy_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_retention_policy_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON photo_retention_policies, photo_retention_policy_events FROM app_runtime;
DROP POLICY IF EXISTS photo_retention_policies_owner ON photo_retention_policies;
CREATE POLICY photo_retention_policies_owner ON photo_retention_policies FOR ALL TO PUBLIC
  USING (current_user <> 'app_runtime') WITH CHECK (current_user <> 'app_runtime');
DROP POLICY IF EXISTS photo_retention_policy_events_owner ON photo_retention_policy_events;
CREATE POLICY photo_retention_policy_events_owner ON photo_retention_policy_events FOR ALL TO PUBLIC
  USING (current_user <> 'app_runtime') WITH CHECK (current_user <> 'app_runtime');

CREATE OR REPLACE FUNCTION public.app_photo_retention_days(p_purpose text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT retention_days FROM public.photo_retention_policies WHERE purpose = p_purpose
$$;
REVOKE ALL ON FUNCTION public.app_photo_retention_days(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_retention_days(text) TO app_runtime;

-- ---------------------------------------------------------------- 2. the relative's own authorization
ALTER TABLE family_relationships ADD COLUMN IF NOT EXISTS photo_receipt text NOT NULL DEFAULT 'not_answered';
ALTER TABLE family_relationships ADD COLUMN IF NOT EXISTS photo_receipt_at timestamptz NULL;
ALTER TABLE family_relationships DROP CONSTRAINT IF EXISTS family_relationships_photo_receipt_check;
ALTER TABLE family_relationships ADD CONSTRAINT family_relationships_photo_receipt_check
  CHECK (photo_receipt IN ('not_answered', 'accepted', 'declined')
         AND (photo_receipt = 'not_answered') = (photo_receipt_at IS NULL));

CREATE TABLE IF NOT EXISTS family_photo_receipt_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  family_relationship_id uuid NOT NULL REFERENCES family_relationships(id),
  care_recipient_id uuid NOT NULL,
  family_user_id uuid NOT NULL REFERENCES users(id),
  decision text NOT NULL CHECK (decision IN ('accepted', 'declined', 'reset')),
  text_version text NULL,
  actor_user_id uuid NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_photo_receipt_events_rel ON family_photo_receipt_events (family_relationship_id, occurred_at);
DROP TRIGGER IF EXISTS family_photo_receipt_events_append_only ON family_photo_receipt_events;
CREATE TRIGGER family_photo_receipt_events_append_only BEFORE UPDATE OR DELETE ON family_photo_receipt_events
  FOR EACH ROW EXECUTE FUNCTION public.app_append_only_141();
ALTER TABLE family_photo_receipt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_photo_receipt_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON family_photo_receipt_events FROM app_runtime;
GRANT SELECT ON family_photo_receipt_events TO app_runtime;
DROP POLICY IF EXISTS family_photo_receipt_events_read ON family_photo_receipt_events;
CREATE POLICY family_photo_receipt_events_read ON family_photo_receipt_events FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND (public.app_photo_is_manager() OR family_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid));
DROP POLICY IF EXISTS platform_phi_deny ON family_photo_receipt_events;
CREATE POLICY platform_phi_deny ON family_photo_receipt_events AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());

-- Nobody but the relative (through the function) sets the authorization. A
-- relationship that becomes active again starts over at "not answered".
CREATE OR REPLACE FUNCTION public.app_family_photo_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.photo_receipt IS DISTINCT FROM 'not_answered' OR NEW.photo_receipt_at IS NOT NULL THEN
      RAISE EXCEPTION 'PHOTO_RECEIPT_SELF_ONLY' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.photo_receipt IS DISTINCT FROM OLD.photo_receipt OR NEW.photo_receipt_at IS DISTINCT FROM OLD.photo_receipt_at)
     AND coalesce(current_setting('app.photo_receipt_writer', true), '') <> 'on' THEN
    RAISE EXCEPTION 'PHOTO_RECEIPT_SELF_ONLY' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IS DISTINCT FROM 'active' AND NEW.status = 'active' AND OLD.photo_receipt <> 'not_answered' THEN
    NEW.photo_receipt := 'not_answered';
    NEW.photo_receipt_at := NULL;
    INSERT INTO public.family_photo_receipt_events (organization_id, family_relationship_id, care_recipient_id, family_user_id, decision)
    VALUES (NEW.organization_id, NEW.id, NEW.care_recipient_id, NEW.user_id, 'reset');
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.app_family_photo_receipt_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS family_relationships_photo_receipt_guard ON family_relationships;
CREATE TRIGGER family_relationships_photo_receipt_guard BEFORE INSERT OR UPDATE ON family_relationships
  FOR EACH ROW EXECUTE FUNCTION public.app_family_photo_receipt_guard();

-- The relative's active relationship with this resident, in this agency, with
-- an active FAMILY membership. Raises if there is none.
CREATE OR REPLACE FUNCTION public.app_photo_own_family_relationship(p_care_recipient_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid;
BEGIN
  IF public.app_is_superadmin() OR public.app_photo_ctx_org() IS NULL OR public.app_photo_ctx_user() IS NULL THEN
    RAISE EXCEPTION 'PHOTO_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT fr.id INTO v_id FROM public.family_relationships fr
   WHERE fr.user_id = public.app_photo_ctx_user() AND fr.organization_id = public.app_photo_ctx_org()
     AND fr.care_recipient_id = p_care_recipient_id AND fr.status = 'active'
     AND EXISTS (SELECT 1 FROM public.organization_memberships om
                 JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
                 JOIN public.roles r ON r.id = ur.role_id AND r.code = 'FAMILY'
                 WHERE om.user_id = fr.user_id AND om.organization_id = fr.organization_id AND om.status = 'active');
  IF v_id IS NULL THEN RAISE EXCEPTION 'PHOTO_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_own_family_relationship(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.app_family_photo_receipt(p_care_recipient_id uuid)
RETURNS TABLE (decision text, decided_at timestamptz, text_version text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_rel uuid := public.app_photo_own_family_relationship(p_care_recipient_id);
BEGIN
  IF NOT public.app_org_feature_enabled(public.app_photo_ctx_org(), 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
    SELECT fr.photo_receipt, fr.photo_receipt_at,
           (SELECT e.text_version FROM public.family_photo_receipt_events e
             WHERE e.family_relationship_id = fr.id AND e.decision <> 'reset' ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1)
      FROM public.family_relationships fr WHERE fr.id = v_rel;
END $$;
REVOKE ALL ON FUNCTION public.app_family_photo_receipt(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_family_photo_receipt(uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_set_family_photo_receipt(p_care_recipient_id uuid, p_decision text, p_text_version text)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_rel uuid; v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); r record; v_at timestamptz := clock_timestamp();
BEGIN
  v_rel := public.app_photo_own_family_relationship(p_care_recipient_id);
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501'; END IF;
  IF p_decision NOT IN ('accepted', 'declined') THEN RAISE EXCEPTION 'PHOTO_RECEIPT_INVALID' USING ERRCODE = '22023'; END IF;
  IF p_text_version IS NULL OR p_text_version !~ '^[A-Za-z0-9._-]{1,40}$' THEN RAISE EXCEPTION 'PHOTO_RECEIPT_INVALID' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM public.family_relationships WHERE id = v_rel FOR UPDATE;
  PERFORM set_config('app.photo_receipt_writer', 'on', true);
  UPDATE public.family_relationships SET photo_receipt = p_decision, photo_receipt_at = v_at WHERE id = v_rel;
  PERFORM set_config('app.photo_receipt_writer', '', true);
  INSERT INTO public.family_photo_receipt_events (organization_id, family_relationship_id, care_recipient_id, family_user_id, decision, text_version, actor_user_id, occurred_at)
  VALUES (v_org, v_rel, r.care_recipient_id, v_user, p_decision, p_text_version, v_user, v_at);
  INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
  VALUES (v_user, v_org, v_org, CASE p_decision WHEN 'accepted' THEN 'PHOTO_RECEIPT_ACCEPTED' ELSE 'PHOTO_RECEIPT_DECLINED' END,
          'family_relationship', v_rel, jsonb_build_object('textVersion', p_text_version));
  RETURN v_at;
END $$;
REVOKE ALL ON FUNCTION public.app_set_family_photo_receipt(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_set_family_photo_receipt(uuid, text, text) TO app_runtime;

-- Agency managers: who receives photos for a resident (no new contact data).
CREATE OR REPLACE FUNCTION public.app_photo_recipients(p_care_recipient_id uuid)
RETURNS TABLE (relationship_id uuid, email text, relationship_type text, photo_receipt text, photo_receipt_at timestamptz, can_view_photos boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.app_photo_is_manager() THEN RAISE EXCEPTION 'PHOTO_CONSENT_MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.care_recipients cr WHERE cr.id = p_care_recipient_id AND cr.organization_id = public.app_photo_ctx_org()) THEN
    RAISE EXCEPTION 'PHOTO_RECIPIENT_NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT fr.id, u.email::text, fr.relationship_type::text, fr.photo_receipt, fr.photo_receipt_at, fr.can_view_photos
      FROM public.family_relationships fr JOIN public.users u ON u.id = fr.user_id
     WHERE fr.organization_id = public.app_photo_ctx_org() AND fr.care_recipient_id = p_care_recipient_id AND fr.status = 'active'
     ORDER BY fr.created_at;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_recipients(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_recipients(uuid) TO app_runtime;

-- ---------------------------------------------------------------- 3. photos: new columns, states, tombstone, holds
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS shared_at timestamptz NULL;
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS deleted_by_user_id uuid NULL REFERENCES users(id);
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS deletion_kind text NULL;
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS deletion_reason text NULL;
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS hold_reason text NULL;
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS hold_by_user_id uuid NULL REFERENCES users(id);
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS hold_placed_at timestamptz NULL;
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS hold_review_at timestamptz NULL;
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS hold_first_placed_at timestamptz NULL;
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS hold_actions integer NOT NULL DEFAULT 0;
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS purged_at timestamptz NULL;
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS purge_verified_at timestamptz NULL;

-- Backfill (local data only; production has no photo rows).
ALTER TABLE care_event_photos DISABLE TRIGGER care_event_photos_guard;
ALTER TABLE care_event_photos DISABLE TRIGGER care_event_photos_history;
UPDATE care_event_photos SET shared_at = reviewed_at WHERE share_status IN ('approved', 'withdrawn') AND shared_at IS NULL;
UPDATE care_event_photos SET retention_until = created_at + make_interval(days => public.app_photo_retention_days('ACTIVITY_PHOTO'));
ALTER TABLE care_event_photos ENABLE TRIGGER care_event_photos_guard;
ALTER TABLE care_event_photos ENABLE TRIGGER care_event_photos_history;
ALTER TABLE care_event_photos ALTER COLUMN retention_until SET NOT NULL;

ALTER TABLE care_event_photos DROP CONSTRAINT IF EXISTS care_event_photos_status_check;
ALTER TABLE care_event_photos ADD CONSTRAINT care_event_photos_status_check CHECK (
  share_status IN ('pending', 'approved', 'rejected', 'withdrawn', 'deleted')
  AND (share_status NOT IN ('rejected', 'withdrawn')
       OR length(btrim(coalesce(review_reason, ''))) BETWEEN 3 AND 300)
  AND (share_status NOT IN ('approved', 'withdrawn') OR shared_at IS NOT NULL)
  AND ((share_status = 'deleted') = (deleted_at IS NOT NULL))
  AND ((deleted_at IS NULL) = (deletion_kind IS NULL))
  AND (deletion_kind IS NULL OR deletion_kind IN ('MANUAL', 'CAREGIVER_UNDO', 'RETENTION', 'RECONCILED'))
  AND (purged_at IS NULL OR deleted_at IS NOT NULL)
  AND (purge_verified_at IS NULL OR purged_at IS NOT NULL));
ALTER TABLE care_event_photos DROP CONSTRAINT IF EXISTS care_event_photos_hold_check;
ALTER TABLE care_event_photos ADD CONSTRAINT care_event_photos_hold_check CHECK (
  ((hold_reason IS NULL) = (hold_by_user_id IS NULL))
  AND ((hold_reason IS NULL) = (hold_placed_at IS NULL))
  AND ((hold_reason IS NULL) = (hold_review_at IS NULL))
  AND (hold_reason IS NULL OR hold_first_placed_at IS NOT NULL)
  AND (hold_reason IS NULL OR length(btrim(hold_reason)) BETWEEN 10 AND 300)
  AND hold_actions BETWEEN 0 AND 3
  AND (hold_review_at IS NULL OR hold_review_at <= hold_first_placed_at + interval '270 days'));
CREATE INDEX IF NOT EXISTS idx_care_event_photos_expiry ON care_event_photos (retention_until) WHERE deleted_at IS NULL;

-- Is an exceptional hold in force right now?
CREATE OR REPLACE FUNCTION public.app_photo_hold_active(p_photo_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.care_event_photos p WHERE p.id = p_photo_id
                 AND p.deleted_at IS NULL AND p.hold_reason IS NOT NULL AND p.hold_review_at > now())
$$;
REVOKE ALL ON FUNCTION public.app_photo_hold_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_hold_active(uuid) TO app_runtime;

-- Guard: rows are never deleted; identity, send time, retention date and the
-- first sharing time are immutable; deleted is terminal (only purge marks).
CREATE OR REPLACE FUNCTION public.app_care_event_photo_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PHOTO_HISTORY_KEPT' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.care_events ce WHERE ce.id = NEW.care_event_id
                   AND ce.organization_id = NEW.organization_id AND ce.care_recipient_id = NEW.care_recipient_id) THEN
      RAISE EXCEPTION 'PHOTO_EVENT_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.stored_files f WHERE f.id = NEW.file_id
                   AND f.organization_id = NEW.organization_id AND f.purpose = 'ACTIVITY_PHOTO') THEN
      RAISE EXCEPTION 'PHOTO_FILE_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF NEW.share_status <> 'pending' OR NEW.shared_at IS NOT NULL OR NEW.deleted_at IS NOT NULL OR NEW.hold_reason IS NOT NULL THEN
      RAISE EXCEPTION 'PHOTO_STARTS_PENDING' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.care_event_id IS DISTINCT FROM OLD.care_event_id
     OR NEW.file_id IS DISTINCT FROM OLD.file_id OR NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id
     OR NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.consent_verified_at IS DISTINCT FROM OLD.consent_verified_at OR NEW.capture_consent_id IS DISTINCT FROM OLD.capture_consent_id
     OR NEW.retention_until IS DISTINCT FROM OLD.retention_until
     OR (OLD.shared_at IS NOT NULL AND NEW.shared_at IS DISTINCT FROM OLD.shared_at)
     OR (OLD.hold_first_placed_at IS NOT NULL AND NEW.hold_first_placed_at IS DISTINCT FROM OLD.hold_first_placed_at)
     OR NEW.hold_actions < OLD.hold_actions THEN
    RAISE EXCEPTION 'PHOTO_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.share_status = 'deleted' THEN
    -- Terminal: only the purge marks may be filled in, once.
    IF NEW.share_status <> 'deleted' OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.deletion_kind IS DISTINCT FROM OLD.deletion_kind
       OR NEW.deletion_reason IS DISTINCT FROM OLD.deletion_reason OR NEW.deleted_by_user_id IS DISTINCT FROM OLD.deleted_by_user_id
       OR NEW.hold_reason IS NOT NULL OR NEW.shared_at IS DISTINCT FROM OLD.shared_at
       OR (OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at)
       OR (OLD.purge_verified_at IS NOT NULL AND NEW.purge_verified_at IS DISTINCT FROM OLD.purge_verified_at) THEN
      RAISE EXCEPTION 'PHOTO_DELETED_TERMINAL' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.share_status IS DISTINCT FROM OLD.share_status AND NOT (
       (OLD.share_status = 'pending'   AND NEW.share_status IN ('approved', 'rejected', 'deleted'))
    OR (OLD.share_status = 'approved'  AND NEW.share_status IN ('withdrawn', 'deleted'))
    OR (OLD.share_status IN ('rejected', 'withdrawn') AND NEW.share_status IN ('approved', 'deleted'))) THEN
    RAISE EXCEPTION 'PHOTO_INVALID_TRANSITION % -> %', OLD.share_status, NEW.share_status USING ERRCODE = '23514';
  END IF;
  IF NEW.share_status = 'deleted' AND NEW.hold_reason IS NOT NULL AND NEW.hold_review_at > now() THEN
    RAISE EXCEPTION 'PHOTO_ON_HOLD' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- History: every change of state, written by trigger; holds and purges are
-- written by their functions (same append-only table).
ALTER TABLE care_event_photo_events DROP CONSTRAINT IF EXISTS care_event_photo_events_action_check;
ALTER TABLE care_event_photo_events ADD CONSTRAINT care_event_photo_events_action_check CHECK (action IN (
  'UPLOADED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'SHARED', 'RESHOWN', 'DELETED', 'PURGED',
  'HOLD_PLACED', 'HOLD_RENEWED', 'HOLD_RELEASED', 'HOLD_EXPIRED'));

CREATE OR REPLACE FUNCTION public.app_care_event_photo_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_action text; v_actor uuid; v_reason text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.care_event_photo_events (organization_id, photo_id, care_recipient_id, action, from_status, to_status, actor_user_id)
    VALUES (NEW.organization_id, NEW.id, NEW.care_recipient_id, 'UPLOADED', NULL, NEW.share_status, NEW.uploaded_by_user_id);
  ELSIF NEW.share_status IS DISTINCT FROM OLD.share_status THEN
    v_actor := NEW.reviewed_by_user_id; v_reason := NEW.review_reason;
    IF NEW.share_status = 'approved' AND OLD.share_status = 'pending' AND NEW.reviewed_by_user_id IS NULL THEN
      v_action := 'SHARED'; v_actor := NEW.uploaded_by_user_id; v_reason := NULL;
    ELSIF NEW.share_status = 'approved' AND OLD.share_status IN ('withdrawn', 'rejected') AND OLD.shared_at IS NOT NULL THEN
      v_action := 'RESHOWN'; v_reason := NULL;
    ELSIF NEW.share_status = 'approved' THEN v_action := 'APPROVED'; v_reason := NULL;
    ELSIF NEW.share_status = 'rejected' THEN v_action := 'REJECTED';
    ELSIF NEW.share_status = 'withdrawn' THEN v_action := 'WITHDRAWN';
    ELSE v_action := 'DELETED'; v_actor := NEW.deleted_by_user_id; v_reason := NEW.deletion_kind || coalesce(': ' || NEW.deletion_reason, '');
    END IF;
    INSERT INTO public.care_event_photo_events (organization_id, photo_id, care_recipient_id, action, from_status, to_status, actor_user_id, reason)
    VALUES (NEW.organization_id, NEW.id, NEW.care_recipient_id, v_action, OLD.share_status, NEW.share_status, v_actor, v_reason);
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- 4. stored files: purge marks only
CREATE OR REPLACE FUNCTION public.app_stored_files_purpose_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id THEN
    RAISE EXCEPTION 'STORED_FILE_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  -- The storage key may only be replaced by the purge tombstone of a removed activity photo.
  IF NEW.storage_key IS DISTINCT FROM OLD.storage_key
     AND NOT (OLD.purpose = 'ACTIVITY_PHOTO' AND NEW.status = 'hidden' AND NEW.storage_key = 'purged/' || OLD.id) THEN
    RAISE EXCEPTION 'STORED_FILE_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- 5. purge queue (removed photos; V2 runs it on expiry)
CREATE TABLE IF NOT EXISTS photo_purge_queue (
  photo_id uuid PRIMARY KEY REFERENCES care_event_photos(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  storage_key text NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz NULL,
  last_error_code text NULL,
  purged_at timestamptz NULL,
  verified_at timestamptz NULL,
  CHECK ((purged_at IS NULL) = (storage_key IS NOT NULL)),
  CHECK (verified_at IS NULL OR purged_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_photo_purge_queue_pending ON photo_purge_queue (enqueued_at) WHERE purged_at IS NULL;
ALTER TABLE photo_purge_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_purge_queue FORCE ROW LEVEL SECURITY;
REVOKE ALL ON photo_purge_queue FROM app_runtime;
DROP POLICY IF EXISTS photo_purge_queue_owner ON photo_purge_queue;
CREATE POLICY photo_purge_queue_owner ON photo_purge_queue FOR ALL TO PUBLIC
  USING (current_user <> 'app_runtime') WITH CHECK (current_user <> 'app_runtime');

-- ---------------------------------------------------------------- 6. access rules
-- Caregiver window: her own photo, until check-out + 1 h, at most 24 h after
-- sending, while her capture consent and membership are active.
CREATE OR REPLACE FUNCTION public.app_photo_uploader_can_view(p_photo_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT public.app_is_superadmin() AND EXISTS (
    SELECT 1 FROM public.care_event_photos p JOIN public.care_events ce ON ce.id = p.care_event_id
    WHERE p.id = p_photo_id AND p.organization_id = public.app_photo_ctx_org()
      AND p.uploaded_by_user_id = public.app_photo_ctx_user() AND public.app_has_active_membership()
      AND p.deleted_at IS NULL AND now() < p.retention_until
      AND p.created_at > now() - interval '24 hours'
      AND EXISTS (SELECT 1 FROM public.consent_records c WHERE c.id = p.capture_consent_id AND c.revoked_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM public.verification_events ve
                      WHERE ve.shift_id = ce.shift_id AND ve.organization_id = p.organization_id
                        AND ve.organization_worker_membership_id = ce.organization_worker_membership_id
                        AND ve.event_type = 'check_out' AND ve.occurred_at <= now() - interval '1 hour'))
$$;
REVOKE ALL ON FUNCTION public.app_photo_uploader_can_view(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_uploader_can_view(uuid) TO app_runtime;

-- Relatives: every condition, at every call.
CREATE OR REPLACE FUNCTION public.app_family_can_view_activity_photo(p_photo_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT public.app_is_superadmin() AND EXISTS (
    SELECT 1 FROM public.care_event_photos p
    JOIN public.family_relationships fr
      ON fr.care_recipient_id = p.care_recipient_id AND fr.organization_id = p.organization_id
    WHERE p.id = p_photo_id
      AND p.organization_id = public.app_photo_ctx_org()
      AND p.share_status = 'approved' AND p.deleted_at IS NULL
      AND now() < p.retention_until
      AND fr.user_id = public.app_photo_ctx_user()
      AND fr.status = 'active' AND fr.can_view_photos = true
      -- the relative's own authorization, and only photos SENT after it (A2)
      AND fr.photo_receipt = 'accepted' AND p.created_at >= fr.photo_receipt_at
      AND EXISTS (SELECT 1 FROM public.organization_memberships om
                  JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
                  JOIN public.roles r ON r.id = ur.role_id AND r.code = 'FAMILY'
                  WHERE om.user_id = fr.user_id AND om.organization_id = p.organization_id AND om.status = 'active')
      AND public.app_org_feature_enabled(p.organization_id, 'ACTIVITY_PHOTOS')
      -- the capture consent the photo was taken under is still active ...
      AND EXISTS (SELECT 1 FROM public.consent_records c WHERE c.id = p.capture_consent_id
                  AND c.organization_id = p.organization_id AND c.revoked_at IS NULL)
      -- ... and the sharing consent active now was already active when it was shared.
      AND EXISTS (SELECT 1 FROM public.consent_records c WHERE c.organization_id = p.organization_id
                  AND c.care_recipient_id = p.care_recipient_id AND c.consent_type = 'PHOTO_SHARE_FAMILY'
                  AND c.revoked_at IS NULL AND c.granted_at <= p.shared_at))
$$;

-- Row access: managers of the agency; the caregiver only inside her window.
DROP POLICY IF EXISTS care_event_photos_staff_read ON care_event_photos;
CREATE POLICY care_event_photos_staff_read ON care_event_photos FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND (public.app_photo_is_manager() OR public.app_photo_uploader_can_view(id)));

-- The only way to obtain a photo's storage key.
CREATE OR REPLACE FUNCTION public.app_activity_photo_for_view(p_photo_id uuid)
RETURNS TABLE (storage_key text, content_type text, size_bytes bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); v_kind text; p record;
BEGIN
  IF public.app_is_superadmin() OR v_org IS NULL OR v_user IS NULL THEN RETURN; END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RETURN; END IF;
  SELECT cep.id, cep.retention_until, f.storage_key AS key, f.content_type AS ctype, f.size_bytes AS size
    INTO p
    FROM public.care_event_photos cep JOIN public.stored_files f ON f.id = cep.file_id
   WHERE cep.id = p_photo_id AND cep.organization_id = v_org AND cep.deleted_at IS NULL
     AND f.status = 'active' AND f.purpose = 'ACTIVITY_PHOTO';
  IF NOT FOUND THEN RETURN; END IF;
  IF public.app_photo_is_manager() AND (now() < p.retention_until OR public.app_photo_hold_active(p_photo_id)) THEN v_kind := 'MANAGER';
  ELSIF public.app_family_can_view_activity_photo(p_photo_id) THEN v_kind := 'FAMILY';
  ELSIF public.app_photo_uploader_can_view(p_photo_id) THEN v_kind := 'UPLOADER';
  ELSE RETURN;
  END IF;
  IF v_kind = 'FAMILY' THEN
    INSERT INTO public.care_event_photo_access_log (photo_id, organization_id, viewer_user_id, viewer_kind, access_day)
    VALUES (p_photo_id, v_org, v_user, v_kind, (now() AT TIME ZONE 'America/Puerto_Rico')::date)
    ON CONFLICT (photo_id, viewer_user_id, access_day)
      DO UPDATE SET views = care_event_photo_access_log.views + 1, last_viewed_at = now();
  END IF;
  storage_key := p.key; content_type := p.ctype; size_bytes := p.size;
  RETURN NEXT;
END $$;

-- ---------------------------------------------------------------- 7. sending: retention from the policy, direct sharing
CREATE OR REPLACE FUNCTION public.app_attach_activity_photo(p_care_event_id uuid, p_file_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user();
        v_recipient uuid; v_consent uuid; v_id uuid; v_days integer := public.app_photo_retention_days('ACTIVITY_PHOTO');
BEGIN
  IF public.app_is_superadmin() OR v_org IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'PHOTO_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501'; END IF;
  IF v_days IS NULL THEN RAISE EXCEPTION 'PHOTO_RETENTION_POLICY_MISSING' USING ERRCODE = '42501'; END IF;
  SELECT ce.care_recipient_id INTO v_recipient
    FROM public.care_events ce
    JOIN public.organization_worker_memberships owm ON owm.id = ce.organization_worker_membership_id AND owm.organization_id = ce.organization_id
    JOIN public.workers w ON w.id = owm.worker_id
   WHERE ce.id = p_care_event_id AND ce.organization_id = v_org AND w.user_id = v_user AND owm.status = 'active'
     AND ce.created_at > now() - interval '12 hours';
  IF v_recipient IS NULL THEN RAISE EXCEPTION 'PHOTO_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stored_files f WHERE f.id = p_file_id AND f.organization_id = v_org
                 AND f.purpose = 'ACTIVITY_PHOTO' AND f.uploaded_by_user_id = v_user AND f.status = 'active') THEN
    RAISE EXCEPTION 'PHOTO_FILE_NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  SELECT c.id INTO v_consent FROM public.consent_records c
   WHERE c.organization_id = v_org AND c.care_recipient_id = v_recipient AND c.consent_type = 'PHOTO_CAPTURE' AND c.revoked_at IS NULL;
  IF v_consent IS NULL THEN RAISE EXCEPTION 'PHOTO_CONSENT_REQUIRED' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.care_event_photos (organization_id, care_event_id, file_id, care_recipient_id, uploaded_by_user_id,
                                        consent_verified_at, capture_consent_id, retention_until)
  VALUES (v_org, p_care_event_id, p_file_id, v_recipient, v_user, now(), v_consent, now() + make_interval(days => v_days))
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'PHOTO_FILE_ALREADY_LINKED' USING ERRCODE = '23505';
END $$;

CREATE OR REPLACE FUNCTION public.app_create_activity_photo(p_care_event_id uuid, p_file_id uuid, p_storage_key text, p_size_bytes bigint, p_checksum text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); v_recipient uuid; v_photo uuid; v_share boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('activity-photo:' || p_care_event_id, 0));
  v_recipient := public.app_precheck_activity_photo(p_care_event_id);
  PERFORM 1 FROM public.consent_records c
   WHERE c.organization_id = v_org AND c.care_recipient_id = v_recipient AND c.consent_type = 'PHOTO_CAPTURE' AND c.revoked_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PHOTO_CONSENT_REQUIRED' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.care_event_photos p WHERE p.care_event_id = p_care_event_id) THEN
    RAISE EXCEPTION 'PHOTO_ALREADY_ATTACHED' USING ERRCODE = '23505';
  END IF;
  IF p_storage_key IS DISTINCT FROM ('activity-photos/' || v_org || '/' || v_recipient || '/' || p_file_id || '.jpg') THEN
    RAISE EXCEPTION 'PHOTO_STORAGE_KEY_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF p_size_bytes IS NULL OR p_size_bytes <= 0 OR p_size_bytes > 20 * 1024 * 1024 OR p_checksum !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'PHOTO_INVALID_FILE' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.stored_files (id, scope_type, organization_id, storage_key, content_type, original_filename, size_bytes,
                                   checksum, uploaded_by_user_id, visibility, status, purpose)
  VALUES (p_file_id, 'ORGANIZATION_OPERATIONAL', v_org, p_storage_key, 'image/jpeg', 'actividad.jpg', p_size_bytes,
          p_checksum, v_user, 'private', 'active', 'ACTIVITY_PHOTO');
  v_photo := public.app_attach_activity_photo(p_care_event_id, p_file_id);
  -- Direct sending (2-nov): shared at once if the sharing consent is active now
  -- (held until commit); otherwise it stays for the agency only.
  PERFORM 1 FROM public.consent_records c
   WHERE c.organization_id = v_org AND c.care_recipient_id = v_recipient AND c.consent_type = 'PHOTO_SHARE_FAMILY' AND c.revoked_at IS NULL
   FOR SHARE;
  v_share := FOUND;
  IF v_share THEN
    UPDATE public.care_event_photos SET share_status = 'approved', shared_at = now() WHERE id = v_photo;
  END IF;
  INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
  VALUES (v_user, v_org, v_org, 'ACTIVITY_PHOTO_UPLOADED', 'care_event_photo', v_photo,
          jsonb_build_object('careEventId', p_care_event_id, 'sharedWithFamily', v_share));
  RETURN v_photo;
END $$;

-- ---------------------------------------------------------------- 8. agency: withdraw / show again (no manual approval)
CREATE OR REPLACE FUNCTION public.app_review_activity_photo(p_photo_id uuid, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); p record;
BEGIN
  IF NOT public.app_photo_is_manager() THEN RAISE EXCEPTION 'PHOTO_REVIEW_MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501'; END IF;
  IF p_decision NOT IN ('APPROVE', 'WITHDRAW') THEN RAISE EXCEPTION 'PHOTO_INVALID_DECISION' USING ERRCODE = '22023'; END IF;
  SELECT * INTO p FROM public.care_event_photos WHERE id = p_photo_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND OR p.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'PHOTO_NOT_FOUND' USING ERRCODE = '42501'; END IF;
  IF now() >= p.retention_until THEN RAISE EXCEPTION 'PHOTO_EXPIRED' USING ERRCODE = '42501'; END IF;
  IF p_decision = 'WITHDRAW' THEN
    IF p.share_status <> 'approved' THEN RAISE EXCEPTION 'PHOTO_INVALID_TRANSITION' USING ERRCODE = '23514'; END IF;
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'PHOTO_REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
    UPDATE public.care_event_photos
       SET share_status = 'withdrawn', reviewed_by_user_id = public.app_photo_ctx_user(), reviewed_at = now(), review_reason = btrim(p_reason)
     WHERE id = p_photo_id;
    RETURN 'withdrawn';
  END IF;
  -- Show again: only a photo that was shared when sent, with both consents still valid.
  IF p.share_status NOT IN ('withdrawn', 'rejected') OR p.shared_at IS NULL THEN
    RAISE EXCEPTION 'PHOTO_NOT_SHAREABLE' USING ERRCODE = '23514';
  END IF;
  IF NOT (EXISTS (SELECT 1 FROM public.consent_records c WHERE c.id = p.capture_consent_id AND c.revoked_at IS NULL)
      AND EXISTS (SELECT 1 FROM public.consent_records c WHERE c.organization_id = v_org AND c.care_recipient_id = p.care_recipient_id
                  AND c.consent_type = 'PHOTO_SHARE_FAMILY' AND c.revoked_at IS NULL AND c.granted_at <= p.shared_at)) THEN
    RAISE EXCEPTION 'PHOTO_CONSENT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  UPDATE public.care_event_photos
     SET share_status = 'approved', reviewed_by_user_id = public.app_photo_ctx_user(), reviewed_at = now(), review_reason = NULL
   WHERE id = p_photo_id;
  RETURN 'approved';
END $$;

-- ---------------------------------------------------------------- 9. removal (tombstone + purge queue)
CREATE OR REPLACE FUNCTION public.app_delete_activity_photo(p_photo_id uuid, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); p record; v_kind text; v_reason text; v_key text;
BEGIN
  IF public.app_is_superadmin() OR v_org IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'PHOTO_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501'; END IF;
  -- Decide the kind BEFORE locking (the window check reads the row itself).
  IF public.app_photo_is_manager() THEN
    v_kind := 'MANUAL';
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'PHOTO_REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
    v_reason := btrim(p_reason);
  ELSIF public.app_photo_uploader_can_view(p_photo_id) THEN
    v_kind := 'CAREGIVER_UNDO';
    v_reason := nullif(left(btrim(coalesce(p_reason, '')), 300), '');
  ELSE
    RAISE EXCEPTION 'PHOTO_NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO p FROM public.care_event_photos WHERE id = p_photo_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PHOTO_NOT_FOUND' USING ERRCODE = '42501'; END IF;
  IF p.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'PHOTO_ALREADY_DELETED' USING ERRCODE = '23514'; END IF;
  IF p.hold_reason IS NOT NULL AND p.hold_review_at > now() THEN RAISE EXCEPTION 'PHOTO_ON_HOLD' USING ERRCODE = '23514'; END IF;
  SELECT f.storage_key INTO v_key FROM public.stored_files f WHERE f.id = p.file_id;
  UPDATE public.care_event_photos
     SET share_status = 'deleted', deleted_at = now(), deleted_by_user_id = v_user, deletion_kind = v_kind, deletion_reason = v_reason,
         hold_reason = NULL, hold_by_user_id = NULL, hold_placed_at = NULL, hold_review_at = NULL
   WHERE id = p_photo_id;
  UPDATE public.stored_files SET status = 'hidden' WHERE id = p.file_id;
  INSERT INTO public.photo_purge_queue (photo_id, organization_id, storage_key) VALUES (p_photo_id, v_org, v_key)
  ON CONFLICT (photo_id) DO NOTHING;
  INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
  VALUES (v_user, v_org, v_org, 'ACTIVITY_PHOTO_DELETED', 'care_event_photo', p_photo_id, jsonb_build_object('kind', v_kind));
  RETURN v_kind;
END $$;
REVOKE ALL ON FUNCTION public.app_delete_activity_photo(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_delete_activity_photo(uuid, text) TO app_runtime;

-- Immediate purge right after a removal, by the same person, within 5 minutes.
-- (Expiry and retries are V2.) Returns the key once; never anything else.
CREATE OR REPLACE FUNCTION public.app_photo_purge_claim(p_photo_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_key text;
BEGIN
  IF public.app_is_superadmin() THEN RETURN NULL; END IF;
  SELECT q.storage_key INTO v_key FROM public.photo_purge_queue q JOIN public.care_event_photos p ON p.id = q.photo_id
   WHERE q.photo_id = p_photo_id AND q.organization_id = public.app_photo_ctx_org() AND q.purged_at IS NULL
     AND p.deleted_by_user_id = public.app_photo_ctx_user() AND p.deleted_at > now() - interval '5 minutes'
   FOR UPDATE OF q;
  IF v_key IS NOT NULL THEN
    UPDATE public.photo_purge_queue SET attempts = attempts + 1, last_attempt_at = now() WHERE photo_id = p_photo_id;
  END IF;
  RETURN v_key;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_purge_claim(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_purge_claim(uuid) TO app_runtime;

-- Records the result. Only a verified absence (HeadObject 404) completes it:
-- the key, size and checksum are then removed from the database.
CREATE OR REPLACE FUNCTION public.app_photo_purge_result(p_photo_id uuid, p_verified boolean, p_error_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE q record;
BEGIN
  SELECT * INTO q FROM public.photo_purge_queue WHERE photo_id = p_photo_id AND purged_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF public.app_is_superadmin() THEN RETURN; END IF;
  -- From a request: only the person who removed it, in the same agency, within
  -- 5 minutes (same as the claim). V2's job runs without a tenant context.
  IF public.app_photo_ctx_org() IS NOT NULL OR public.app_photo_ctx_user() IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.care_event_photos p WHERE p.id = p_photo_id
                   AND p.organization_id = public.app_photo_ctx_org() AND q.organization_id = p.organization_id
                   AND p.deleted_by_user_id = public.app_photo_ctx_user() AND p.deleted_at > now() - interval '5 minutes') THEN
      RETURN;
    END IF;
  END IF;
  IF NOT p_verified THEN
    UPDATE public.photo_purge_queue SET last_error_code = left(coalesce(p_error_code, 'UNKNOWN'), 60) WHERE photo_id = p_photo_id;
    RETURN;
  END IF;
  UPDATE public.photo_purge_queue SET storage_key = NULL, purged_at = now(), verified_at = now(), last_error_code = NULL WHERE photo_id = p_photo_id;
  UPDATE public.care_event_photos SET purged_at = now(), purge_verified_at = now() WHERE id = p_photo_id;
  UPDATE public.stored_files f SET storage_key = 'purged/' || f.id, checksum = NULL, size_bytes = 0, original_filename = 'purged'
   FROM public.care_event_photos p WHERE p.id = p_photo_id AND f.id = p.file_id;
  INSERT INTO public.care_event_photo_events (organization_id, photo_id, care_recipient_id, action, from_status, to_status)
  SELECT p.organization_id, p.id, p.care_recipient_id, 'PURGED', 'deleted', 'deleted' FROM public.care_event_photos p WHERE p.id = p_photo_id;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_purge_result(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_purge_result(uuid, boolean, text) TO app_runtime;

-- ---------------------------------------------------------------- 10. exceptional holds (managers)
CREATE OR REPLACE FUNCTION public.app_photo_hold_write(p_photo_id uuid, p_action text, p_reason text, p_review_at timestamptz)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); p record; v_active boolean; v_first timestamptz; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF NOT public.app_photo_is_manager() THEN RAISE EXCEPTION 'PHOTO_REVIEW_MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501'; END IF;
  SELECT * INTO p FROM public.care_event_photos WHERE id = p_photo_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND OR p.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'PHOTO_NOT_FOUND' USING ERRCODE = '42501'; END IF;
  v_active := p.hold_reason IS NOT NULL AND p.hold_review_at > now();
  IF length(v_reason) NOT BETWEEN 10 AND 300 THEN RAISE EXCEPTION 'PHOTO_HOLD_REASON_REQUIRED' USING ERRCODE = '22023'; END IF;

  IF p_action = 'RELEASE' THEN
    IF NOT v_active THEN RAISE EXCEPTION 'PHOTO_HOLD_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
    UPDATE public.care_event_photos SET hold_reason = NULL, hold_by_user_id = NULL, hold_placed_at = NULL, hold_review_at = NULL WHERE id = p_photo_id;
    INSERT INTO public.care_event_photo_events (organization_id, photo_id, care_recipient_id, action, from_status, to_status, actor_user_id, reason)
    VALUES (v_org, p_photo_id, p.care_recipient_id, 'HOLD_RELEASED', p.share_status, p.share_status, v_user, v_reason);
    RETURN NULL;
  END IF;

  IF p_review_at IS NULL OR p_review_at <= now() OR p_review_at > now() + interval '90 days' THEN
    RAISE EXCEPTION 'PHOTO_HOLD_REVIEW_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'PLACE' THEN
    IF v_active THEN RAISE EXCEPTION 'PHOTO_HOLD_EXISTS' USING ERRCODE = '23514'; END IF;
    -- Only before expiry: an expired photo is no longer kept for anyone.
    IF now() >= p.retention_until THEN RAISE EXCEPTION 'PHOTO_EXPIRED' USING ERRCODE = '42501'; END IF;
  ELSIF p_action = 'RENEW' THEN
    IF NOT v_active THEN RAISE EXCEPTION 'PHOTO_HOLD_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
    IF v_reason = p.hold_reason THEN RAISE EXCEPTION 'PHOTO_HOLD_REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  ELSE
    RAISE EXCEPTION 'PHOTO_INVALID_DECISION' USING ERRCODE = '22023';
  END IF;
  -- Controls against indefinite holds (also across release and placing again).
  IF p.hold_actions >= 3 THEN RAISE EXCEPTION 'PHOTO_HOLD_LIMIT' USING ERRCODE = '23514'; END IF;
  v_first := coalesce(p.hold_first_placed_at, now());
  IF p_review_at > v_first + interval '270 days' THEN RAISE EXCEPTION 'PHOTO_HOLD_LIMIT' USING ERRCODE = '23514'; END IF;
  UPDATE public.care_event_photos
     SET hold_reason = v_reason, hold_by_user_id = v_user, hold_placed_at = CASE WHEN p_action = 'PLACE' THEN now() ELSE hold_placed_at END,
         hold_review_at = p_review_at, hold_first_placed_at = v_first, hold_actions = hold_actions + 1
   WHERE id = p_photo_id;
  INSERT INTO public.care_event_photo_events (organization_id, photo_id, care_recipient_id, action, from_status, to_status, actor_user_id, reason)
  VALUES (v_org, p_photo_id, p.care_recipient_id, CASE p_action WHEN 'PLACE' THEN 'HOLD_PLACED' ELSE 'HOLD_RENEWED' END,
          p.share_status, p.share_status, v_user, v_reason || ' (revisión: ' || to_char(p_review_at AT TIME ZONE 'America/Puerto_Rico', 'YYYY-MM-DD') || ')');
  INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
  VALUES (v_user, v_org, v_org, 'ACTIVITY_PHOTO_HOLD_' || p_action, 'care_event_photo', p_photo_id, jsonb_build_object('reviewAt', p_review_at));
  RETURN p_review_at;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_hold_write(uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_hold_write(uuid, text, text, timestamptz) TO app_runtime;
