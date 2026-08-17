-- Migration 007: Stored Files
-- Central metadata table for every file in the platform. No binary content
-- ever lives in PostgreSQL -- only a storage_key pointing at object storage
-- (provider left unspecified/abstract by design).

CREATE TYPE file_scope_enum AS ENUM (
    'PLATFORM_PROFESSIONAL',
    'ORGANIZATION_OPERATIONAL'
);

CREATE TYPE file_status_enum AS ENUM (
    'active',
    'hidden'
);

CREATE TABLE stored_files (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_type          file_scope_enum NOT NULL,
    owner_worker_id     uuid NULL REFERENCES workers(id),
    organization_id     uuid NULL REFERENCES organizations(id),
    storage_key         text NOT NULL UNIQUE,
    content_type        text NOT NULL,
    original_filename   text NOT NULL,
    size_bytes          bigint NOT NULL,
    checksum            text,
    uploaded_by_user_id uuid NOT NULL REFERENCES users(id),
    visibility          text NOT NULL DEFAULT 'private',
    status              file_status_enum NOT NULL DEFAULT 'active',
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT stored_files_scope_ownership_check
        CHECK (
            (scope_type = 'PLATFORM_PROFESSIONAL'
                AND owner_worker_id IS NOT NULL
                AND organization_id IS NULL)
            OR
            (scope_type = 'ORGANIZATION_OPERATIONAL'
                AND organization_id IS NOT NULL
                AND owner_worker_id IS NULL)
        )
    -- Exactly one owner column populated, determined by scope_type. Never
    -- both, never neither -- this single constraint is what makes file
    -- ownership structurally unambiguous rather than convention-based.
);
-- status='hidden' rather than a physical DELETE: the audit trail (which
-- referenced this file, when) must survive even if the underlying object is
-- later removed from storage or access is revoked.
