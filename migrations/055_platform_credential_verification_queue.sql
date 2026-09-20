-- Phase 7.6.1: bind each new platform verification to the exact private
-- document version reviewed. Replacing evidence therefore returns the
-- credential to the verification queue instead of inheriting an old result.

ALTER TABLE credential_platform_verifications
    ADD COLUMN IF NOT EXISTS file_id uuid NULL REFERENCES stored_files(id);

-- Preserve prior decisions by binding each historical verification to the
-- document version that already existed when that decision was recorded.
-- Legacy demo credentials without a document intentionally remain NULL.
UPDATE credential_platform_verifications cpv
SET file_id = (
    SELECT dv.file_id
    FROM document_versions dv
    WHERE dv.document_id = c.document_id
      AND dv.created_at <= cpv.verified_at
    ORDER BY dv.created_at DESC, dv.version DESC
    LIMIT 1
)
FROM credentials c
WHERE cpv.credential_id = c.id
  AND cpv.file_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM document_versions dv
    WHERE dv.document_id = c.document_id
      AND dv.created_at <= cpv.verified_at
  );

CREATE INDEX IF NOT EXISTS idx_credential_platform_verifications_current_file
    ON credential_platform_verifications (credential_id, file_id, verified_at DESC);
