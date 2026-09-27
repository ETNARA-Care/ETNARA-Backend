-- Phase 10.1A: establishment-scoped access foundation.
-- organization_id remains the tenant boundary; location_id is an additional
-- authorization boundary inside that tenant.

-- Administrative users may be assigned to one or more establishments.
CREATE TABLE establishment_admin_assignments (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id             uuid NOT NULL,
    location_id                 uuid NOT NULL,
    organization_membership_id  uuid NOT NULL,
    created_by_user_id          uuid REFERENCES users(id),
    created_at                  timestamptz NOT NULL DEFAULT now(),
    archived_at                 timestamptz NULL,
    FOREIGN KEY (location_id, organization_id)
        REFERENCES locations (id, organization_id),
    FOREIGN KEY (organization_membership_id, organization_id)
        REFERENCES organization_memberships (id, organization_id),
    UNIQUE (organization_membership_id, location_id)
);

-- Workers remain organization-scoped professionals and can work at multiple
-- establishments without duplicating their identity or credentials.
CREATE TABLE establishment_worker_assignments (
    id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id                     uuid NOT NULL,
    location_id                         uuid NOT NULL,
    organization_worker_membership_id   uuid NOT NULL,
    created_by_user_id                  uuid REFERENCES users(id),
    created_at                          timestamptz NOT NULL DEFAULT now(),
    archived_at                         timestamptz NULL,
    FOREIGN KEY (location_id, organization_id)
        REFERENCES locations (id, organization_id),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id),
    UNIQUE (organization_worker_membership_id, location_id)
);

-- A resident belongs to one operational establishment at a time. NULL keeps
-- legacy/home-care recipients compatible until they are explicitly assigned.
ALTER TABLE care_recipients
    ADD COLUMN location_id uuid NULL;

ALTER TABLE care_recipients
    ADD CONSTRAINT care_recipients_location_same_org
    FOREIGN KEY (location_id, organization_id)
        REFERENCES locations (id, organization_id);

CREATE INDEX idx_care_recipients_org_location
    ON care_recipients (organization_id, location_id)
    WHERE status = 'active';

CREATE INDEX idx_establishment_admin_assignments_active
    ON establishment_admin_assignments (organization_id, location_id, organization_membership_id)
    WHERE archived_at IS NULL;

CREATE INDEX idx_establishment_worker_assignments_active
    ON establishment_worker_assignments (organization_id, location_id, organization_worker_membership_id)
    WHERE archived_at IS NULL;

-- Helpers intentionally check both organization and establishment. Org admins
-- retain organization-wide authority; assigned admins receive only the
-- establishment scope explicitly granted to them.
CREATE OR REPLACE FUNCTION app_is_establishment_admin(p_location_id uuid)
RETURNS boolean AS $$
    SELECT app_is_org_manager()
        OR EXISTS (
            SELECT 1
            FROM establishment_admin_assignments eaa
            JOIN organization_memberships om
              ON om.id = eaa.organization_membership_id
             AND om.organization_id = eaa.organization_id
            WHERE eaa.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND eaa.location_id = p_location_id
              AND eaa.archived_at IS NULL
              AND om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND om.status = 'active'
        )
        OR app_is_superadmin();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION app_worker_has_establishment(p_worker_membership_id uuid, p_location_id uuid)
RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
        FROM establishment_worker_assignments ewa
        WHERE ewa.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND ewa.organization_worker_membership_id = p_worker_membership_id
          AND ewa.location_id = p_location_id
          AND ewa.archived_at IS NULL
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

ALTER TABLE establishment_admin_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE establishment_worker_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY establishment_admin_assignments_manager_read
ON establishment_admin_assignments FOR SELECT
USING (
    (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
     AND (app_is_org_manager() OR app_is_establishment_admin(location_id)))
    OR app_is_superadmin()
);

CREATE POLICY establishment_admin_assignments_org_manager_insert
ON establishment_admin_assignments FOR INSERT
WITH CHECK (
    (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
     AND app_is_org_manager())
    OR app_is_superadmin()
);

CREATE POLICY establishment_admin_assignments_org_manager_update
ON establishment_admin_assignments FOR UPDATE
USING (
    (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
     AND app_is_org_manager())
    OR app_is_superadmin()
)
WITH CHECK (
    (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
     AND app_is_org_manager())
    OR app_is_superadmin()
);

CREATE POLICY establishment_worker_assignments_manager_read
ON establishment_worker_assignments FOR SELECT
USING (
    (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
     AND (app_is_org_manager() OR app_is_establishment_admin(location_id)))
    OR app_is_superadmin()
);

CREATE POLICY establishment_worker_assignments_manager_insert
ON establishment_worker_assignments FOR INSERT
WITH CHECK (
    (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
     AND (app_is_org_manager() OR app_is_establishment_admin(location_id)))
    OR app_is_superadmin()
);

CREATE POLICY establishment_worker_assignments_manager_update
ON establishment_worker_assignments FOR UPDATE
USING (
    (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
     AND (app_is_org_manager() OR app_is_establishment_admin(location_id)))
    OR app_is_superadmin()
)
WITH CHECK (
    (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
     AND (app_is_org_manager() OR app_is_establishment_admin(location_id)))
    OR app_is_superadmin()
);

-- Baseline runtime grants remain constrained by RLS.
GRANT SELECT, INSERT, UPDATE ON establishment_admin_assignments TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON establishment_worker_assignments TO app_runtime;
REVOKE DELETE ON establishment_admin_assignments FROM app_runtime;
REVOKE DELETE ON establishment_worker_assignments FROM app_runtime;

-- No care_recipient RLS policy is replaced here. Existing tenant/family/worker
-- protections remain intact; establishment-aware API enforcement is added in
-- 10.1B before establishment-scoped UI is exposed.
