-- Migration 010: Visit Verification
-- verification_events is append-only: a check-in is never edited to "fix"
-- it -- any correction is a new, separate auditable action (an override
-- row, or a new event), never an UPDATE to the original.

CREATE TABLE verification_methods (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
-- Global catalog table, not an enum -- extensible for GPS/GEOFENCE/QR/NFC
-- later without a migration. Seed values (PIN, SUPERVISOR_OVERRIDE) in
-- 016_seeds.sql. Future methods' logic is not implemented yet, only the
-- catalog slot for them.

CREATE TYPE verification_event_type_enum AS ENUM (
    'check_in',
    'check_out'
);

CREATE TABLE verification_events (
    id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id                     uuid NOT NULL,
    shift_id                            uuid NOT NULL,
    organization_worker_membership_id   uuid NOT NULL,
    verification_method_id              uuid NOT NULL REFERENCES verification_methods(id),
    event_type                          verification_event_type_enum NOT NULL,
    occurred_at                         timestamptz NOT NULL DEFAULT now(),
    actor_user_id                       uuid NULL REFERENCES users(id),
    -- Who provided the verification (e.g. the family member who gave the
    -- PIN) -- nullable because not every method has a distinguishable human
    -- actor (e.g. a future GPS-only method).
    actor_context                       text,
    location_lat                        numeric,
    location_lng                        numeric,
    created_at                          timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (shift_id, organization_id)
        REFERENCES shifts (id, organization_id),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id)
);
-- No updated_at column at all: this table is immutable by omission, not
-- just by convention -- there is structurally nothing to "update" toward.

CREATE TABLE verification_overrides (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    verification_event_id   uuid NOT NULL REFERENCES verification_events(id),
    organization_id         uuid NOT NULL,
    authorized_by_user_id   uuid NOT NULL REFERENCES users(id),
    reason                  text NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now()
);
-- A separate table, not a nullable column on verification_events: an
-- override is an additional auditable action layered on top of an event,
-- never a modification of the event itself.
