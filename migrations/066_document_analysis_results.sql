-- Phase 11.1: assisted document analysis. Analysis is advisory only and never
-- changes credential verification, eligibility or worker activation.

CREATE TYPE document_analysis_status_enum AS ENUM ('pending', 'completed', 'unavailable', 'failed');
CREATE TYPE document_analysis_assessment_enum AS ENUM ('consistent', 'inconsistent', 'uncertain');

CREATE TABLE document_analysis_results (
    id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id               uuid NOT NULL REFERENCES organizations(id),
    credential_id                 uuid NOT NULL REFERENCES credentials(id),
    document_id                   uuid NOT NULL REFERENCES documents(id),
    file_id                       uuid NOT NULL REFERENCES stored_files(id),
    document_version              integer NOT NULL CHECK (document_version > 0),
    analysis_status               document_analysis_status_enum NOT NULL,
    assessment                    document_analysis_assessment_enum NOT NULL,
    selected_credential_type_code text NOT NULL,
    detected_document_type        text,
    confidence                    numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    flags                         jsonb NOT NULL DEFAULT '[]'::jsonb,
    summary                       text NOT NULL,
    analysis_method               text NOT NULL,
    analyzed_by_user_id           uuid NOT NULL REFERENCES users(id),
    analyzed_at                   timestamptz NOT NULL DEFAULT now(),
    created_at                    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, credential_id, file_id)
);

CREATE INDEX idx_document_analysis_current
    ON document_analysis_results (organization_id, credential_id, analyzed_at DESC);

ALTER TABLE document_analysis_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY document_analysis_manager_read
    ON document_analysis_results FOR SELECT
    USING (
        (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager())
        OR app_is_superadmin()
    );

CREATE POLICY document_analysis_manager_insert
    ON document_analysis_results FOR INSERT
    WITH CHECK (
        analyzed_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        AND (
            (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager())
            OR app_is_superadmin()
        )
    );

GRANT SELECT, INSERT ON document_analysis_results TO app_runtime;
