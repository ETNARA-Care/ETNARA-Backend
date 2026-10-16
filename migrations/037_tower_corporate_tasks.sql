-- ETNARA Tower 12.9.2: platform-only corporate task storage.
-- Apply only after confirming this migration's ordering in the deployment runner.
-- All access requires a verified platform-admin context and PostgreSQL RLS.
CREATE TABLE tower_corporate_tasks (
  id uuid PRIMARY KEY,
  agent_id text NOT NULL,
  title varchar(120) NOT NULL CHECK (char_length(btrim(title)) >= 3),
  instructions varchar(1500) NOT NULL CHECK (char_length(btrim(instructions)) >= 5),
  priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'in_review', 'approved', 'rejected', 'completed')),
  created_by_platform_admin_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tower_corporate_tasks_agent_status_idx ON tower_corporate_tasks(agent_id, status, created_at DESC);

CREATE TABLE tower_corporate_task_audit (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tower_corporate_tasks(id) ON DELETE RESTRICT,
  from_status text NOT NULL CHECK (from_status IN ('draft', 'submitted', 'in_review', 'approved', 'rejected', 'completed')),
  to_status text NOT NULL CHECK (to_status IN ('draft', 'submitted', 'in_review', 'approved', 'rejected', 'completed')),
  actor_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  reason varchar(1000)
);
CREATE INDEX tower_corporate_task_audit_task_time_idx ON tower_corporate_task_audit(task_id, occurred_at DESC);

ALTER TABLE tower_corporate_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tower_corporate_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE tower_corporate_task_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE tower_corporate_task_audit FORCE ROW LEVEL SECURITY;

-- Require both the verified transaction setting and an active platform-admin DB row.
-- No agency/tenant membership can grant access to these platform-wide records.
CREATE POLICY tower_tasks_platform_admin ON tower_corporate_tasks
  FOR ALL TO app_runtime
  USING (
    app_is_superadmin()
  )
  WITH CHECK (
    app_is_superadmin()
  );
CREATE POLICY tower_task_audit_platform_admin ON tower_corporate_task_audit
  FOR ALL TO app_runtime
  USING (
    app_is_superadmin()
  )
  WITH CHECK (
    app_is_superadmin()
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON tower_corporate_tasks TO app_runtime;
REVOKE ALL ON tower_corporate_task_audit FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON tower_corporate_task_audit FROM app_runtime;
GRANT SELECT, INSERT ON tower_corporate_task_audit TO app_runtime;

-- Database-level immutability: audit history cannot be rewritten or deleted,
-- even if a future role accidentally receives UPDATE/DELETE grants.
CREATE FUNCTION tower_corporate_audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'Corporate task audit history is immutable';
END;
$body$;
CREATE TRIGGER tower_corporate_audit_no_update_delete
BEFORE UPDATE OR DELETE ON tower_corporate_task_audit
FOR EACH ROW EXECUTE FUNCTION tower_corporate_audit_immutable();
