-- Phase 9.0: immutable audit history for manager-requested operational agent briefings.
CREATE TABLE operational_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  generated_at timestamptz NOT NULL DEFAULT now(),
  alert_count integer NOT NULL CHECK (alert_count >= 0),
  critical_count integer NOT NULL CHECK (critical_count >= 0),
  warning_count integer NOT NULL CHECK (warning_count >= 0),
  priority_alert_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT operational_agent_priority_keys_array
    CHECK (jsonb_typeof(priority_alert_keys) = 'array')
);

CREATE INDEX idx_operational_agent_runs_org_generated
  ON operational_agent_runs (organization_id, generated_at DESC);

ALTER TABLE operational_agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY operational_agent_runs_manager_read
  ON operational_agent_runs FOR SELECT
  USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
  );
GRANT SELECT ON operational_agent_runs TO app_runtime;

CREATE OR REPLACE FUNCTION app_record_operational_agent_run(
  p_organization_id uuid,
  p_alert_count integer,
  p_critical_count integer,
  p_warning_count integer,
  p_priority_alert_keys jsonb
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
    RAISE EXCEPTION 'operational agent forbidden';
  END IF;

  IF p_alert_count < 0
     OR p_critical_count < 0
     OR p_warning_count < 0
     OR p_critical_count + p_warning_count > p_alert_count
     OR jsonb_typeof(p_priority_alert_keys) <> 'array'
     OR jsonb_array_length(p_priority_alert_keys) > 5
  THEN
    RAISE EXCEPTION 'invalid operational agent snapshot';
  END IF;

  INSERT INTO operational_agent_runs (
    organization_id,
    requested_by_user_id,
    alert_count,
    critical_count,
    warning_count,
    priority_alert_keys
  ) VALUES (
    p_organization_id,
    v_user_id,
    p_alert_count,
    p_critical_count,
    p_warning_count,
    p_priority_alert_keys
  )
  RETURNING id INTO v_run_id;

  RETURN v_run_id;
END;
$$;

REVOKE ALL ON FUNCTION app_record_operational_agent_run(uuid,integer,integer,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_operational_agent_run(uuid,integer,integer,integer,jsonb) TO app_runtime;
