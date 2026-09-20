-- Migration 052: collaborative offers for uncovered shifts.
-- Offers expose only the work window and requested role. They never grant
-- access to the shift, resident, care plan, messages, or clinical records.

CREATE TABLE coverage_campaigns (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations(id),
    shift_id            uuid NOT NULL,
    scheduled_start     timestamptz NOT NULL,
    scheduled_end       timestamptz NOT NULL,
    role_label          text NOT NULL DEFAULT 'Cuidador/a',
    status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
    expires_at          timestamptz NOT NULL,
    created_by_user_id  uuid NOT NULL REFERENCES users(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (shift_id, organization_id) REFERENCES shifts(id, organization_id),
    CHECK (scheduled_start < scheduled_end),
    UNIQUE (id, organization_id)
);

CREATE UNIQUE INDEX coverage_campaigns_one_open_per_shift
    ON coverage_campaigns (shift_id) WHERE status = 'open';

CREATE TABLE coverage_offers (
    id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id                     uuid NOT NULL,
    coverage_campaign_id                uuid NOT NULL,
    organization_worker_membership_id   uuid NOT NULL,
    candidate_rank                      integer NOT NULL CHECK (candidate_rank > 0),
    response_status                     text NOT NULL DEFAULT 'pending'
        CHECK (response_status IN ('pending', 'interested', 'declined', 'withdrawn')),
    responded_at                        timestamptz NULL,
    response_reason                     text NULL,
    created_at                          timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (coverage_campaign_id, organization_id)
        REFERENCES coverage_campaigns(id, organization_id),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships(id, organization_id),
    UNIQUE (coverage_campaign_id, organization_worker_membership_id)
);

CREATE INDEX coverage_offers_worker_pending
    ON coverage_offers (organization_worker_membership_id, response_status, created_at DESC);

ALTER TABLE coverage_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE coverage_offers ENABLE ROW LEVEL SECURITY;

CREATE POLICY coverage_campaigns_manager_or_offered_worker ON coverage_campaigns FOR SELECT
USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
        app_is_org_manager()
        OR EXISTS (
            SELECT 1 FROM coverage_offers offer
            JOIN organization_worker_memberships owm
              ON owm.id = offer.organization_worker_membership_id
            JOIN workers w ON w.id = owm.worker_id
            WHERE offer.coverage_campaign_id = coverage_campaigns.id
              AND offer.organization_id = coverage_campaigns.organization_id
              AND owm.status = 'active'
              AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        )
    )
);

CREATE POLICY coverage_campaigns_manager_insert ON coverage_campaigns FOR INSERT
WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());

CREATE POLICY coverage_campaigns_manager_update ON coverage_campaigns FOR UPDATE
USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager())
WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());

CREATE POLICY coverage_offers_manager_or_self_read ON coverage_offers FOR SELECT
USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
        app_is_org_manager()
        OR EXISTS (
            SELECT 1 FROM organization_worker_memberships owm
            JOIN workers w ON w.id = owm.worker_id
            WHERE owm.id = coverage_offers.organization_worker_membership_id
              AND owm.organization_id = coverage_offers.organization_id
              AND owm.status = 'active'
              AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        )
    )
);

CREATE POLICY coverage_offers_manager_insert ON coverage_offers FOR INSERT
WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());

CREATE POLICY coverage_offers_manager_or_self_update ON coverage_offers FOR UPDATE
USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
        app_is_org_manager()
        OR (
            response_status = 'pending'
            AND EXISTS (
                SELECT 1 FROM organization_worker_memberships owm
                JOIN workers w ON w.id = owm.worker_id
                WHERE owm.id = coverage_offers.organization_worker_membership_id
                  AND owm.organization_id = coverage_offers.organization_id
                  AND owm.status = 'active'
                  AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            )
        )
    )
)
WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND response_status IN ('interested', 'declined', 'withdrawn')
);

CREATE POLICY notifications_insert_coverage_offer ON notifications FOR INSERT
WITH CHECK (
    related_entity_type = 'coverage_offer'
    AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND EXISTS (
        SELECT 1 FROM coverage_offers offer
        JOIN organization_worker_memberships owm ON owm.id = offer.organization_worker_membership_id
        JOIN workers w ON w.id = owm.worker_id
        WHERE offer.id = notifications.related_entity_id
          AND offer.organization_id = notifications.organization_id
          AND (
              (app_is_org_manager() AND w.user_id = notifications.user_id)
              OR (
                  w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                  AND EXISTS (
                      SELECT 1 FROM organization_memberships om
                      JOIN user_roles ur ON ur.organization_membership_id = om.id
                      JOIN roles r ON r.id = ur.role_id
                      WHERE om.user_id = notifications.user_id
                        AND om.organization_id = notifications.organization_id
                        AND om.status = 'active'
                        AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
                  )
              )
          )
    )
);

GRANT SELECT, INSERT, UPDATE ON coverage_campaigns, coverage_offers TO app_runtime;
