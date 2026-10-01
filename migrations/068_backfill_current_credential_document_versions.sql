-- ETNARA Compliance hotfix: make already-uploaded credential evidence visible
-- to the platform verification queue when a historical document row points to
-- an active file but the matching document_versions row is missing.
--
-- The platform queue intentionally joins the current documents.file_id to
-- document_versions so ETNARA verifies the exact evidence version. We repair
-- only that missing audit link; no credential is approved or verified here.

WITH missing_current_versions AS (
  SELECT
    d.id AS document_id,
    d.file_id,
    COALESCE((
      SELECT MAX(existing.version)
      FROM document_versions existing
      WHERE existing.document_id = d.id
    ), 0) + 1 AS next_version
  FROM documents d
  JOIN credentials c ON c.document_id = d.id
  JOIN stored_files sf ON sf.id = d.file_id AND sf.status = 'active'
  WHERE d.file_id IS NOT NULL
    AND c.status <> 'revoked'
    AND NOT EXISTS (
      SELECT 1
      FROM document_versions current_version
      WHERE current_version.document_id = d.id
        AND current_version.file_id = d.file_id
    )
)
INSERT INTO document_versions (document_id, file_id, version)
SELECT document_id, file_id, next_version
FROM missing_current_versions;
