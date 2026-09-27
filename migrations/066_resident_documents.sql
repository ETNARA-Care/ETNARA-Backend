CREATE TABLE resident_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  establishment_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  care_recipient_id uuid NOT NULL REFERENCES care_recipients(id) ON DELETE CASCADE,
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
  CONSTRAINT resident_documents_expiry_check CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX resident_documents_recipient_idx ON resident_documents(organization_id, establishment_id, care_recipient_id) WHERE archived_at IS NULL;
ALTER TABLE resident_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY resident_documents_establishment_read ON resident_documents FOR SELECT USING (
  organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
);
CREATE POLICY resident_documents_establishment_insert ON resident_documents FOR INSERT WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
  AND EXISTS (SELECT 1 FROM care_recipients cr WHERE cr.id = care_recipient_id AND cr.organization_id = organization_id AND cr.location_id = establishment_id AND cr.archived_at IS NULL)
);
CREATE POLICY resident_documents_establishment_update ON resident_documents FOR UPDATE USING (
  organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
) WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
);
