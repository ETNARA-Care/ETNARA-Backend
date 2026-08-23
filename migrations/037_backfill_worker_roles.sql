-- Migration 035: Backfill missing WORKER role for existing worker accounts
--
-- Root cause: scripts/seedDemo.ts created active organization_memberships
-- for caregiver demo users without a corresponding user_roles row (the
-- optional roleCode argument to addMembership() was omitted for them).
-- GET /me derives organizations[].roles exclusively from
-- organization_memberships -> user_roles -> roles, so those accounts
-- authenticated successfully but reported roles: [] to the frontend.
--
-- This does NOT touch any operational authorization: RLS for a worker's
-- own shifts/care events (app_current_worker_ids(), 018_rls_hardening.sql)
-- keys off workers.user_id directly, never off user_roles -- confirmed by
-- reading that function before writing this migration. This migration
-- only affects what GET /me reports and anything that explicitly checks
-- for the WORKER role code.
--
-- Idempotent and general: not scoped to specific emails. Grants WORKER
-- only where all four conditions hold simultaneously:
--   1. an active organization_membership exists for (user, org)
--   2. a workers row exists whose user_id matches that same user
--   3. an ACTIVE organization_worker_membership exists for (that worker,
--      that org) -- status = 'active', the same criterion the codebase's
--      own RLS policy (workers_self_or_shared_org, 014_row_level_security.sql)
--      already uses to decide worker visibility. An 'inactive' membership
--      must NOT grant WORKER.
--   4. no user_roles row for WORKER already exists on that membership
-- No ambiguity: workers.user_id is UNIQUE (006_workforce.sql) and
-- organization_worker_memberships has UNIQUE (worker_id, organization_id),
-- so at most one owm row can match per (user, organization) pair.
-- Safe to run multiple times: the NOT EXISTS guard plus the existing
-- UNIQUE (organization_membership_id, role_id) constraint on user_roles
-- both prevent duplicate inserts.

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
