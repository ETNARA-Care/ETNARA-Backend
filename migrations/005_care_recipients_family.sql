-- Migration 005: Care Recipients & Family Access
-- care_recipients belongs directly to organization_id. There is deliberately
-- NO global person/master-patient identity table anywhere in this schema --
-- two organizations serving the same real human being end up with two fully
-- independent care_recipients rows, with no FK, index, or lookup path that
-- could correlate them. This is a privacy boundary, not an oversight.

CREATE TYPE care_recipient_status_enum AS ENUM (
    'active',
    'archived'
);

CREATE TABLE care_recipients (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    first_name      text NOT NULL,
    last_name       text NOT NULL,
    preferred_name  text,
    date_of_birth   date,
    allergies       text[],
    preferences     jsonb,
    routines        jsonb,
    status          care_recipient_status_enum NOT NULL DEFAULT 'active',
    room_id         uuid NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz NULL,
    UNIQUE (id, organization_id),
    FOREIGN KEY (room_id, organization_id)
        REFERENCES rooms (id, organization_id)
    -- Composite FK: when room_id is set, it MUST belong to a room in the
    -- same organization. When room_id is NULL (home care, no fixed room),
    -- the constraint is simply not evaluated (standard FK NULL behavior).
);
-- Never physically deleted. status='archived' + archived_at is the only
-- lifecycle exit; historical shifts/care_events/etc. must remain resolvable.

CREATE TYPE care_plan_status_enum AS ENUM (
    'active',
    'superseded'
);

CREATE TABLE care_plans (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL,
    care_recipient_id   uuid NOT NULL,
    version             integer NOT NULL,
    plan_details        jsonb,
    effective_from      timestamptz NOT NULL DEFAULT now(),
    effective_to        timestamptz NULL,
    status              care_plan_status_enum NOT NULL DEFAULT 'active',
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by_user_id  uuid REFERENCES users(id),
    FOREIGN KEY (care_recipient_id, organization_id)
        REFERENCES care_recipients (id, organization_id),
    UNIQUE (care_recipient_id, version)
);
-- A new plan is a new row with an incremented version; the previous
-- 'active' row gets effective_to set and status flipped to 'superseded' by
-- application logic. No plan version is ever overwritten in place.

CREATE TYPE family_invitation_status_enum AS ENUM (
    'pending',
    'accepted',
    'expired',
    'revoked'
);

CREATE TABLE family_invitations (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         uuid NOT NULL,
    care_recipient_id       uuid NOT NULL,
    invited_by_user_id      uuid NOT NULL REFERENCES users(id),
    email                   text,
    phone                   text,
    relationship_type       text NOT NULL,
    invitation_token_hash   text NOT NULL UNIQUE,
    -- Only the hash is stored; the raw token is generated and shown to the
    -- inviter/invitee once, never persisted in plain text.
    status                  family_invitation_status_enum NOT NULL DEFAULT 'pending',
    expires_at              timestamptz NOT NULL,
    accepted_at             timestamptz NULL,
    revoked_at              timestamptz NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (care_recipient_id, organization_id)
        REFERENCES care_recipients (id, organization_id),
    CONSTRAINT family_invitations_email_or_phone_required
        CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TYPE family_relationship_status_enum AS ENUM (
    'active',
    'revoked'
);

CREATE TABLE family_relationships (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                         uuid NOT NULL REFERENCES users(id),
    organization_id                 uuid NOT NULL,
    care_recipient_id               uuid NOT NULL,
    invitation_id                   uuid NULL REFERENCES family_invitations(id),
    relationship_type               text NOT NULL,
    is_primary_contact              boolean NOT NULL DEFAULT false,
    can_receive_notifications       boolean NOT NULL DEFAULT true,
    can_view_photos                 boolean NOT NULL DEFAULT true,
    can_participate_in_verification boolean NOT NULL DEFAULT false,
    status                          family_relationship_status_enum NOT NULL DEFAULT 'active',
    created_at                      timestamptz NOT NULL DEFAULT now(),
    revoked_at                      timestamptz NULL,
    FOREIGN KEY (care_recipient_id, organization_id)
        REFERENCES care_recipients (id, organization_id),
    UNIQUE (user_id, care_recipient_id)
    -- One relationship row per (user, care_recipient) pair. A user with
    -- multiple care_recipients (own multiple elders) has multiple rows here;
    -- a care_recipient with multiple family members likewise has multiple
    -- rows. Nothing here limits a user to a single organization either --
    -- that is governed independently by organization_memberships.
);

CREATE TABLE consent_records (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         uuid NOT NULL,
    care_recipient_id       uuid NOT NULL,
    family_relationship_id  uuid NULL REFERENCES family_relationships(id),
    consent_type            text NOT NULL,
    version                 integer NOT NULL,
    granted_at              timestamptz NOT NULL DEFAULT now(),
    revoked_at              timestamptz NULL,
    granted_by_user_id      uuid NOT NULL REFERENCES users(id),
    created_at              timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (care_recipient_id, organization_id)
        REFERENCES care_recipients (id, organization_id)
);
-- Append-only/versioned by design: revoking consent never updates or deletes
-- a prior row -- it inserts a new one (or sets revoked_at on the specific
-- granted row being revoked), preserving the full consent history for audit.
