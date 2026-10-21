-- SmartMatch foundation: storage only. No runtime privileges or endpoints enabled.
-- Tables remain inaccessible to app_runtime until explicit reviewed RLS policies are added.
CREATE TABLE IF NOT EXISTS smartmatch_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('INTERNAL','NETWORK')),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','CANCELLED','EXPIRED','FILLED')),
  region_label varchar(100) NOT NULL,
  role_label varchar(100) NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT smartmatch_opportunity_dates CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_smartmatch_opportunities_org_status
  ON smartmatch_opportunities (organization_id, status, starts_at);

CREATE TABLE IF NOT EXISTS smartmatch_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES smartmatch_opportunities(id),
  caregiver_user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  decided_by_user_id uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, caregiver_user_id)
);
CREATE INDEX IF NOT EXISTS idx_smartmatch_applications_caregiver
  ON smartmatch_applications (caregiver_user_id, status);

CREATE TABLE IF NOT EXISTS smartmatch_location_preferences (
  caregiver_user_id uuid PRIMARY KEY REFERENCES users(id),
  -- An opaque token; never store a plaintext residential address here.
  location_reference text NOT NULL,
  consented_at timestamptz NOT NULL,
  notifications_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smartmatch_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartmatch_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartmatch_location_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartmatch_opportunities FORCE ROW LEVEL SECURITY;
ALTER TABLE smartmatch_applications FORCE ROW LEVEL SECURITY;
ALTER TABLE smartmatch_location_preferences FORCE ROW LEVEL SECURITY;

-- No RLS policies and no app_runtime grants intentionally: deny by default.
-- Follow-up migration must add vetted policies, tenant-safe service methods,
-- protected recipient/service location references, and transactional approval.
