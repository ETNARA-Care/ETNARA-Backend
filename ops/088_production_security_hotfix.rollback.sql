-- EMERGENCY ROLLBACK of migration 088 (production security hotfix).
--
-- Use only if 088 blocks a legitimate production flow and rolling the code back
-- (which is safe with 088 in place) does not solve it. This RE-OPENS the
-- vulnerabilities 088 closed; prefer a roll-forward fix.
--
-- Restores exactly the policies, grants and triggers of main at 087 (verified by
-- diffing pg_policies / grants / triggers against a database that never had 088).
-- Does not touch data. Run as the database owner in one transaction:
--   psql "$MIGRATIONS_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f ops/088_production_security_hotfix.rollback.sql
-- schema_migrations keeps its 088 row on purpose: the next deploy must NOT
-- silently re-apply it; re-apply manually with psql -f once the cause is fixed.

-- A. users
DROP POLICY IF EXISTS users_read_self_or_shared_org ON users;
DROP POLICY IF EXISTS users_update_self ON users;
DROP POLICY IF EXISTS users_self_or_shared_org ON users;
CREATE POLICY users_self_or_shared_org ON users
  USING (
    id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    OR EXISTS (
      SELECT 1 FROM organization_memberships om1
      JOIN organization_memberships om2 ON om1.organization_id = om2.organization_id
      WHERE om1.user_id = users.id
        AND om2.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        AND om1.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND om1.status = 'active' AND om2.status = 'active')
    OR app_is_superadmin()
  );
GRANT INSERT, UPDATE, DELETE ON users TO app_runtime;

-- B. shifts
DROP TRIGGER IF EXISTS shifts_core_guard ON shifts;
DROP FUNCTION IF EXISTS app_shift_core_guard();
DROP POLICY IF EXISTS shifts_worker_assigned_read ON shifts;
DROP POLICY IF EXISTS shifts_worker_assigned_status ON shifts;
DROP POLICY IF EXISTS shifts_worker_assigned_only ON shifts;
CREATE POLICY shifts_worker_assigned_only ON shifts
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_worker_has_shift_assignment(id));

-- C. family_relationships
DROP TRIGGER IF EXISTS family_relationships_immutable_subject ON family_relationships;
DROP FUNCTION IF EXISTS app_family_relationship_immutable_subject();
DROP POLICY IF EXISTS family_relationships_read ON family_relationships;
DROP POLICY IF EXISTS family_relationships_insert ON family_relationships;
DROP POLICY IF EXISTS family_relationships_manager_update ON family_relationships;
DROP POLICY IF EXISTS family_relationships_manager_delete ON family_relationships;
DROP POLICY IF EXISTS family_relationships_own_or_staff ON family_relationships;
CREATE POLICY family_relationships_own_or_staff ON family_relationships
  USING (
    (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid OR app_has_active_membership()))
    OR app_is_superadmin()
  );

-- D. notifications
DROP POLICY IF EXISTS platform_phi_deny ON notifications;
