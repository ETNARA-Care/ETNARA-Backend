-- Migration 050: worker-declared weekly availability and bounded time off.
-- Availability is operational preference data, not proof of assignment or
-- clinical authority. Assignment and eligibility gates remain authoritative.

CREATE TABLE worker_availability_settings (
    organization_worker_membership_id uuid PRIMARY KEY,
    organization_id                   uuid NOT NULL,
    timezone                          text NOT NULL DEFAULT 'America/Puerto_Rico',
    created_at                        timestamptz NOT NULL DEFAULT now(),
    updated_at                        timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id)
);

CREATE TABLE worker_weekly_availability (
    id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_worker_membership_id uuid NOT NULL,
    organization_id                   uuid NOT NULL,
    weekday                           smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    start_time                        time NOT NULL,
    end_time                          time NOT NULL,
    created_at                        timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id),
    CHECK (start_time < end_time),
    UNIQUE (organization_worker_membership_id, weekday)
);

CREATE TABLE worker_unavailability_periods (
    id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_worker_membership_id uuid NOT NULL,
    organization_id                   uuid NOT NULL,
    starts_at                         timestamptz NOT NULL,
    ends_at                           timestamptz NOT NULL,
    reason                            text NULL,
    created_at                        timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id),
    CHECK (starts_at < ends_at)
);

CREATE INDEX idx_worker_weekly_availability_membership
    ON worker_weekly_availability (organization_worker_membership_id, weekday);
CREATE INDEX idx_worker_unavailability_membership_window
    ON worker_unavailability_periods (organization_worker_membership_id, starts_at, ends_at);

ALTER TABLE worker_availability_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_weekly_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_unavailability_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY worker_availability_settings_manager_or_self
    ON worker_availability_settings FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR EXISTS (
                SELECT 1
                FROM organization_worker_memberships owm
                JOIN workers w ON w.id = owm.worker_id
                WHERE owm.id = worker_availability_settings.organization_worker_membership_id
                  AND owm.organization_id = worker_availability_settings.organization_id
                  AND owm.status = 'active'
                  AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            )
        )
    )
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR EXISTS (
                SELECT 1
                FROM organization_worker_memberships owm
                JOIN workers w ON w.id = owm.worker_id
                WHERE owm.id = worker_availability_settings.organization_worker_membership_id
                  AND owm.organization_id = worker_availability_settings.organization_id
                  AND owm.status = 'active'
                  AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            )
        )
    );

CREATE POLICY worker_weekly_availability_manager_or_self
    ON worker_weekly_availability FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR EXISTS (
                SELECT 1
                FROM organization_worker_memberships owm
                JOIN workers w ON w.id = owm.worker_id
                WHERE owm.id = worker_weekly_availability.organization_worker_membership_id
                  AND owm.organization_id = worker_weekly_availability.organization_id
                  AND owm.status = 'active'
                  AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            )
        )
    )
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR EXISTS (
                SELECT 1
                FROM organization_worker_memberships owm
                JOIN workers w ON w.id = owm.worker_id
                WHERE owm.id = worker_weekly_availability.organization_worker_membership_id
                  AND owm.organization_id = worker_weekly_availability.organization_id
                  AND owm.status = 'active'
                  AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            )
        )
    );

CREATE POLICY worker_unavailability_periods_manager_or_self
    ON worker_unavailability_periods FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR EXISTS (
                SELECT 1
                FROM organization_worker_memberships owm
                JOIN workers w ON w.id = owm.worker_id
                WHERE owm.id = worker_unavailability_periods.organization_worker_membership_id
                  AND owm.organization_id = worker_unavailability_periods.organization_id
                  AND owm.status = 'active'
                  AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            )
        )
    )
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR EXISTS (
                SELECT 1
                FROM organization_worker_memberships owm
                JOIN workers w ON w.id = owm.worker_id
                WHERE owm.id = worker_unavailability_periods.organization_worker_membership_id
                  AND owm.organization_id = worker_unavailability_periods.organization_id
                  AND owm.status = 'active'
                  AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            )
        )
    );
