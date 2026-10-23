-- 104_family_relationship_write_authority.sql
--
-- Gate 6 close: a relative must never change their own family permissions.
--
-- Finding: family_relationships_own_or_staff (014) is a FOR ALL policy whose
-- USING doubles as WITH CHECK. Family users hold an active
-- organization_membership (021), so app_has_active_membership() is true for
-- them too. Within their own tenant context a relative could, at the database
-- level, flip can_view_photos / can_participate_in_verification on their own
-- row, re-point it to another person, insert a new relationship, or
-- revoke/delete another family's row. (The same was true for caregivers.)
--
-- Fix (additive, reads unchanged):
--   * SELECT keeps exactly the 014 rule.
--   * UPDATE / DELETE: agency managers only (ORGANIZATION_ADMIN, SUPERVISOR).
--   * INSERT: managers, or the relative accepting their own pending, unexpired
--     invitation for that exact person / relationship / photo permission, with
--     every other permission at its default. Checked by a narrow SECURITY
--     DEFINER helper (the invitation must match the caller's email or phone).
--   * SECURITY DEFINER activation (app_activate_access_invitation, 045/046)
--     runs as the table owner and is unaffected.
-- platform_phi_deny (078, restrictive) still applies to every command.

ALTER TABLE family_relationships ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app_family_invitation_allows_self_insert(
  p_invitation_id uuid, p_organization_id uuid, p_care_recipient_id uuid,
  p_relationship_type text, p_can_view_photos boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM family_invitations i
    JOIN users u ON u.id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    WHERE i.id = p_invitation_id
      AND i.organization_id = p_organization_id
      AND i.care_recipient_id = p_care_recipient_id
      AND i.status::text = 'pending'
      AND i.expires_at > now()
      AND i.relationship_type::text IS NOT DISTINCT FROM p_relationship_type
      AND i.can_view_photos IS NOT DISTINCT FROM p_can_view_photos
      AND (
        (i.email IS NOT NULL AND u.email IS NOT NULL AND lower(i.email) = lower(u.email))
        OR (i.phone IS NOT NULL AND u.phone IS NOT NULL AND i.phone = u.phone)
      )
  );
$$;
REVOKE ALL ON FUNCTION app_family_invitation_allows_self_insert(uuid, uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_family_invitation_allows_self_insert(uuid, uuid, uuid, text, boolean) TO app_runtime;

DROP POLICY IF EXISTS family_relationships_own_or_staff ON family_relationships;
DROP POLICY IF EXISTS family_relationships_read ON family_relationships;
DROP POLICY IF EXISTS family_relationships_insert ON family_relationships;
DROP POLICY IF EXISTS family_relationships_manager_update ON family_relationships;
DROP POLICY IF EXISTS family_relationships_manager_delete ON family_relationships;

-- Reads: unchanged from 014.
CREATE POLICY family_relationships_read ON family_relationships
  FOR SELECT
  USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
      user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      OR app_has_active_membership()
    )
    OR app_is_superadmin()
  );

CREATE POLICY family_relationships_insert ON family_relationships
  FOR INSERT
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
      app_is_org_manager()
      OR (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        AND invitation_id IS NOT NULL
        AND status::text = 'active'
        AND revoked_at IS NULL
        AND is_primary_contact = false
        AND can_participate_in_verification = false
        AND can_view_service_location = false
        AND app_family_invitation_allows_self_insert(invitation_id, organization_id, care_recipient_id,
                                                     relationship_type::text, can_view_photos)
      )
    )
  );

CREATE POLICY family_relationships_manager_update ON family_relationships
  FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager())
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());

CREATE POLICY family_relationships_manager_delete ON family_relationships
  FOR DELETE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());

-- Belt and braces: the subject of a relationship and its tenant never move.
CREATE OR REPLACE FUNCTION app_family_relationship_immutable_subject()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user = 'app_runtime' AND (
       NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id) THEN
    RAISE EXCEPTION 'FAMILY_RELATIONSHIP_SUBJECT_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS family_relationships_immutable_subject ON family_relationships;
CREATE TRIGGER family_relationships_immutable_subject
  BEFORE UPDATE ON family_relationships
  FOR EACH ROW EXECUTE FUNCTION app_family_relationship_immutable_subject();
