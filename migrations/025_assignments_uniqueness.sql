-- Migration 025: Assignments — prevent duplicate (shift, membership) rows
-- The approved schema has no UNIQUE constraint preventing the same
-- organization_worker_membership from being assigned to the same shift
-- twice. This is a minimal, purely additive safety constraint -- it does
-- not change any existing behavior, column, or relationship; it only
-- rejects a state that was never meaningful in the first place (the same
-- worker assigned twice to the same shift).
ALTER TABLE assignments
    ADD CONSTRAINT assignments_shift_membership_unique
    UNIQUE (shift_id, organization_worker_membership_id);
