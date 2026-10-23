-- Migration 088: production security hotfix (independent of SmartMatch).
--
-- Found by the SmartMatch security audit (23-oct-2026) in policies that are
-- already in production. Every change narrows access; no data is changed or
-- deleted. Idempotent, and written so the later SmartMatch migrations (090-107)
-- re-create the same policy names with the same or stricter rules.
--
--   A. users          FOR ALL without WITH CHECK (014): any member of an agency could
--                     overwrite another user's e-mail / phone / password at DB level.
--   B. shifts         caregiver policy FOR ALL without WITH CHECK (018): an assigned
--                     caregiver could move, re-point or delete their shift at DB level.
--                     A cancelled shift could be revived.
--   C. family_relationships FOR ALL without WITH CHECK (014): relatives (they hold an
--                     active membership) and caregivers could read every relationship
--                     of the agency and, at DB level, change their own permissions,
--                     link themselves to another person, or revoke other families.
--   D. notifications  ETNARA central / Tower read every agency's notifications.
--
-- The matching HTTP fixes ship in the same release (shift update and family
-- revoke require an agency manager).

-- ============================================================ A. users
DROP POLICY IF EXISTS users_self_or_shared_org ON users;
DROP POLICY IF EXISTS users_read_self_or_shared_org ON users;
DROP POLICY IF EXISTS users_update_self ON users;
CREATE POLICY users_read_self_or_shared_org ON users
  FOR SELECT
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
-- Only the password-reset flow writes users from the API, on the owner's row.
-- Accounts are created inside SECURITY DEFINER activation functions.
CREATE POLICY users_update_self ON users
  FOR UPDATE
  USING (id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
REVOKE INSERT, DELETE ON users FROM app_runtime;
REVOKE UPDATE ON users FROM app_runtime;
GRANT UPDATE (password_hash, updated_at) ON users TO app_runtime;

-- ============================================================ B. shifts
DROP POLICY IF EXISTS shifts_worker_assigned_only ON shifts;
DROP POLICY IF EXISTS shifts_worker_assigned_read ON shifts;
DROP POLICY IF EXISTS shifts_worker_assigned_status ON shifts;
CREATE POLICY shifts_worker_assigned_read ON shifts
  FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_worker_has_shift_assignment(id));
-- Check-in / check-out / «Rechazar» change the status as the caregiver.
CREATE POLICY shifts_worker_assigned_status ON shifts
  FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_worker_has_shift_assignment(id))
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION app_shift_core_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- A cancelled shift never comes back; a completed one only re-opens through a
  -- check-in (several caregivers on one shift).
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'SHIFT_STATUS_CANCELLED_IS_FINAL' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'completed' AND NEW.status NOT IN ('in_progress', 'cancelled') THEN
      RAISE EXCEPTION 'SHIFT_STATUS_COMPLETED_IS_FINAL' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Caregivers (non-managers on the API role) may only change the status.
  IF current_user = 'app_runtime' AND NOT public.app_is_org_manager() AND (
       NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id
    OR NEW.room_id IS DISTINCT FROM OLD.room_id
    OR NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start
    OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end
    OR NEW.required_role IS DISTINCT FROM OLD.required_role
    OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'SHIFT_FIELDS_LOCKED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS shifts_core_guard ON shifts;
CREATE TRIGGER shifts_core_guard BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION app_shift_core_guard();

-- ============================================================ C. family_relationships
DROP POLICY IF EXISTS family_relationships_own_or_staff ON family_relationships;
DROP POLICY IF EXISTS family_relationships_read ON family_relationships;
DROP POLICY IF EXISTS family_relationships_insert ON family_relationships;
DROP POLICY IF EXISTS family_relationships_manager_update ON family_relationships;
DROP POLICY IF EXISTS family_relationships_manager_delete ON family_relationships;
-- Reads: own row, agency managers, and people authorised for that same person
-- (the caregiver who serves them; co-relatives, for shared conversations).
CREATE POLICY family_relationships_read ON family_relationships
  FOR SELECT
  USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
      user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      OR app_is_org_manager()
      OR app_user_authorized_for_recipient(NULLIF(current_setting('app.current_user_id', true), '')::uuid,
                                           organization_id, care_recipient_id)
    )
    OR app_is_superadmin()
  );
-- Writes: agency managers only. Relatives are linked by the secure invitation
-- activation (SECURITY DEFINER, unaffected).
CREATE POLICY family_relationships_insert ON family_relationships
  FOR INSERT
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
CREATE POLICY family_relationships_manager_update ON family_relationships
  FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager())
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
CREATE POLICY family_relationships_manager_delete ON family_relationships
  FOR DELETE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());

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

-- ============================================================ D. notifications
-- A platform (Tower) session keeps only its own notifications.
DROP POLICY IF EXISTS platform_phi_deny ON notifications;
CREATE POLICY platform_phi_deny ON notifications
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin() OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (NOT app_is_superadmin() OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
