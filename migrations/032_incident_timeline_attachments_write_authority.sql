-- Migration 032: incident_timeline_entries + incident_attachments write authority
-- SECURITY ISSUE FOUND during Observations + Incidents gate inspection,
-- confirmed via direct execution: unlike their parent tables (incidents,
-- hardened in 018 to require org-manager authority OR a real worker
-- assignment to the recipient), incident_timeline_entries and
-- incident_attachments were left on the original 014 simple tenant_isolation
-- policy -- organization_id match only, no role or assignment check. A
-- plain org member with NO assignment to the recipient and NO manager role
-- could insert a fabricated timeline entry on ANY incident in the org.
--
-- Fix: give both child tables the exact same authority as their parent
-- `incidents` row -- manager/supervisor full-tenant, or a worker who has a
-- real assignment to that specific incident's care_recipient_id. Read
-- visibility is unchanged (same condition, just no longer also granted to
-- unrelated staff for writes).

DROP POLICY IF EXISTS incident_timeline_entries_tenant_isolation ON incident_timeline_entries;

CREATE POLICY incident_timeline_entries_via_incident ON incident_timeline_entries
    FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR EXISTS (
                SELECT 1 FROM incidents i
                WHERE i.id = incident_timeline_entries.incident_id
                  AND i.organization_id = incident_timeline_entries.organization_id
                  AND app_worker_has_recipient_assignment(i.care_recipient_id)
            )
        )
        OR app_is_superadmin()
    )
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR EXISTS (
                SELECT 1 FROM incidents i
                WHERE i.id = incident_timeline_entries.incident_id
                  AND i.organization_id = incident_timeline_entries.organization_id
                  AND app_worker_has_recipient_assignment(i.care_recipient_id)
            )
        )
        OR app_is_superadmin()
    );

DROP POLICY IF EXISTS incident_attachments_tenant_isolation ON incident_attachments;

CREATE POLICY incident_attachments_via_incident ON incident_attachments
    FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR EXISTS (
                SELECT 1 FROM incidents i
                WHERE i.id = incident_attachments.incident_id
                  AND i.organization_id = incident_attachments.organization_id
                  AND app_worker_has_recipient_assignment(i.care_recipient_id)
            )
        )
        OR app_is_superadmin()
    )
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR EXISTS (
                SELECT 1 FROM incidents i
                WHERE i.id = incident_attachments.incident_id
                  AND i.organization_id = incident_attachments.organization_id
                  AND app_worker_has_recipient_assignment(i.care_recipient_id)
            )
        )
        OR app_is_superadmin()
    );
