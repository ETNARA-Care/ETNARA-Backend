-- Migration 126 — Informe de Turno F1: draft built from the shift's existing records,
-- agency review and approval, append-only history.
--
-- 1. SHIFT_REPORTS joins the per-agency switches (108/115/118/123). Off for every
--    agency; only ETNARA central turns it on. New reports are refused by the
--    database while it is off (app_require_org_feature, as 108).
-- 2. shift_reports: one row per (shift, caregiver, version). `content` is a
--    snapshot of the records that already exist (arrival, start, end, care
--    events, incidents and observations of that caregiver during the visit).
--    Nothing is invented: an empty section is an empty list. The original
--    records are never written by this module.
-- 3. An APPROVED report can no longer change, even for the table owner. The only
--    move left is APPROVED -> SUPERSEDED when a corrected version exists (F4).
--    Reports are never deleted.
-- 4. shift_report_events: append-only history (no UPDATE/DELETE, owner included).
--    It stores who/when/what step and counts, never report content.
-- 5. Access in F1: who may review/approve reports (app_can_review_shift_reports):
--    the agency's ORGANIZATION_ADMIN, or a SUPERVISOR an admin expressly authorized
--    (shift_report_reviewers). Independent of Finanzas, SmartMatch and Horas.
--    Nobody approves a report of their own visit (database guard). Caregivers (F2)
--    and families (F3) get no policy here. ETNARA central is denied by
--    platform_phi_deny (078 pattern).
-- 6. Grants are explicit (066 lesson: a table created after 017 has no runtime
--    rights unless granted here).
--
-- Contract for later phases (no schema change expected):
--   status: DRAFT (F1) -> SUBMITTED (F2, caregiver, within 24 h) -> APPROVED (F1)
--           RETURNED (F2, agency sends it back) ; SUPERSEDED (F4, a newer version)
--   version + supersedes_report_id: corrected versions (F4), previous one kept.
--   family_sections: what the family may see, decided at approval (F3 reads it).
--   events: GENERATED, REGENERATED, APPROVED, SUBMITTED, RETURNED,
--           OBSERVATION_ADDED, CORRECTED, PDF_DOWNLOADED.

-- 1. SHIFT_REPORTS switch -------------------------------------------------------------
ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_feature_code_check;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS'));
ALTER TABLE organization_feature_events DROP CONSTRAINT IF EXISTS organization_feature_events_feature_code_check;
ALTER TABLE organization_feature_events ADD CONSTRAINT organization_feature_events_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS'));

-- 1b. Who may review: admins always; supervisors only when an admin authorized them --
CREATE TABLE IF NOT EXISTS shift_report_reviewers (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id),
  organization_membership_id  uuid NOT NULL REFERENCES organization_memberships(id),
  granted_by_user_id          uuid NOT NULL REFERENCES users(id),
  granted_at                  timestamptz NOT NULL DEFAULT now(),
  revoked_by_user_id          uuid NULL REFERENCES users(id),
  revoked_at                  timestamptz NULL,
  CONSTRAINT shift_report_reviewers_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS shift_report_reviewers_one_active
  ON shift_report_reviewers (organization_membership_id) WHERE revoked_at IS NULL;

-- A grant is never edited or deleted, only revoked once (owner included).
CREATE OR REPLACE FUNCTION app_shift_report_reviewers_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SHIFT_REPORT_REVIEWER_NOT_DELETABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     OR NEW.organization_id <> OLD.organization_id OR NEW.organization_membership_id <> OLD.organization_membership_id
     OR NEW.granted_by_user_id <> OLD.granted_by_user_id OR NEW.granted_at <> OLD.granted_at
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'SHIFT_REPORT_REVIEWER_REVOKE_ONLY' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS shift_report_reviewers_guard ON shift_report_reviewers;
CREATE TRIGGER shift_report_reviewers_guard BEFORE UPDATE OR DELETE ON shift_report_reviewers
  FOR EACH ROW EXECUTE FUNCTION app_shift_report_reviewers_guard();

/** Current user may review shift reports of the current organization. */
CREATE OR REPLACE FUNCTION app_can_review_shift_reports()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    JOIN public.user_roles ur ON ur.organization_membership_id = om.id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND om.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND om.status = 'active'
      AND (r.code = 'ORGANIZATION_ADMIN'
           OR (r.code = 'SUPERVISOR' AND EXISTS (
                 SELECT 1 FROM public.shift_report_reviewers g
                 WHERE g.organization_membership_id = om.id AND g.organization_id = om.organization_id
                   AND g.revoked_at IS NULL)))
  );
$$;

/** Current user is an ORGANIZATION_ADMIN of the current organization (manages reviewers). */
CREATE OR REPLACE FUNCTION app_is_shift_report_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    JOIN public.user_roles ur ON ur.organization_membership_id = om.id
    JOIN public.roles r ON r.id = ur.role_id AND r.code = 'ORGANIZATION_ADMIN'
    WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND om.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND om.status = 'active');
$$;

-- 2. Reports ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shift_reports (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                   uuid NOT NULL REFERENCES organizations(id),
  shift_id                          uuid NOT NULL,
  organization_worker_membership_id uuid NOT NULL,
  care_recipient_id                 uuid NOT NULL,
  version                           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  supersedes_report_id              uuid NULL REFERENCES shift_reports(id),
  status                            text NOT NULL DEFAULT 'DRAFT'
                                    CHECK (status IN ('DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED', 'SUPERSEDED')),
  content_schema                    integer NOT NULL DEFAULT 1,
  content                           jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  family_sections                   jsonb NULL CHECK (family_sections IS NULL OR jsonb_typeof(family_sections) = 'object'),
  agency_summary                    text NULL CHECK (agency_summary IS NULL OR char_length(agency_summary) BETWEEN 1 AND 1000),
  generated_at                      timestamptz NOT NULL DEFAULT now(),
  approved_at                       timestamptz NULL,
  approved_by_user_id               uuid NULL REFERENCES users(id),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id),
  FOREIGN KEY (organization_worker_membership_id, organization_id) REFERENCES organization_worker_memberships (id, organization_id),
  FOREIGN KEY (care_recipient_id, organization_id) REFERENCES care_recipients (id, organization_id),
  UNIQUE (organization_id, shift_id, organization_worker_membership_id, version),
  CONSTRAINT shift_reports_approval_complete CHECK (
    status NOT IN ('APPROVED', 'SUPERSEDED')
    OR (approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL AND family_sections IS NOT NULL)),
  CONSTRAINT shift_reports_version_chain CHECK ((version = 1) = (supersedes_report_id IS NULL))
);
CREATE INDEX IF NOT EXISTS shift_reports_org_status_idx ON shift_reports (organization_id, status, generated_at DESC);
CREATE INDEX IF NOT EXISTS shift_reports_shift_idx ON shift_reports (shift_id);

-- 3. Immutability ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_shift_report_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SHIFT_REPORT_NOT_DELETABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.shift_id <> OLD.shift_id
     OR NEW.organization_worker_membership_id <> OLD.organization_worker_membership_id
     OR NEW.care_recipient_id <> OLD.care_recipient_id OR NEW.version <> OLD.version
     OR NEW.supersedes_report_id IS DISTINCT FROM OLD.supersedes_report_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'SHIFT_REPORT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('APPROVED', 'SUPERSEDED') THEN
    IF NOT (OLD.status = 'APPROVED' AND NEW.status = 'SUPERSEDED'
            AND NEW.content = OLD.content AND NEW.content_schema = OLD.content_schema
            AND NEW.family_sections IS NOT DISTINCT FROM OLD.family_sections
            AND NEW.agency_summary IS NOT DISTINCT FROM OLD.agency_summary
            AND NEW.generated_at = OLD.generated_at
            AND NEW.approved_at = OLD.approved_at AND NEW.approved_by_user_id = OLD.approved_by_user_id) THEN
      RAISE EXCEPTION 'SHIFT_REPORT_APPROVED_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Nobody approves the report of their own visit (also an admin who worked it).
  IF NEW.status = 'APPROVED' AND OLD.status <> 'APPROVED' AND EXISTS (
       SELECT 1 FROM public.organization_worker_memberships owm JOIN public.workers w ON w.id = owm.worker_id
       WHERE owm.id = NEW.organization_worker_membership_id AND w.user_id = NEW.approved_by_user_id) THEN
    RAISE EXCEPTION 'SHIFT_REPORT_SELF_APPROVAL' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS shift_reports_guard ON shift_reports;
CREATE TRIGGER shift_reports_guard BEFORE UPDATE OR DELETE ON shift_reports
  FOR EACH ROW EXECUTE FUNCTION app_shift_report_guard();
DROP TRIGGER IF EXISTS shift_reports_require_feature ON shift_reports;
CREATE TRIGGER shift_reports_require_feature BEFORE INSERT ON shift_reports
  FOR EACH ROW EXECUTE FUNCTION app_require_org_feature('SHIFT_REPORTS');

-- 4. History ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shift_report_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  shift_report_id  uuid NOT NULL REFERENCES shift_reports(id),
  event_type       text NOT NULL CHECK (event_type IN ('GENERATED', 'REGENERATED', 'APPROVED', 'SUBMITTED', 'RETURNED',
                                                        'OBSERVATION_ADDED', 'CORRECTED', 'PDF_DOWNLOADED')),
  actor_user_id    uuid NULL REFERENCES users(id),
  note             text NULL CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  details          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shift_report_events_report_idx ON shift_report_events (shift_report_id, created_at);

CREATE OR REPLACE FUNCTION app_shift_report_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'SHIFT_REPORT_HISTORY_APPEND_ONLY' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS shift_report_events_append_only ON shift_report_events;
CREATE TRIGGER shift_report_events_append_only BEFORE UPDATE OR DELETE ON shift_report_events
  FOR EACH ROW EXECUTE FUNCTION app_shift_report_events_append_only();

-- 5. Row level security -----------------------------------------------------------------
ALTER TABLE shift_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE shift_report_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_report_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shift_reports_manager ON shift_reports;
CREATE POLICY shift_reports_manager ON shift_reports FOR ALL TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_can_review_shift_reports())
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_can_review_shift_reports());

DROP POLICY IF EXISTS shift_report_events_manager_read ON shift_report_events;
CREATE POLICY shift_report_events_manager_read ON shift_report_events FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_can_review_shift_reports());
DROP POLICY IF EXISTS shift_report_events_manager_insert ON shift_report_events;
CREATE POLICY shift_report_events_manager_insert ON shift_report_events FOR INSERT TO app_runtime
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_can_review_shift_reports()
              AND actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND EXISTS (SELECT 1 FROM shift_reports r WHERE r.id = shift_report_id AND r.organization_id = shift_report_events.organization_id));

ALTER TABLE shift_report_reviewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_report_reviewers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shift_report_reviewers_admin ON shift_report_reviewers;
CREATE POLICY shift_report_reviewers_admin ON shift_report_reviewers FOR ALL TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_shift_report_admin())
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_shift_report_admin()
              AND EXISTS (SELECT 1 FROM organization_memberships om
                          WHERE om.id = shift_report_reviewers.organization_membership_id
                            AND om.organization_id = shift_report_reviewers.organization_id));
DROP POLICY IF EXISTS platform_phi_deny ON shift_report_reviewers;
CREATE POLICY platform_phi_deny ON shift_report_reviewers AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());

-- ETNARA central never reads report content (078 pattern).
DROP POLICY IF EXISTS platform_phi_deny ON shift_reports;
CREATE POLICY platform_phi_deny ON shift_reports AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());
DROP POLICY IF EXISTS platform_phi_deny ON shift_report_events;
CREATE POLICY platform_phi_deny ON shift_report_events AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());

-- 6. Grants -----------------------------------------------------------------------------
REVOKE ALL ON shift_reports, shift_report_events, shift_report_reviewers FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON shift_report_reviewers TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON shift_reports TO app_runtime;
GRANT SELECT, INSERT ON shift_report_events TO app_runtime;
REVOKE ALL ON FUNCTION app_shift_report_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_shift_report_events_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_shift_report_reviewers_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_can_review_shift_reports() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_is_shift_report_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_can_review_shift_reports() TO app_runtime;
GRANT EXECUTE ON FUNCTION app_is_shift_report_admin() TO app_runtime;
