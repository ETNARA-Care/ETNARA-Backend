-- Migration 013: Messages & Notifications
-- Message = human-to-human communication. Notification = system-generated
-- alert. The two are never merged into a single table, and organization
-- membership alone never grants access to a thread -- only explicit
-- participation does (message_thread_participants).

CREATE TABLE message_threads (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations(id),
    care_recipient_id   uuid NULL,
    thread_type         text NOT NULL DEFAULT 'family_agency',
    -- 'family_agency' for the MVP; 'caregiver_agency' reserved for Phase 2,
    -- same table, no migration needed to add it.
    created_at          timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (care_recipient_id, organization_id)
        REFERENCES care_recipients (id, organization_id)
);

CREATE TABLE message_thread_participants (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL,
    message_thread_id   uuid NOT NULL REFERENCES message_threads(id),
    user_id             uuid NOT NULL REFERENCES users(id),
    can_write            boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (message_thread_id, user_id)
);
-- This table is the entire access-control mechanism for messaging: a user
-- who belongs to the organization but has no row here for a given thread
-- has zero visibility into it, enforced later by RLS in 014.

CREATE TABLE messages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL,
    message_thread_id   uuid NOT NULL REFERENCES message_threads(id),
    sender_user_id      uuid NOT NULL REFERENCES users(id),
    body                text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);
-- Append-only: no updated_at, messages are not edited after sending in the
-- MVP.

CREATE TABLE notifications (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NULL,
    -- Nullable: some notifications are platform-level, not tied to one org.
    user_id             uuid NOT NULL REFERENCES users(id),
    notification_type   text NOT NULL,
    related_entity_type text,
    related_entity_id   uuid,
    channel             text NOT NULL,
    status               text NOT NULL DEFAULT 'pending',
    created_at          timestamptz NOT NULL DEFAULT now(),
    sent_at             timestamptz NULL,
    read_at             timestamptz NULL
);
