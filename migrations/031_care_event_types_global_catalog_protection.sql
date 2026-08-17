-- Migration 031: care_event_types global catalog protection
-- SECURITY ISSUE FOUND during this gate's audit, confirmed via direct
-- execution: care_event_types was deliberately left with "NO RLS" (see
-- comment in 014_row_level_security.sql) on the reasoning that it's a
-- global, universally-readable catalog. That reasoning is correct for
-- SELECT, but the table has no RLS whatsoever -- and app_runtime has
-- broad table-level UPDATE/INSERT/DELETE grants (017), so with no RLS
-- policy at all, ANY authenticated tenant context (an ordinary
-- organization admin, or even a plain member) could rename/modify/delete
-- rows in this GLOBAL catalog shared by every organization on the
-- platform. Confirmed: an Org A admin successfully renamed the global
-- 'NOTE' type before this fix.
--
-- Fix: enable RLS, keep SELECT universally open (unchanged behavior --
-- every tenant must still see the full global catalog), and restrict
-- write access to platform admin only.
ALTER TABLE care_event_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY care_event_types_read ON care_event_types
    FOR SELECT
    USING (true);
-- Universally readable -- unchanged from the original "no RLS" behavior
-- for reads. This is a genuinely global, non-tenant-scoped catalog; there
-- is no organization_id column to scope by, by design.

CREATE POLICY care_event_types_write ON care_event_types
    FOR ALL
    USING (app_is_superadmin())
    WITH CHECK (app_is_superadmin());
-- Write authority restricted to platform admin only. No organization
-- (regardless of role) can create, rename, or remove a globally shared
-- event type -- matches the same principle already enforced for
-- requirement_sets' global rows (024) and credential_platform_verifications
-- (022).
