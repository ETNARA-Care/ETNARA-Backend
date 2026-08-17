-- Migration 008: Credentialing & Eligibility
-- Philosophy enforced structurally, not just by convention:
--   Credential            -> belongs to the worker (global, no organization_id)
--   Platform Verification -> belongs to the platform (global, no organization_id)
--   Organization Review   -> belongs to a specific organization
--   Eligibility           -> belongs to a specific organization_worker_membership

CREATE TABLE credential_types (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code            text NOT NULL UNIQUE,
    name            text NOT NULL,
    description     text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
-- Deliberately a table, not an enum: this catalog is extensible by design.
-- LEY_300 is one row among others here -- never hardcoded in application
-- logic. Seed values inserted in 016_seeds.sql.

CREATE TYPE document_status_enum AS ENUM (
    'presented',
    'verified',
    'rejected'
);

CREATE TABLE documents (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id           uuid NOT NULL REFERENCES workers(id),
    credential_type_id  uuid NOT NULL REFERENCES credential_types(id),
    file_id             uuid NOT NULL REFERENCES stored_files(id),
    -- file_id must point to a stored_files row with scope_type =
    -- 'PLATFORM_PROFESSIONAL' -- enforced at application level (a DB-level
    -- CHECK against another table's column requires a trigger, which is
    -- avoided here per the "prefer declarative" instruction; documented as
    -- an application-layer invariant instead).
    status              document_status_enum NOT NULL DEFAULT 'presented',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_versions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     uuid NOT NULL REFERENCES documents(id),
    file_id         uuid NOT NULL REFERENCES stored_files(id),
    version         integer NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (document_id, version)
);
-- Every re-upload is a new row here; documents.file_id / status reflect the
-- current version, but no prior version row is ever overwritten.

CREATE TYPE issuing_entity_type_enum AS ENUM (
    'government',
    'external_provider',
    'platform'
);

CREATE TYPE credential_status_enum AS ENUM (
    'active',
    'expired',
    'revoked'
);

CREATE TABLE credentials (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id           uuid NOT NULL REFERENCES workers(id),
    credential_type_id  uuid NOT NULL REFERENCES credential_types(id),
    document_id         uuid NULL REFERENCES documents(id),
    issuing_entity_name text,
    issuing_entity_type issuing_entity_type_enum NOT NULL,
    issued_at           date,
    expires_at          date,
    status              credential_status_enum NOT NULL DEFAULT 'active',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
-- No organization_id: the credential itself (e.g. María's CPR card) is a
-- fact about María, not about any single organization she has worked for.

CREATE TYPE platform_verification_status_enum AS ENUM (
    'verified',
    'rejected'
);

CREATE TABLE credential_platform_verifications (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    credential_id       uuid NOT NULL REFERENCES credentials(id),
    verified_by_user_id uuid NOT NULL REFERENCES users(id),
    verified_at         timestamptz NOT NULL DEFAULT now(),
    status              platform_verification_status_enum NOT NULL,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now()
);
-- No organization_id, by design: once the platform verifies a credential,
-- that verification is reusable by every organization the worker joins --
-- nobody has to repeat work the platform already did.

CREATE TYPE org_review_status_enum AS ENUM (
    'pending',
    'approved',
    'rejected'
);

CREATE TABLE organization_credential_reviews (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    credential_id       uuid NOT NULL REFERENCES credentials(id),
    organization_id     uuid NOT NULL REFERENCES organizations(id),
    reviewed_by_user_id uuid NOT NULL REFERENCES users(id),
    review_status       org_review_status_enum NOT NULL DEFAULT 'pending',
    reviewed_at         timestamptz,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now()
);
-- organization_id here is what keeps Organization A's private review notes
-- invisible to Organization B (enforced later by RLS in 014).

CREATE TABLE requirement_sets (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NULL REFERENCES organizations(id),
    -- NULL = platform-wide global requirement set; a value here scopes it
    -- to one organization's own policy.
    worker_role         text,
    organization_type   organization_type_enum,
    jurisdiction         text,
    service_type        text,
    name                text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE requirements (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requirement_set_id          uuid NOT NULL REFERENCES requirement_sets(id),
    credential_type_id          uuid NOT NULL REFERENCES credential_types(id),
    is_mandatory                boolean NOT NULL DEFAULT true,
    requires_organization_review boolean NOT NULL DEFAULT false,
    created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE eligibility_rules (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requirement_set_id  uuid NOT NULL REFERENCES requirement_sets(id),
    rule_conditions     jsonb,
    -- Non-critical, non-reportable supplementary conditions only; the core
    -- pass/fail logic runs off requirements (structured rows), not JSONB.
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE eligibility_status_enum AS ENUM (
    'eligible',
    'not_eligible',
    'pending',
    'suspended',
    'expired',
    'action_required'
);

CREATE TABLE worker_eligibility (
    id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_worker_membership_id   uuid NOT NULL,
    organization_id                     uuid NOT NULL,
    requirement_set_id                  uuid NOT NULL REFERENCES requirement_sets(id),
    eligibility_status                  eligibility_status_enum NOT NULL DEFAULT 'pending',
    computed_at                         timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id),
    UNIQUE (organization_worker_membership_id, requirement_set_id)
);
-- Keyed on the membership, not on worker_id alone: the same person can be
-- eligible in Organization A and not-yet-eligible in Organization B at the
-- exact same time, because their requirements and reviews differ.
