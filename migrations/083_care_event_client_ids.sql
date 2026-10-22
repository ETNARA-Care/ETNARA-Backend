-- Phase 12.0: offline-safe care documentation.
--
-- A caregiver's phone may lose signal while recording care. The app keeps
-- the record in memory and retries when the connection returns. Two things
-- make that safe:
--
--   1. client_event_id: a UUID generated on the device for each record. A
--      retry of a record the server already stored returns the existing row
--      instead of inserting a duplicate.
--   2. occurred_at supplied by the client (validated in the service against
--      the active visit window) so a late upload keeps the real time.
--
-- Additive only: a nullable column and a partial unique index. Existing rows
-- keep client_event_id = NULL and are untouched. RLS policies on care_events
-- are unchanged; uniqueness is scoped to the organization and the worker
-- membership, so one tenant or worker can never collide with, or probe for,
-- another's identifiers.

ALTER TABLE care_events ADD COLUMN IF NOT EXISTS client_event_id uuid NULL;

CREATE UNIQUE INDEX IF NOT EXISTS care_events_client_event_unique
    ON care_events (organization_id, organization_worker_membership_id, client_event_id)
    WHERE client_event_id IS NOT NULL;
