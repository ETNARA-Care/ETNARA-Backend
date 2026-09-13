-- Migration 047: immutable organization review history for each credential
-- document version. Replacing a document never overwrites the evidence or
-- decision attached to an earlier file.

CREATE TABLE organization_document_version_reviews (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations(id),
    credential_id       uuid NOT NULL REFERENCES credentials(id),
    document_id         uuid NOT NULL REFERENCES documents(id),
    file_id             uuid NOT NULL REFERENCES stored_files(id),
    review_status       org_review_status_enum NOT NULL,
    notes               text,
    reviewed_by_user_id uuid NOT NULL REFERENCES users(id),
    reviewed_at         timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_org_document_reviews_file
    ON organization_document_version_reviews (organization_id, file_id, reviewed_at DESC);

ALTER TABLE organization_document_version_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_document_reviews_manager_read
    ON organization_document_version_reviews FOR SELECT
    USING (
        (
            organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
            AND app_is_org_manager()
        )
        OR app_is_superadmin()
    );

CREATE POLICY organization_document_reviews_manager_insert
    ON organization_document_version_reviews FOR INSERT
    WITH CHECK (
        reviewed_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        AND (
            (
                organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
                AND app_is_org_manager()
            )
            OR app_is_superadmin()
        )
    );

GRANT SELECT, INSERT ON organization_document_version_reviews TO app_runtime;
