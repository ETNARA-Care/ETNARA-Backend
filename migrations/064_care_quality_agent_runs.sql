-- Phase 9.3: immutable audit history for manager-requested care-quality briefings.
CREATE TABLE care_quality_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  generated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_shift_count integer NOT NULL CHECK (reviewed_shift_count >= 0),
  shift_review_count integer NOT NULL CHECK (shift_review_count >= 0),
  open_observation_count integer NOT NULL CHECK (open_observation_count >= 0),
  incomplete_incident_count integer NOT NULL CHECK (incomplete_incident_count >= 0),
  priority_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT care_quality_agent_priority_keys_array
    CHECK (jsonb_typeof(priority_keys) = 'array')
);

CREATE INDEX idx_care_quality_agent_runs_org_generated
  ON care_quality_agent_runs (organization_id, generated_at DESC);

ALTER TABLE care_quality_agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY care_quality_agent_runs_manager_read
  ON care_quality_agent_runs FOR SELECT
  USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
  );
GRANT SELECT ON care_quality_agent_runs TO app_runtime;

CREATE OR REPLACE FUNCTION app_record_care_quality_agent_run(
  p_organization_id uuid,
  p_reviewed_shift_count integer,
  p_shift_review_count integer,
  p_open_observation_count integer,
  p_incomplete_incident_count integer,
  p_priority_keys jsonb
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
    RAISE EXCEPTION 'care quality agent forbidden';
  END IF;

  IF p_reviewed_shift_count < 0
     OR p_shift_review_count < 0
     OR p_open_observation_count < 0
     OR p_incomplete_incident_count < 0
     OR p_shift_review_count > p_reviewed_shift_count
     OR jsonb_typeof(p_priority_keys) <> 'array'
     OR jsonb_array_length(p_priority_keys) > 5
  THEN
    RAISE EXCEPTION 'invalid care quality agent snapshot';
  END IF;

  INSERT INTO care_quality_agent_runs (
    organization_id,
    requested_by_user_id,
    reviewed_shift_count,
    shift_review_count,
    open_observation_count,
    incomplete_incident_count,
    priority_keys
  ) VALUES (
    p_organization_id,
    v_user_id,
    p_reviewed_shift_count,
    p_shift_review_count,
    p_open_observation_count,
    p_incomplete_incident_count,
    p_priority_keys
  )
  RETURNING id INTO v_run_id;

  RETURN v_run_id;
END;
$$;

REVOKE ALL ON FUNCTION app_record_care_quality_agent_run(uuid,integer,integer,integer,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_care_quality_agent_run(uuid,integer,integer,integer,integer,jsonb) TO app_runtime;
