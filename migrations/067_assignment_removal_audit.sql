-- E.1 Pre-pilot stabilization: preserve an immutable audit trail for pure assignment removals.
-- This table intentionally does not FK assignment_id because the assignment row is deleted.

CREATE TABLE assignment_removal_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  assignment_id uuid NOT NULL,
  shift_id uuid NOT NULL REFERENCES shifts(id),
  organization_worker_membership_id uuid NOT NULL REFERENCES organization_worker_memberships(id),
  care_recipient_id uuid NULL REFERENCES care_recipients(id),
  role_in_shift text NULL,
  previous_response_status text NOT NULL,
  previous_responded_at timestamptz NULL,
  previous_response_reason text NULL,
  assignment_created_at timestamptz NOT NULL,
  removed_by_user_id uuid NOT NULL REFERENCES users(id),
  removal_reason text NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assignment_removal_audit_org_shift_idx
  ON assignment_removal_audit (organization_id, shift_id, removed_at DESC);
CREATE INDEX assignment_removal_audit_org_worker_idx
  ON assignment_removal_audit (organization_id, organization_worker_membership_id, removed_at DESC);

ALTER TABLE assignment_removal_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_removal_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY assignment_removal_audit_manager_read
ON assignment_removal_audit
FOR SELECT
USING (
  organization_id = app_current_organization_id()
  AND app_is_org_manager(organization_id)
);

CREATE POLICY assignment_removal_audit_manager_insert
ON assignment_removal_audit
FOR INSERT
WITH CHECK (
  organization_id = app_current_organization_id()
  AND app_is_org_manager(organization_id)
  AND removed_by_user_id = app_current_user_id()
);

-- Deliberately no UPDATE or DELETE policy: removal history is append-only.
