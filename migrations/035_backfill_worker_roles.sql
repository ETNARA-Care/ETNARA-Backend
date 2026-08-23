-- Migration 035: Backfill missing WORKER role for existing worker accounts
--
-- Root cause: scripts/seedDemo.ts created active organization_memberships
-- for caregiver demo users without a corresponding user_roles row.
-- GET /me derives organizations[].roles from
-- organization_memberships -> user_roles -> roles.
--
-- Idempotent and general:
-- grants WORKER only when:
-- 1. organization_membership is active
-- 2. workers.user_id matches the same user
-- 3. organization_worker_membership is active in the same organization
-- 4. WORKER role is not already present

INSERT INTO user_roles (organization_membership_id, organization_id, role_id)
SELECT
    om.id,
    om.organization_id,
    r.id
FROM organization_memberships om
JOIN workers w
    ON w.user_id = om.user_id
JOIN organization_worker_memberships owm
    ON owm.worker_id = w.id
   AND owm.organization_id = om.organization_id
   AND owm.status = 'active'
JOIN roles r
    ON r.code = 'WORKER'
WHERE om.status = 'active'
  AND NOT EXISTS (
      SELECT 1
      FROM user_roles ur
      WHERE ur.organization_membership_id = om.id
        AND ur.role_id = r.id
  );
