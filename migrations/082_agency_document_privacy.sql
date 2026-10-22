-- Agency-owned document authority. Platform operators cannot read or mutate tenant files.
-- Apply only after isolated PostgreSQL security tests and review of existing policies.
DO $$
DECLARE t text; prefix text; scope_expr text;
BEGIN
  FOREACH t IN ARRAY ARRAY['establishment_documents','resident_documents'] LOOP
    IF t = 'establishment_documents' THEN
      prefix := 'establishment_documents';
    ELSE
      prefix := 'resident_documents_establishment';
    END IF;
    scope_expr := 'organization_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid AND NOT app_is_superadmin() AND (app_is_org_manager() OR app_is_establishment_admin(establishment_id))';
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = t AND permissive = 'PERMISSIVE' AND policyname NOT IN (prefix || '_read', prefix || '_insert', prefix || '_update')) THEN
      RAISE EXCEPTION 'Unexpected permissive policy on %: review before changing document permissions', t;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', prefix || '_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', prefix || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', prefix || '_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', prefix || '_read', t, scope_expr);
    IF t = 'resident_documents' THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s AND EXISTS (SELECT 1 FROM care_recipients cr WHERE cr.id = care_recipient_id AND cr.organization_id = organization_id AND cr.location_id = establishment_id AND cr.archived_at IS NULL))', prefix || '_insert', t, scope_expr);
    ELSE
      EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', prefix || '_insert', t, scope_expr);
    END IF;
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', prefix || '_update', t, scope_expr, scope_expr);
    EXECUTE format('DROP POLICY IF EXISTS platform_document_deny ON %I', t);
    EXECUTE format('CREATE POLICY platform_document_deny ON %I AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin())', t);

  END LOOP;
END $$;
