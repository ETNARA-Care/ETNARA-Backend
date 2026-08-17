-- Migration 003: Identity, Memberships & RBAC (CORRECTED)
-- Product roles (PLATFORM_SUPERADMIN, ORGANIZATION_ADMIN, SUPERVISOR, WORKER,
-- FAMILY) are DATA in the `roles` table, not PostgreSQL database roles.

CREATE TYPE user_status_enum AS ENUM (
    'active',
    'disabled'
);

CREATE TYPE membership_status_enum AS ENUM (
    'invited',
    'active',
    'revoked'
);

CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email           text,
    phone           text UNIQUE,
    password_hash   text,
    mfa_enabled     boolean NOT NULL DEFAULT false,
    status          user_status_enum NOT NULL DEFAULT 'active',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_or_phone_required
        CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

-- Case-insensitive uniqueness on email: Maria@email.com and maria@email.com
-- must never coexist as two accounts. The column itself has no UNIQUE
-- constraint (a direct UNIQUE on email would still allow that collision) --
-- uniqueness is enforced instead on lower(email), and only when email is
-- present, so multiple rows with email = NULL (phone-only accounts) remain
-- valid.
CREATE UNIQUE INDEX idx_users_email_lower_unique
    ON users (lower(email))
    WHERE email IS NOT NULL;

CREATE TABLE organization_memberships (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    status          membership_status_enum NOT NULL DEFAULT 'invited',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz NULL,
    -- Stays NULL while status is 'invited' or 'active'. The application sets
    -- this timestamp at the same moment it flips status to 'revoked' --
    -- no trigger yet, per instructions, but the column exists so the
    -- historical "when" is never lost once that logic is added.
    UNIQUE (user_id, organization_id),
    UNIQUE (id, organization_id)
);

CREATE TABLE roles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,
    name        text NOT NULL,
    description text,
    is_system   boolean NOT NULL DEFAULT true,
    -- true for the five official platform roles (PLATFORM_SUPERADMIN,
    -- ORGANIZATION_ADMIN, SUPERVISOR, WORKER, FAMILY). Reserved for a future
    -- phase where organizations might define custom roles (is_system=false);
    -- no such rows are created yet.
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,
    description text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
    role_id       uuid NOT NULL REFERENCES roles(id),
    permission_id uuid NOT NULL REFERENCES permissions(id),
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_membership_id  uuid NOT NULL,
    organization_id             uuid NOT NULL,
    role_id                     uuid NOT NULL REFERENCES roles(id),
    created_at                  timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (organization_membership_id, organization_id)
        REFERENCES organization_memberships (id, organization_id),
    UNIQUE (organization_membership_id, role_id)
);

CREATE TABLE sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id),
    token_hash      text NOT NULL UNIQUE,
    ip_address      inet NULL,
    last_seen_at    timestamptz NULL,
    device_metadata jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz NULL
);
-- No organization_id: a session belongs to the user globally. The active
-- organization context is selected per request/transaction (see 014_rls.sql),
-- never stored on the session row itself.
