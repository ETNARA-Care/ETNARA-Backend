-- Migration 021: Family Invitation Bootstrap + can_view_photos column
-- Three additive, minimal changes needed to make the family invitation
-- accept-flow and the /me/care-recipients family-perspective endpoint
-- actually work, given the frozen V3 RLS model.

-- ---------------------------------------------------------------------
-- 1. family_invitations: token-hash bootstrap lookup (same GUC pattern
--    already approved for sessions -- app.lookup_token_hash). Needed to
--    resolve an invitation by its raw token BEFORE the accepting user has
--    any membership in that organization.
-- ---------------------------------------------------------------------
CREATE POLICY family_invitations_token_lookup ON family_invitations
    FOR SELECT
    USING (invitation_token_hash = NULLIF(current_setting('app.lookup_token_hash', true), ''));

-- ---------------------------------------------------------------------
-- 2. family_invitations: add can_view_photos so the photo permission
--    requested at invite time can be carried through to the
--    family_relationships row created at accept time. Additive column
--    with a safe default -- no existing rows are broken.
-- ---------------------------------------------------------------------
ALTER TABLE family_invitations
    ADD COLUMN can_view_photos boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------
-- 3. family_relationships: self-lookup by user_id, across ALL
--    organizations, mirroring organization_memberships_self_lookup from
--    020. Needed so GET /me/care-recipients can first discover which
--    (organization_id, care_recipient_id) pairs a family user is related
--    to, without already knowing which single organization to scope to.
--    The actual recipient DATA is still read afterward through the
--    already-approved per-organization withTenantContext() + existing
--    care_recipients_family_specific policy -- this policy only exposes
--    the relationship pointer rows themselves, self-scoped to the caller.
-- ---------------------------------------------------------------------
CREATE POLICY family_relationships_self_lookup ON family_relationships
    FOR SELECT
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
