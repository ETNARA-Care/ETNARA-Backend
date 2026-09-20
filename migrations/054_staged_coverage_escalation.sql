-- Migration 054: staged, privacy-safe escalation for uncovered shifts.
--
-- Campaigns keep a ranked queue, activate only one wave at a time and never
-- create an assignment. A small background worker invokes the due-only
-- SECURITY DEFINER entry point; concurrent instances serialize on each
-- campaign row and cannot activate the same wave twice.

ALTER TABLE coverage_campaigns
    DROP CONSTRAINT IF EXISTS coverage_campaigns_status_check;

ALTER TABLE coverage_campaigns
    ADD CONSTRAINT coverage_campaigns_status_check
        CHECK (status IN ('open', 'closed', 'cancelled', 'exhausted')),
    ADD COLUMN wave_size integer NOT NULL DEFAULT 3 CHECK (wave_size BETWEEN 1 AND 10),
    ADD COLUMN response_window_minutes integer NOT NULL DEFAULT 30
        CHECK (response_window_minutes BETWEEN 5 AND 240),
    ADD COLUMN current_wave integer NOT NULL DEFAULT 1 CHECK (current_wave > 0),
    ADD COLUMN next_wave_at timestamptz NULL,
    ADD COLUMN exhausted_at timestamptz NULL;

ALTER TABLE coverage_offers
    DROP CONSTRAINT IF EXISTS coverage_offers_response_status_check;

ALTER TABLE coverage_offers
    ADD CONSTRAINT coverage_offers_response_status_check
        CHECK (response_status IN (
            'queued', 'pending', 'interested', 'declined', 'expired', 'withdrawn'
        )),
    ADD COLUMN wave_number integer NOT NULL DEFAULT 1 CHECK (wave_number > 0),
    ADD COLUMN activated_at timestamptz NULL,
    ADD COLUMN response_due_at timestamptz NULL;

-- Preserve already-live Phase 7.4 campaigns as wave 1 without deleting or
-- rewriting their response history.
UPDATE coverage_offers offer
SET activated_at = offer.created_at,
    response_due_at = campaign.expires_at
FROM coverage_campaigns campaign
WHERE campaign.id = offer.coverage_campaign_id
  AND offer.response_status = 'pending';

UPDATE coverage_campaigns campaign
SET next_wave_at = campaign.expires_at
WHERE campaign.status = 'open'
  AND EXISTS (
      SELECT 1 FROM coverage_offers offer
      WHERE offer.coverage_campaign_id = campaign.id
        AND offer.response_status = 'pending'
  );

CREATE INDEX coverage_campaigns_due_wave
    ON coverage_campaigns (next_wave_at)
    WHERE status = 'open' AND next_wave_at IS NOT NULL;

CREATE INDEX coverage_offers_campaign_wave
    ON coverage_offers (coverage_campaign_id, wave_number, response_status);

-- Queued caregivers are intentionally unaware of the campaign until their
-- wave is activated. Enforce that at RLS as well as in the API query.
DROP POLICY IF EXISTS coverage_campaigns_manager_or_offered_worker ON coverage_campaigns;
CREATE POLICY coverage_campaigns_manager_or_offered_worker ON coverage_campaigns FOR SELECT
USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
        app_is_org_manager()
        OR EXISTS (
            SELECT 1 FROM coverage_offers offer
            JOIN organization_worker_memberships membership
              ON membership.id = offer.organization_worker_membership_id
            JOIN workers worker ON worker.id = membership.worker_id
            WHERE offer.coverage_campaign_id = coverage_campaigns.id
              AND offer.organization_id = coverage_campaigns.organization_id
              AND offer.response_status <> 'queued'
              AND membership.status = 'active'
              AND worker.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        )
    )
);

DROP POLICY IF EXISTS coverage_offers_manager_or_self_read ON coverage_offers;
CREATE POLICY coverage_offers_manager_or_self_read ON coverage_offers FOR SELECT
USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
        app_is_org_manager()
        OR (
            response_status <> 'queued'
            AND EXISTS (
                SELECT 1 FROM organization_worker_memberships membership
                JOIN workers worker ON worker.id = membership.worker_id
                WHERE membership.id = coverage_offers.organization_worker_membership_id
                  AND membership.organization_id = coverage_offers.organization_id
                  AND membership.status = 'active'
                  AND worker.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            )
        )
    )
);

CREATE OR REPLACE FUNCTION app_activate_next_coverage_wave(
    p_campaign_id uuid,
    p_expire_due boolean
)
RETURNS integer AS $$
DECLARE
    v_campaign coverage_campaigns%ROWTYPE;
    v_next_wave integer;
    v_due_at timestamptz;
    v_activated_at timestamptz := clock_timestamp();
    v_activated integer := 0;
BEGIN
    SELECT * INTO v_campaign
    FROM coverage_campaigns
    WHERE id = p_campaign_id AND status = 'open'
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- One positive response stops escalation. Administration still makes the
    -- final assignment through the existing assignment workflow.
    IF EXISTS (
        SELECT 1 FROM coverage_offers
        WHERE coverage_campaign_id = p_campaign_id
          AND response_status = 'interested'
    ) THEN
        UPDATE coverage_campaigns
        SET next_wave_at = NULL, updated_at = now()
        WHERE id = p_campaign_id;
        RETURN 0;
    END IF;

    IF p_expire_due THEN
        UPDATE coverage_offers
        SET response_status = 'expired',
            responded_at = COALESCE(responded_at, now())
        WHERE coverage_campaign_id = p_campaign_id
          AND response_status = 'pending'
          AND response_due_at <= now();
    END IF;

    -- A response-triggered progression cannot skip caregivers who still have
    -- time to answer. The due worker reaches this point only after expiry.
    IF EXISTS (
        SELECT 1 FROM coverage_offers
        WHERE coverage_campaign_id = p_campaign_id
          AND response_status = 'pending'
    ) THEN
        RETURN 0;
    END IF;

    SELECT min(wave_number) INTO v_next_wave
    FROM coverage_offers
    WHERE coverage_campaign_id = p_campaign_id
      AND response_status = 'queued';

    IF v_next_wave IS NULL THEN
        UPDATE coverage_campaigns
        SET status = 'exhausted', next_wave_at = NULL,
            exhausted_at = now(), updated_at = now()
        WHERE id = p_campaign_id;
        RETURN 0;
    END IF;

    v_due_at := LEAST(
        v_campaign.expires_at,
        now() + make_interval(mins => v_campaign.response_window_minutes)
    );

    IF v_due_at <= now() THEN
        UPDATE coverage_offers
        SET response_status = 'withdrawn', responded_at = COALESCE(responded_at, now())
        WHERE coverage_campaign_id = p_campaign_id
          AND response_status = 'queued';
        UPDATE coverage_campaigns
        SET status = 'exhausted', next_wave_at = NULL,
            exhausted_at = now(), updated_at = now()
        WHERE id = p_campaign_id;
        RETURN 0;
    END IF;

    WITH activated AS (
        UPDATE coverage_offers
        SET response_status = 'pending',
            activated_at = v_activated_at,
            response_due_at = v_due_at
        WHERE coverage_campaign_id = p_campaign_id
          AND wave_number = v_next_wave
          AND response_status = 'queued'
        RETURNING 1
    )
    SELECT count(*)::integer INTO v_activated FROM activated;

    INSERT INTO notifications (
        user_id, organization_id, notification_type, related_entity_type,
        related_entity_id, channel, status, sent_at
    )
    SELECT
        worker.user_id,
        offer.organization_id,
        'OPEN_SHIFT_OFFER',
        'coverage_offer',
        offer.id,
        'in_app',
        'sent',
        now()
    FROM coverage_offers offer
    JOIN organization_worker_memberships membership
      ON membership.id = offer.organization_worker_membership_id
    JOIN workers worker ON worker.id = membership.worker_id
    WHERE offer.coverage_campaign_id = p_campaign_id
      AND offer.wave_number = v_next_wave
      AND offer.response_status = 'pending'
      AND offer.activated_at = v_activated_at
      AND worker.user_id IS NOT NULL;

    UPDATE coverage_campaigns
    SET current_wave = v_next_wave,
        next_wave_at = v_due_at,
        updated_at = now()
    WHERE id = p_campaign_id;

    RETURN v_activated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION app_activate_next_coverage_wave(uuid, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_progress_coverage_campaign_after_response(
    p_offer_id uuid
)
RETURNS integer AS $$
DECLARE
    v_organization_id uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
    v_actor_user_id uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    v_campaign_id uuid;
    v_response_status text;
BEGIN
    SELECT offer.coverage_campaign_id, offer.response_status
      INTO v_campaign_id, v_response_status
      FROM coverage_offers offer
      JOIN organization_worker_memberships membership
        ON membership.id = offer.organization_worker_membership_id
      JOIN workers worker ON worker.id = membership.worker_id
     WHERE offer.id = p_offer_id
       AND offer.organization_id = v_organization_id
       AND membership.organization_id = v_organization_id
       AND membership.status = 'active'
       AND worker.user_id = v_actor_user_id
       AND offer.response_status IN ('interested', 'declined');

    IF NOT FOUND THEN
        RAISE EXCEPTION 'coverage campaign progression is not authorized'
            USING ERRCODE = '42501';
    END IF;

    IF v_response_status = 'interested' THEN
        UPDATE coverage_campaigns
        SET next_wave_at = NULL, updated_at = now()
        WHERE id = v_campaign_id AND status = 'open';
        RETURN 0;
    END IF;

    RETURN app_activate_next_coverage_wave(v_campaign_id, false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION app_progress_coverage_campaign_after_response(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_progress_coverage_campaign_after_response(uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION app_advance_due_coverage_campaigns()
RETURNS integer AS $$
DECLARE
    v_campaign_id uuid;
    v_activated integer := 0;
BEGIN
    FOR v_campaign_id IN
        SELECT campaign.id
        FROM coverage_campaigns campaign
        WHERE campaign.status = 'open'
          AND campaign.next_wave_at IS NOT NULL
          AND campaign.next_wave_at <= now()
        ORDER BY campaign.next_wave_at
        FOR UPDATE SKIP LOCKED
    LOOP
        v_activated := v_activated
            + app_activate_next_coverage_wave(v_campaign_id, true);
    END LOOP;

    RETURN v_activated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION app_advance_due_coverage_campaigns() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_advance_due_coverage_campaigns() TO app_runtime;
