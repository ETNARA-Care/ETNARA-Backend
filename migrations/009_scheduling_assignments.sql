-- Migration 009: Scheduling & Assignments
-- Supports both operating models without branching the schema:
--   HOME CARE:    shift targets a care_recipient directly.
--   RESIDENTIAL:  shift targets a room; multiple assignments (workers x
--                 recipients) can exist against the same shift.

CREATE TYPE shift_status_enum AS ENUM (
    'unassigned',
    'confirmed',
    'in_progress',
    'completed',
    'cancelled'
);

CREATE TABLE shifts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations(id),
    care_recipient_id   uuid NULL,
    room_id             uuid NULL,
    scheduled_start     timestamptz NOT NULL,
    scheduled_end       timestamptz NOT NULL,
    status              shift_status_enum NOT NULL DEFAULT 'unassigned',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, organization_id),
    FOREIGN KEY (care_recipient_id, organization_id)
        REFERENCES care_recipients (id, organization_id),
    FOREIGN KEY (room_id, organization_id)
        REFERENCES rooms (id, organization_id),
    CONSTRAINT shifts_target_required
        CHECK (care_recipient_id IS NOT NULL OR room_id IS NOT NULL)
    -- A shift must target something: a specific care recipient (home care)
    -- or a room (residential, where multiple recipients may be involved via
    -- assignments below).
);

CREATE TABLE assignments (
    id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id                     uuid NOT NULL,
    shift_id                            uuid NOT NULL,
    organization_worker_membership_id   uuid NOT NULL,
    care_recipient_id                   uuid NULL,
    role_in_shift                       text,
    created_at                          timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (shift_id, organization_id)
        REFERENCES shifts (id, organization_id),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id),
    FOREIGN KEY (care_recipient_id, organization_id)
        REFERENCES care_recipients (id, organization_id)
    -- These two composite FKs together are what make "shift from Org A +
    -- worker membership from Org B" structurally impossible: both parent
    -- rows are required to carry the SAME organization_id as this row, or
    -- PostgreSQL rejects the insert outright. No trigger, no application
    -- check required to guarantee this specific invariant.
);

CREATE TABLE assignment_history (
    id                                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id                             uuid NOT NULL,
    assignment_id                               uuid NOT NULL REFERENCES assignments(id),
    previous_organization_worker_membership_id  uuid NULL,
    new_organization_worker_membership_id       uuid NULL,
    reason                                      text,
    changed_by_user_id                          uuid REFERENCES users(id),
    occurred_at                                 timestamptz NOT NULL DEFAULT now()
);
-- Append-only: every reassignment is a new row here, never an update to a
-- previous history entry.
