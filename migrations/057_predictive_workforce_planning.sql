-- Phase 7.7: predictive workforce planning
-- A shift needs an explicit operational role so future demand can be compared
-- with real eligible workforce capacity. Existing shifts inherit the role of
-- their latest active assignment when possible and otherwise remain general.

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS required_role text;

UPDATE shifts s
SET required_role = COALESCE(
  (
    SELECT NULLIF(trim(COALESCE(a.role_in_shift, owm.internal_role)), '')
    FROM assignments a
    JOIN organization_worker_memberships owm
      ON owm.id = a.organization_worker_membership_id
     AND owm.organization_id = a.organization_id
    WHERE a.shift_id = s.id
      AND a.response_status IN ('accepted', 'pending')
    ORDER BY (a.response_status = 'accepted') DESC, a.created_at DESC
    LIMIT 1
  ),
  'Cuidador/a'
)
WHERE required_role IS NULL;

ALTER TABLE shifts
  ALTER COLUMN required_role SET DEFAULT 'Cuidador/a',
  ALTER COLUMN required_role SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shifts_required_role_nonempty'
  ) THEN
    ALTER TABLE shifts
      ADD CONSTRAINT shifts_required_role_nonempty
      CHECK (length(trim(required_role)) BETWEEN 1 AND 80);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shifts_org_start_required_role
  ON shifts (organization_id, scheduled_start, required_role)
  WHERE status != 'cancelled';
