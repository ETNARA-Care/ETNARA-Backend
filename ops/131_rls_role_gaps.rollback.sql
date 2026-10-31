-- Rollback of 131 (RLS role gaps). Policies and functions only; no data is changed.
-- Restores the three policies to FOR ALL with their previous USING clause (as of 129).
BEGIN;
DROP POLICY IF EXISTS verification_events_worker_late_offline_check_in ON verification_events;
DROP POLICY IF EXISTS shifts_worker_open_visit_status ON shifts;
DROP POLICY IF EXISTS shifts_worker_own_history_read ON shifts;
DROP POLICY IF EXISTS verification_events_worker_own_read ON verification_events;
DROP POLICY IF EXISTS care_events_worker_own_read ON care_events;
DROP POLICY IF EXISTS care_recipients_establishment_admin ON care_recipients;
DROP POLICY IF EXISTS shifts_establishment_admin_read ON shifts;
DROP POLICY IF EXISTS shifts_establishment_admin_insert ON shifts;
DROP POLICY IF EXISTS assignments_establishment_admin_insert ON assignments;
DROP POLICY IF EXISTS assignments_establishment_admin_delete ON assignments;
DROP POLICY IF EXISTS notifications_insert_establishment_assignment ON notifications;
DROP POLICY IF EXISTS care_recipients_family_specific ON care_recipients;
CREATE POLICY care_recipients_family_specific ON care_recipients FOR ALL USING (((organization_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::uuid) AND app_has_active_membership() AND (EXISTS ( SELECT 1 FROM family_relationships fr WHERE ((fr.care_recipient_id = care_recipients.id) AND (fr.organization_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::uuid) AND (fr.user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''::text))::uuid) AND (fr.status = 'active'::family_relationship_status_enum))))));
DROP POLICY IF EXISTS care_recipients_worker_assigned_only ON care_recipients;
CREATE POLICY care_recipients_worker_assigned_only ON care_recipients FOR ALL USING (((organization_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::uuid) AND app_worker_has_recipient_assignment(id)));
DROP POLICY IF EXISTS care_events_family_specific ON care_events;
CREATE POLICY care_events_family_specific ON care_events FOR ALL USING (((organization_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::uuid) AND (EXISTS ( SELECT 1 FROM family_relationships fr WHERE ((fr.care_recipient_id = care_events.care_recipient_id) AND (fr.organization_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::uuid) AND (fr.user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''::text))::uuid) AND (fr.status = 'active'::family_relationship_status_enum))))));
DROP FUNCTION IF EXISTS app_my_shift_recipient_display_name(uuid);
DROP FUNCTION IF EXISTS app_establishment_admin_for_shift(uuid);
DROP FUNCTION IF EXISTS app_establishment_admin_for_recipient(uuid);
DROP FUNCTION IF EXISTS app_worker_own_shift(uuid);
DROP FUNCTION IF EXISTS app_worker_late_offline_check_in(uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS app_worker_open_visit(uuid);
DELETE FROM schema_migrations WHERE filename = '131_rls_role_gaps.sql';
COMMIT;
