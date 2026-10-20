-- Issue #170: global platform administrators do not receive patient PHI.
-- RESTRICTIVE policies AND with existing permissive policies, closing the
-- historic app_is_superadmin() bypass without changing tenant authorization.
-- Privileged platform operations (Tower and billing) remain separate.
-- This migration does not authorize emergency/support access.
--
-- NOTE: The runtime must connect as app_runtime, not a BYPASSRLS/table owner.
-- Verify that role configuration in staging before deploying.

DO $$
DECLARE target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'care_recipients',
    'care_plans',
    'care_events',
    'care_event_photos',
    'observations',
    'incidents',
    'incident_timeline_entries',
    'incident_attachments',
    'resident_documents',
    'family_relationships',
    'consent_records',
    'family_invitations',
    'message_threads',
    'message_thread_participants',
    'messages',
    'stored_files',
    'documents',
    'document_versions',
    'shifts',
    'assignments',
    'assignment_history',
    'verification_events',
    'verification_overrides'
  ] LOOP
    -- Repeatable in staging: never create duplicate policies.
    EXECUTE format('DROP POLICY IF EXISTS platform_phi_deny ON %I', target_table);
    EXECUTE format(
      'CREATE POLICY platform_phi_deny ON %I AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin())',
      target_table
    );
  END LOOP;
END $$;

-- Caution: Some organization-level analytics need counts from protected
-- tables. Expose aggregates via separately reviewed SECURITY DEFINER
-- functions or precomputed counts, never broad platform SELECT privileges.
-- Audit additional PHI-bearing derivatives, object storage download paths,
-- exports, logs, notifications and Tower endpoints before deployment.
