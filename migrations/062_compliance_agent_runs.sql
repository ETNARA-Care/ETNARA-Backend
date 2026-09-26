-- Phase 9.1: immutable audit history for manager-requested compliance briefings.
CREATE TABLE compliance_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  generated_at timestamptz NOT NULL DEFAULT now(),
  active_worker_count integer NOT NULL CHECK (active_worker_count >= 0),
  eligible_worker_count integer NOT NULL CHECK (eligible_worker_count >= 0),
  blocked_worker_count integer NOT NULL CHECK (blocked_worker_count >= 0),
  expiring_worker_count integer NOT NULL CHECK (expiring_worker_count >= 0),
  priority_membership_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT compliance_agent_priority_ids_array
    CHECK (jsonb_typeof(priority_membership_ids) = 'array')
);

CREATE INDEX idx_compliance_agent_runs_org_generated
  ON compliance_agent_runs (organization_id, generated_at DESC);

ALTER TABLE compliance_agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY compliance_agent_runs_manager_read
  ON compliance_agent_runs FOR SELECT
  USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
  );
GRANT SELECT ON compliance_agent_runs TO app_runtime;

CREATE OR REPLACE FUNCTION app_record_compliance_agent_run(
  p_organization_id uuid,
  p_active_worker_count integer,
  p_eligible_worker_count integer,
  p_blocked_worker_count integer,
  p_expiring_worker_count integer,
  p_priority_membership_ids jsonb
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
    RAISE EXCEPTION 'compliance agent forbidden';
  END IF;

  IF p_active_worker_count < 0
     OR p_eligible_worker_count < 0
     OR p_blocked_worker_count < 0
     OR p_expiring_worker_count < 0
     OR p_eligible_worker_count > p_active_worker_count
     OR p_blocked_worker_count > p_active_worker_count
     OR p_expiring_worker_count > p_active_worker_count
     OR jsonb_typeof(p_priority_membership_ids) <> 'array'
     OR jsonb_array_length(p_priority_membership_ids) > 5
  THEN
    RAISE EXCEPTION 'invalid compliance agent snapshot';
  END IF;

  INSERT INTO compliance_agent_runs (
    organization_id,
    requested_by_user_id,
    active_worker_count,
    eligible_worker_count,
    blocked_worker_count,
    expiring_worker_count,
    priority_membership_ids
  ) VALUES (
    p_organization_id,
    v_user_id,
    p_active_worker_count,
    p_eligible_worker_count,
    p_blocked_worker_count,
    p_expiring_worker_count,
    p_priority_membership_ids
  )
  RETURNING id INTO v_run_id;

  RETURN v_run_id;
END;
$$;

REVOKE ALL ON FUNCTION app_record_compliance_agent_run(uuid,integer,integer,integer,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_compliance_agent_run(uuid,integer,integer,integer,integer,jsonb) TO app_runtime;
