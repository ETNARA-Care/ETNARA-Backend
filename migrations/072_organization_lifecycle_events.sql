CREATE TABLE IF NOT EXISTS organization_lifecycle_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 actor_user_id uuid NOT NULL REFERENCES users(id),
 action text NOT NULL CHECK (action IN ('suspend','archive','reactivate')),
 reason text NOT NULL,
 previous_status text NOT NULL,
 new_status text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_organization_lifecycle_events_org ON organization_lifecycle_events(organization_id,created_at DESC);
ALTER TABLE organization_lifecycle_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_lifecycle_events_platform_only ON organization_lifecycle_events USING (app_is_superadmin()) WITH CHECK (app_is_superadmin());
