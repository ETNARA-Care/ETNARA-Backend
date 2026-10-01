-- Migration 070: repair completed professional credential uploads that were
-- left orphaned from their credential by an earlier upload-completion bug.
--
-- Safety: only ACTIVE PLATFORM_PROFESSIONAL files are eligible, ownership must
-- match the credential's worker, and the storage key must contain both the
-- worker id and credential id. Hidden/incomplete uploads are deliberately not
-- recovered. Future uploads are linked atomically by completeCredentialDocumentUpload.

DO $$
DECLARE
  candidate RECORD;
  repaired_document_id uuid;
BEGIN
  FOR candidate IN
    SELECT DISTINCT ON (c.id)
      c.id AS credential_id,
      c.worker_id,
      c.credential_type_id,
      sf.id AS file_id
    FROM credentials c
    JOIN stored_files sf
      ON sf.owner_worker_id = c.worker_id
     AND sf.scope_type = 'PLATFORM_PROFESSIONAL'
     AND sf.status = 'active'
     AND sf.storage_key LIKE
       ('credentials/' || c.worker_id::text || '/' || c.id::text || '/%')
    WHERE c.document_id IS NULL
      AND c.status <> 'revoked'
    ORDER BY c.id, sf.created_at DESC, sf.id DESC
  LOOP
    INSERT INTO documents (worker_id, credential_type_id, file_id, status)
    VALUES (
      candidate.worker_id,
      candidate.credential_type_id,
      candidate.file_id,
      'presented'
    )
    RETURNING id INTO repaired_document_id;

    INSERT INTO document_versions (document_id, file_id, version)
    VALUES (repaired_document_id, candidate.file_id, 1)
    ON CONFLICT DO NOTHING;

    UPDATE credentials
    SET document_id = repaired_document_id,
        updated_at = now()
    WHERE id = candidate.credential_id
      AND document_id IS NULL;

    -- If a concurrent repair linked the credential first, remove only the
    -- unused document created by this migration iteration.
    IF NOT FOUND THEN
      DELETE FROM document_versions WHERE document_id = repaired_document_id;
      DELETE FROM documents WHERE id = repaired_document_id;
    END IF;
  END LOOP;
END $$;
