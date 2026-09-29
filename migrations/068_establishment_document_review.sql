ALTER TABLE establishment_documents
  ADD COLUMN review_status text NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending','approved','rejected')),
  ADD COLUMN reviewed_by_user_id uuid REFERENCES users(id),
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN review_reason text;

CREATE INDEX establishment_documents_review_idx
  ON establishment_documents(organization_id, establishment_id, review_status)
  WHERE archived_at IS NULL;

ALTER TABLE establishment_documents
  ADD CONSTRAINT establishment_documents_review_metadata_check CHECK (
    (review_status = 'pending' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
    OR
    (review_status IN ('approved','rejected') AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
  );
