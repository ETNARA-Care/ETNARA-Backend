-- Issue #170: deny platform-global sessions access to patient-level data.
-- PostgreSQL permissive policies are OR-combined; a RESTRICTIVE policy
-- is AND-combined and therefore closes historical superadmin bypasses.
-- Tenant-scoped sessions (withTenantContext) retain their existing policies.
-- Do not change app_is_superadmin() globally: Tower operational tables need it.
-- No break-glass access is enabled by this migration.

DO $$
DECLARE target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'care_recipients',
    'care_plans',
    'care_events',
    'observations',
    'incidents',
    'resident_documents',
    'family_relationships',
    'consent_records',
    'family_invitations'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY platform_phi_deny ON %I AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin())',
      target_table
    );
  END LOOP;
END $$;

-- Follow-up work: stored_files, document versions, exports, notifications,
-- clinical derivatives and signed-download endpoints need end-to-end audit
-- before declaring global PHI access fully blocked.
