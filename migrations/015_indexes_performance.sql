-- Migration 015: Indexes & Performance
-- Every organization_id and FK column used in an RLS predicate or a
-- composite FK gets an index by default -- those are called out only when
-- the reasoning is non-obvious. Comments focus on the indexes that
-- wouldn't be assumed automatically.

-- Organization-scoped lookups (the single most common filter in the whole
-- system, since almost every RLS policy filters on organization_id first)
CREATE INDEX idx_care_recipients_organization_id ON care_recipients (organization_id);
CREATE INDEX idx_organization_worker_memberships_organization_id ON organization_worker_memberships (organization_id);
CREATE INDEX idx_shifts_organization_id ON shifts (organization_id);
CREATE INDEX idx_care_events_organization_id ON care_events (organization_id);
CREATE INDEX idx_observations_organization_id ON observations (organization_id);
CREATE INDEX idx_incidents_organization_id ON incidents (organization_id);
CREATE INDEX idx_messages_organization_id ON messages (organization_id);

-- Scheduling: the calendar view queries by date range constantly.
CREATE INDEX idx_shifts_scheduled_start ON shifts (organization_id, scheduled_start);
-- Composite with organization_id (not scheduled_start alone) because every
-- real query already filters by org -- an index that leads with org_id lets
-- Postgres use a single index scan instead of a filter step afterward.

CREATE INDEX idx_shifts_care_recipient_id ON shifts (care_recipient_id) WHERE care_recipient_id IS NOT NULL;
-- Partial: room-only (residential) shifts have NULL here and would
-- otherwise bloat the index with entries nobody queries by this column.

-- Assignments / worker lookups
CREATE INDEX idx_assignments_organization_worker_membership_id
    ON assignments (organization_worker_membership_id);
-- Supports "what is this worker assigned to today" -- the query the
-- caregiver's own "Mi turno de hoy" screen runs on every app open.

CREATE INDEX idx_assignments_shift_id ON assignments (shift_id);

-- Visit verification: feed and reporting both query by shift and by time.
CREATE INDEX idx_verification_events_shift_id ON verification_events (shift_id);
CREATE INDEX idx_verification_events_occurred_at ON verification_events (organization_id, occurred_at DESC);

-- Care events: the family feed query is "all events for this recipient,
-- ordered by time" -- this is the single most frequently run query in the
-- entire family-facing product.
CREATE INDEX idx_care_events_care_recipient_occurred
    ON care_events (care_recipient_id, occurred_at DESC);
CREATE INDEX idx_care_events_shift_id ON care_events (shift_id);

-- Credentialing: expiration lookups drive the proactive alert job (30/15/3
-- day warnings) -- without this, that job does a full table scan on every run.
CREATE INDEX idx_credentials_expires_at ON credentials (expires_at) WHERE expires_at IS NOT NULL;

-- Eligibility status: the dashboard "who is not yet eligible" view filters
-- directly on this.
CREATE INDEX idx_worker_eligibility_status
    ON worker_eligibility (organization_id, eligibility_status);

-- Incident status: supervisor dashboards filter open/in_progress incidents
-- constantly; resolved ones are queried far less often, so a partial index
-- keeps this small.
CREATE INDEX idx_incidents_open_status
    ON incidents (organization_id, status)
    WHERE status IN ('open', 'in_progress');

-- Messaging: participants table is the access-control join for every
-- message read -- this index is what keeps that join cheap.
CREATE INDEX idx_message_thread_participants_user_id
    ON message_thread_participants (user_id);
CREATE INDEX idx_messages_thread_id ON messages (message_thread_id);

-- Notifications: "unread notifications for me" is polled/queried constantly
-- by client apps.
CREATE INDEX idx_notifications_user_unread
    ON notifications (user_id, read_at)
    WHERE read_at IS NULL;
-- Partial + explicit read_at IS NULL: once read, a notification almost
-- never needs to be found by this predicate again, so excluding read rows
-- keeps this index small indefinitely rather than growing forever.

-- Stored files: professional-scope access check (used by RLS on every file
-- read) benefits directly from this.
CREATE INDEX idx_stored_files_owner_worker_id
    ON stored_files (owner_worker_id) WHERE owner_worker_id IS NOT NULL;
CREATE INDEX idx_stored_files_organization_id
    ON stored_files (organization_id) WHERE organization_id IS NOT NULL;

-- No indiscriminate indexing: columns like `note_text`, `structured_data`,
-- `description`, and other free-text/JSONB fields are NOT indexed here --
-- none of the MVP's query patterns filter or sort on them, and a GIN index
-- on structured_data would add write overhead with no read benefit yet.
