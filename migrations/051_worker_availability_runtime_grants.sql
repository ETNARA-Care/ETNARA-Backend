-- Migration 051: allow the least-privilege application role to use the
-- worker-availability tables introduced after the baseline grants in 017.
-- Row-level security remains authoritative for which tenant rows are visible
-- or writable; these grants only make the approved operations reachable.

GRANT SELECT, INSERT, UPDATE, DELETE
    ON worker_availability_settings,
       worker_weekly_availability,
       worker_unavailability_periods
    TO app_runtime;
