-- Phase 9.2: immutable audit history for manager-requested coverage briefings.
CREATE TABLE coverage_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  generated_at timestamptz NOT NULL DEFAULT now(),
  uncovered_shift_count integer NOT NULL CHECK (uncovered_shift_count >= 0),
  urgent_shift_count integer NOT NULL CHECK (urgent_shift_count >= 0),
  actionable_shift_count integer NOT NULL CHECK (actionable_shift_count >= 0),
  priority_shift_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT coverage_agent_priority_ids_array
    CHECK (jsonb_typeof(priority_shift_ids) = 'array')
);

CREATE INDEX idx_coverage_agent_runs_org_generated
  ON coverage_agent_runs (organization_id, generated_at DESC);

ALTER TABLE coverage_agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY coverage_agent_runs_manager_read
  ON coverage_agent_runs FOR SELECT
  USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
  );
GRANT SELECT ON coverage_agent_runs TO app_runtime;

CREATE OR REPLACE FUNCTION app_record_coverage_agent_run(
  p_organization_id uuid,
  p_uncovered_shift_count integer,
  p_urgent_shift_count integer,
  p_actionable_shift_count integer,
  p_priority_shift_ids jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
  v_run_id uuid;
BEGIN
  v_user_id := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  IF p_organization_id IS DISTINCT FROM NULLIF(current_setting('app.current_org_id', true), '')::uuid
     OR v_user_id IS NULL
     OR NOT app_is_org_manager()
  THEN
    RAISE EXCEPTION 'coverage agent forbidden';
  END IF;

  IF p_uncovered_shift_count < 0
     OR p_urgent_shift_count < 0
     OR p_actionable_shift_count < 0
     OR p_urgent_shift_count > p_uncovered_shift_count
     OR p_actionable_shift_count > p_uncovered_shift_count
     OR jsonb_typeof(p_priority_shift_ids) <> 'array'
     OR jsonb_array_length(p_priority_shift_ids) > 5
  THEN
    RAISE EXCEPTION 'invalid coverage agent snapshot';
  END IF;

  INSERT INTO coverage_agent_runs (
    organization_id,
    requested_by_user_id,
    uncovered_shift_count,
    urgent_shift_count,
    actionable_shift_count,
    priority_shift_ids
  ) VALUES (
    p_organization_id,
    v_user_id,
    p_uncovered_shift_count,
    p_urgent_shift_count,
    p_actionable_shift_count,
    p_priority_shift_ids
  )
  RETURNING id INTO v_run_id;

  RETURN v_run_id;
END;
$$;

REVOKE ALL ON FUNCTION app_record_coverage_agent_run(uuid,integer,integer,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_coverage_agent_run(uuid,integer,integer,integer,jsonb) TO app_runtime;
