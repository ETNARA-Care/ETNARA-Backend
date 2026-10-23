-- Migration 082: harden organization credential review writes.
-- Reading remains tenant-scoped (plus platform aggregate support), but direct
-- INSERT/UPDATE/DELETE decisions are manager-only. Caregivers may reset only
-- their own credential review to pending through the narrow helper below.

DROP POLICY IF EXISTS organization_credential_reviews_tenant_isolation
  ON organization_credential_reviews;

CREATE POLICY organization_credential_reviews_read
  ON organization_credential_reviews
  FOR SELECT
  USING (
    (
      organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND app_has_active_membership()
    )
    OR app_is_superadmin()
  );

CREATE POLICY organization_credential_reviews_manager_insert
  ON organization_credential_reviews
  FOR INSERT
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
    AND reviewed_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

CREATE POLICY organization_credential_reviews_manager_update
  ON organization_credential_reviews
  FOR UPDATE
  USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
    AND reviewed_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

CREATE POLICY organization_credential_reviews_manager_delete
  ON organization_credential_reviews
  FOR DELETE
  USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
  );

CREATE OR REPLACE FUNCTION app_reset_credential_review_pending(
  p_credential_id uuid
)
RETURNS integer AS $$
DECLARE
  v_organization_id uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_current_user_id uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_allowed boolean := false;
  v_updated integer := 0;
BEGIN
  IF v_organization_id IS NULL OR v_current_user_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT (
    app_is_org_manager()
    OR EXISTS (
      SELECT 1
      FROM credentials c
      JOIN workers w ON w.id = c.worker_id
      JOIN organization_worker_memberships owm
        ON owm.worker_id = w.id
       AND owm.organization_id = v_organization_id
       AND owm.status = 'active'
      WHERE c.id = p_credential_id
        AND w.user_id = v_current_user_id
    )
  ) INTO v_allowed;

  IF NOT v_allowed THEN
    RETURN 0;
  END IF;

  UPDATE organization_credential_reviews
  SET review_status = 'pending',
      notes = NULL,
      reviewed_at = NULL
  WHERE credential_id = p_credential_id
    AND organization_id = v_organization_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION app_reset_credential_review_pending(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_reset_credential_review_pending(uuid) TO app_runtime;
