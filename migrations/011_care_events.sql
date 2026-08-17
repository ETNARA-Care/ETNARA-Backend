-- Migration 011: Care Events
-- One extensible model instead of seven parallel tables for feeding,
-- hydration, toileting, mobility, activity, mood, and notes.

CREATE TABLE care_event_types (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
-- Global catalog, not an enum: new types (SLEEP, PERSONAL_HYGIENE, ...) can
-- be added later as new rows, with zero migrations and zero risk to
-- existing care_events rows. Seed values in 016_seeds.sql.

CREATE TABLE organization_care_event_types (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations(id),
    care_event_type_id  uuid NOT NULL REFERENCES care_event_types(id),
    is_enabled          boolean NOT NULL DEFAULT true,
    label_override      text,
    display_order       integer,
    is_required          boolean NOT NULL DEFAULT false,
    UNIQUE (organization_id, care_event_type_id)
);
-- Per-organization configuration layer only -- enabling/disabling/relabeling
-- a global type. Not a place to invent brand-new arbitrary types for the
-- MVP; that remains a Phase 2 decision that would extend this design, not
-- replace it.

CREATE TABLE care_events (
    id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id                     uuid NOT NULL,
    shift_id                            uuid NOT NULL,
    care_recipient_id                   uuid NOT NULL,
    organization_worker_membership_id   uuid NOT NULL,
    care_event_type_id                  uuid NOT NULL REFERENCES care_event_types(id),
    occurred_at                         timestamptz NOT NULL DEFAULT now(),
    note_text                           text,
    structured_data                     jsonb,
    -- Reserved for type-specific, non-critical metadata only (e.g.
    -- {"amount_consumed": "80%"} for MEAL, {"duration_minutes": 15} for
    -- ACTIVITY). Anything that needs to be validated, aggregated in SQL, or
    -- guaranteed structurally belongs in a dedicated column or a
    -- specialized table -- not buried here.
    created_at                          timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (shift_id, organization_id)
        REFERENCES shifts (id, organization_id),
    FOREIGN KEY (care_recipient_id, organization_id)
        REFERENCES care_recipients (id, organization_id),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id)
);

CREATE TABLE care_event_photos (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         uuid NOT NULL,
    care_event_id           uuid NOT NULL REFERENCES care_events(id),
    file_id                 uuid NOT NULL REFERENCES stored_files(id),
    -- file_id must reference a stored_files row with scope_type =
    -- 'ORGANIZATION_OPERATIONAL' (application-level invariant, same
    -- reasoning as in 008_credentialing.sql for documents.file_id).
    consent_verified_at     timestamptz,
    -- Snapshot of when consent was confirmed valid at capture time -- not
    -- recalculated later even if consent is subsequently revoked, so the
    -- historical record of "was this lawful when taken" stays accurate.
    created_at              timestamptz NOT NULL DEFAULT now()
);
