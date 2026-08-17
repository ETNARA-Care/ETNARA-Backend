-- Migration 012: Observations & Incidents
-- Two related but distinct entities: an Observation is a non-urgent signal
-- a family/agency should be able to track over time; an Incident is a
-- formal event requiring follow-up. An Observation MAY escalate to an
-- Incident, but never the other way, and the two are never merged into one
-- table.

CREATE TYPE observation_category_enum AS ENUM (
    'low_appetite',
    'drowsiness',
    'confusion',
    'pain',
    'behavior_change',
    'reduced_mobility',
    'elimination_change',
    'emotional_state',
    'other'
);
-- Small, stable, product-defined vocabulary -- a good fit for an enum
-- (unlike credential_types or care_event_types, which are meant to grow).

CREATE TYPE observation_status_enum AS ENUM (
    'open',
    'reviewed',
    'escalated'
);

CREATE TABLE observations (
    id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id                     uuid NOT NULL,
    care_recipient_id                   uuid NOT NULL,
    organization_worker_membership_id   uuid NOT NULL,
    care_event_id                       uuid NULL REFERENCES care_events(id),
    category                            observation_category_enum NOT NULL,
    description                         text,
    status                              observation_status_enum NOT NULL DEFAULT 'open',
    created_at                          timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (care_recipient_id, organization_id)
        REFERENCES care_recipients (id, organization_id),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id)
);

CREATE TYPE incident_status_enum AS ENUM (
    'open',
    'in_progress',
    'resolved'
);

CREATE TABLE incidents (
    id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id                     uuid NOT NULL,
    care_recipient_id                   uuid NOT NULL,
    organization_worker_membership_id   uuid NOT NULL,
    escalated_from_observation_id       uuid NULL REFERENCES observations(id),
    severity                            text NOT NULL,
    description                         text NOT NULL,
    actions_taken                       text,
    assigned_to_user_id                 uuid REFERENCES users(id),
    resolution                          text,
    status                              incident_status_enum NOT NULL DEFAULT 'open',
    created_at                          timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (care_recipient_id, organization_id)
        REFERENCES care_recipients (id, organization_id),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id)
);
-- Never deleted, ever -- not even soft-deleted. An incident is part of the
-- permanent historical record of the care relationship.

CREATE TABLE incident_timeline_entries (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL,
    incident_id         uuid NOT NULL REFERENCES incidents(id),
    entry_text          text NOT NULL,
    created_by_user_id  uuid REFERENCES users(id),
    occurred_at         timestamptz NOT NULL DEFAULT now()
);
-- Append-only follow-up log: each update to an incident's story is a new
-- row here, never an edit to incidents.description or a previous entry.

CREATE TABLE incident_attachments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    incident_id     uuid NOT NULL REFERENCES incidents(id),
    file_id         uuid NOT NULL REFERENCES stored_files(id),
    -- Expected scope_type = 'ORGANIZATION_OPERATIONAL' (application-level
    -- invariant).
    created_at      timestamptz NOT NULL DEFAULT now()
);
