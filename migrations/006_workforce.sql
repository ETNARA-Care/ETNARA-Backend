-- Migration 006: Workforce
-- workers is a global professional profile (like users) so a worker's
-- identity and documents are not duplicated when they work for more than
-- one organization. Every operational, organization-specific fact about a
-- worker attaches to organization_worker_memberships, not to workers
-- directly.

CREATE TYPE worker_scope_enum AS ENUM (
    'general',
    'clinical'
);

CREATE TABLE workers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NULL UNIQUE REFERENCES users(id),
    -- Nullable: a worker profile can be created by an agency admin before
    -- the person has activated their own login. UNIQUE because at most one
    -- worker profile exists per user account.
    default_scope   worker_scope_enum NOT NULL DEFAULT 'general',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE worker_membership_status_enum AS ENUM (
    'active',
    'inactive'
);

CREATE TABLE organization_worker_memberships (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id       uuid NOT NULL REFERENCES workers(id),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    status          worker_membership_status_enum NOT NULL DEFAULT 'active',
    internal_role   text NOT NULL,
    hired_at        timestamptz NULL,
    ended_at        timestamptz NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (worker_id, organization_id),
    UNIQUE (id, organization_id)
    -- This second unique constraint is the anchor every future tenant-owned
    -- table (assignments, care_events, verification_events, eligibility...)
    -- uses for its composite FK back to "this worker, in this org".
);

CREATE TABLE worker_roles (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_worker_membership_id uuid NOT NULL,
    organization_id                 uuid NOT NULL,
    role_label                      text NOT NULL,
    -- Operational job classification (e.g. 'CNA', 'RN', 'HHA'), distinct
    -- from the RBAC access role in roles/user_roles -- this describes what
    -- the worker does, not what they're permitted to access.
    created_at                      timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id)
);

CREATE TABLE professional_scope (
    id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_worker_membership_id   uuid NOT NULL,
    organization_id                     uuid NOT NULL,
    can_administer_medication           boolean NOT NULL DEFAULT false,
    can_record_vitals                   boolean NOT NULL DEFAULT false,
    created_at                          timestamptz NOT NULL DEFAULT now(),
    updated_at                          timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id),
    UNIQUE (organization_worker_membership_id)
);
-- Prepared but functionally inactive for the MVP: both flags default false
-- and no application flow sets them to true yet. The schema exists now so
-- that activating clinical modules in Phase 2 requires no migration.
