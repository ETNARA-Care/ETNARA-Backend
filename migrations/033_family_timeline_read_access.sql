-- Migration 033: Family Timeline read access
--
-- PART A — ARCHITECTURE FINDING (confirmed by inspection, not assumed):
-- care_events has NO family-visibility branch at all. Only
-- care_events_admin_supervisor_full_tenant and care_events_worker_assigned_only
-- exist (018) -- a FAMILY-role user, however legitimately related to the
-- recipient, cannot SELECT a single care_events row today. This is the
-- structural gap Family Timeline needs closed. Minimal, additive fix: a
-- new SELECT-only policy granting a FAMILY user read access to
-- care_events rows for a recipient they have an ACTIVE family_relationship
-- with. No INSERT/UPDATE/DELETE authority is granted -- family never
-- writes care_events.
--
-- PART B — SECURITY ISSUE FOUND (confirmed via direct execution against
-- PostgreSQL, not assumed): stored_files_organizational_scope (014) grants
-- ANY active org member -- including a FAMILY user -- blanket read access
-- to EVERY ORGANIZATION_OPERATIONAL file in that org, with no relationship
-- or can_view_photos check whatsoever. This completely bypasses the
-- correct, narrow guard already present on care_event_photos (which DOES
-- check can_view_photos), because a family user can read the underlying
-- stored_files row (storage_key included) directly, independent of that
-- guard. Confirmed: a family member with can_view_photos=false and no
-- relationship to a given document could read its storage_key. Fix,
-- following the exact idiom already used elsewhere in this schema
-- (care_recipients_tenant_staff's NOT EXISTS ... FAMILY check): staff
-- keep unchanged full operational access; a FAMILY-role member can only
-- reach a stored_files row through the legitimate care_event_photos ->
-- care_events -> family_relationships chain, with can_view_photos = true.

-- ---------------------------------------------------------------------
-- A. care_events family read policy
-- ---------------------------------------------------------------------
CREATE POLICY care_events_family_read ON care_events
    FOR SELECT
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM family_relationships fr
            WHERE fr.care_recipient_id = care_events.care_recipient_id
              AND fr.organization_id = care_events.organization_id
              AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND fr.status = 'active'
        )
    );

-- ---------------------------------------------------------------------
-- B. stored_files: close the family bypass
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS stored_files_organizational_scope ON stored_files;

CREATE POLICY stored_files_organizational_scope ON stored_files
    FOR SELECT
    USING (
        scope_type = 'ORGANIZATION_OPERATIONAL'
        AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            NOT EXISTS ( -- staff (not a FAMILY-role member for this org): unchanged, full operational access
                SELECT 1 FROM user_roles ur
                JOIN organization_memberships om ON ur.organization_membership_id = om.id
                JOIN roles r ON ur.role_id = r.id
                WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                  AND om.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
                  AND r.code = 'FAMILY'
            )
            OR EXISTS ( -- family: ONLY via the legitimate photo-permission chain
                SELECT 1 FROM care_event_photos cep
                JOIN care_events ce ON ce.id = cep.care_event_id
                JOIN family_relationships fr
                  ON fr.care_recipient_id = ce.care_recipient_id
                 AND fr.organization_id = ce.organization_id
                WHERE cep.file_id = stored_files.id
                  AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                  AND fr.status = 'active'
                  AND fr.can_view_photos = true
            )
        )
        OR app_is_superadmin()
    );
-- Write authority (INSERT/UPDATE/DELETE) on stored_files was never granted
-- broadly here to begin with -- application code creates rows via its own
-- validated paths (credentialing, care event photos, incident
-- attachments), each already gated by their own service logic. This
-- policy governs SELECT visibility only, matching the original policy's
-- own scope.
