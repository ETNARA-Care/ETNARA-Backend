CREATE TABLE establishment_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  establishment_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  document_type text NOT NULL,
  title text NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key text NOT NULL UNIQUE,
  issued_on date,
  expires_on date,
  notes text,
  uploaded_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT establishment_documents_expiry_check CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX establishment_documents_idx ON establishment_documents(organization_id, establishment_id) WHERE archived_at IS NULL;
ALTER TABLE establishment_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY establishment_documents_read ON establishment_documents FOR SELECT USING (
 organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
);
CREATE POLICY establishment_documents_insert ON establishment_documents FOR INSERT WITH CHECK (
 organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
);
CREATE POLICY establishment_documents_update ON establishment_documents FOR UPDATE USING (
 organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
) WITH CHECK (
 organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
);
