-- Dedicated, append-only history of task owner changes.
CREATE TABLE tower_corporate_task_assignments (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tower_corporate_tasks(id) ON DELETE RESTRICT,
  from_agent_id text NOT NULL,
  to_agent_id text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  reason varchar(500) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_agent_id <> to_agent_id)
);
CREATE INDEX tower_task_assignments_task_idx ON tower_corporate_task_assignments(task_id, occurred_at DESC);
ALTER TABLE tower_corporate_task_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tower_corporate_task_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tower_task_assignments_platform_admin ON tower_corporate_task_assignments
  FOR ALL TO app_runtime USING (app_is_superadmin()) WITH CHECK (app_is_superadmin());
REVOKE ALL ON tower_corporate_task_assignments FROM PUBLIC;
GRANT SELECT, INSERT ON tower_corporate_task_assignments TO app_runtime;
CREATE TRIGGER tower_corporate_assignments_no_update_delete
BEFORE UPDATE OR DELETE ON tower_corporate_task_assignments
FOR EACH ROW EXECUTE FUNCTION tower_corporate_audit_immutable();
