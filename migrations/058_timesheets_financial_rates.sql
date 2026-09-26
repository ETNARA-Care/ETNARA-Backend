-- Phase 7.8: manager-reviewed timesheets and financial rate snapshots.
-- Money is stored only as integer cents. ETNARA calculates operational
-- amounts but does not move money, run payroll or issue invoices in this gate.

CREATE TABLE worker_financial_rates (
    organization_worker_membership_id uuid PRIMARY KEY,
    organization_id                   uuid NOT NULL,
    pay_rate_cents                    integer NOT NULL,
    bill_rate_cents                   integer NOT NULL,
    currency                          text NOT NULL DEFAULT 'USD',
    created_by_user_id                uuid NOT NULL REFERENCES users(id),
    updated_by_user_id                uuid NOT NULL REFERENCES users(id),
    created_at                        timestamptz NOT NULL DEFAULT now(),
    updated_at                        timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id),
    CONSTRAINT worker_financial_rates_pay_bounded
        CHECK (pay_rate_cents BETWEEN 0 AND 100000),
    CONSTRAINT worker_financial_rates_bill_bounded
        CHECK (bill_rate_cents BETWEEN 0 AND 100000),
    CONSTRAINT worker_financial_rates_currency_usd CHECK (currency = 'USD')
);

CREATE TABLE timesheets (
    id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id                     uuid NOT NULL,
    shift_id                            uuid NOT NULL,
    assignment_id                       uuid NOT NULL REFERENCES assignments(id),
    organization_worker_membership_id   uuid NOT NULL,
    care_recipient_id                   uuid NULL,
    check_in_at                         timestamptz NOT NULL,
    check_out_at                        timestamptz NOT NULL,
    recorded_minutes                    integer NOT NULL,
    approved_minutes                    integer NULL,
    pay_rate_cents_snapshot             integer NULL,
    bill_rate_cents_snapshot            integer NULL,
    currency                            text NOT NULL DEFAULT 'USD',
    pay_amount_cents                    integer NULL,
    bill_amount_cents                   integer NULL,
    status                              text NOT NULL DEFAULT 'pending',
    review_note                         text NULL,
    reviewed_by_user_id                 uuid NULL REFERENCES users(id),
    reviewed_at                         timestamptz NULL,
    created_at                          timestamptz NOT NULL DEFAULT now(),
    updated_at                          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, shift_id, organization_worker_membership_id),
    FOREIGN KEY (shift_id, organization_id)
        REFERENCES shifts (id, organization_id),
    FOREIGN KEY (organization_worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id),
    FOREIGN KEY (care_recipient_id, organization_id)
        REFERENCES care_recipients (id, organization_id),
    CONSTRAINT timesheets_valid_window CHECK (check_out_at > check_in_at),
    CONSTRAINT timesheets_recorded_minutes_bounded CHECK (recorded_minutes BETWEEN 1 AND 2880),
    CONSTRAINT timesheets_approved_minutes_bounded CHECK (approved_minutes IS NULL OR approved_minutes BETWEEN 1 AND 2880),
    CONSTRAINT timesheets_rate_snapshots_bounded CHECK (
        (pay_rate_cents_snapshot IS NULL OR pay_rate_cents_snapshot BETWEEN 0 AND 100000)
        AND (bill_rate_cents_snapshot IS NULL OR bill_rate_cents_snapshot BETWEEN 0 AND 100000)
    ),
    CONSTRAINT timesheets_amounts_nonnegative CHECK (
        (pay_amount_cents IS NULL OR pay_amount_cents >= 0)
        AND (bill_amount_cents IS NULL OR bill_amount_cents >= 0)
    ),
    CONSTRAINT timesheets_status_check CHECK (status IN ('pending', 'approved', 'disputed')),
    CONSTRAINT timesheets_currency_usd CHECK (currency = 'USD'),
    CONSTRAINT timesheets_review_state_check CHECK (
        (status = 'pending' AND approved_minutes IS NULL AND pay_amount_cents IS NULL AND bill_amount_cents IS NULL)
        OR (status = 'disputed' AND approved_minutes IS NULL AND pay_amount_cents IS NULL AND bill_amount_cents IS NULL AND length(trim(review_note)) > 0)
        OR (status = 'approved' AND approved_minutes IS NOT NULL AND pay_rate_cents_snapshot IS NOT NULL
            AND bill_rate_cents_snapshot IS NOT NULL AND pay_amount_cents IS NOT NULL
            AND bill_amount_cents IS NOT NULL AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
    )
);

CREATE INDEX idx_timesheets_org_check_in ON timesheets (organization_id, check_in_at DESC);
CREATE INDEX idx_timesheets_org_status ON timesheets (organization_id, status, check_in_at DESC);
CREATE INDEX idx_timesheets_membership ON timesheets (organization_worker_membership_id, check_in_at DESC);

ALTER TABLE worker_financial_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY;

CREATE POLICY worker_financial_rates_manager_read ON worker_financial_rates FOR SELECT
USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
);

CREATE POLICY worker_financial_rates_manager_insert ON worker_financial_rates FOR INSERT
WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
);

CREATE POLICY worker_financial_rates_manager_update ON worker_financial_rates FOR UPDATE
USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
)
WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
);

CREATE POLICY timesheets_manager_read ON timesheets FOR SELECT
USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
);

CREATE POLICY timesheets_manager_update ON timesheets FOR UPDATE
USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
)
WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager()
);

GRANT SELECT, INSERT, UPDATE ON worker_financial_rates TO app_runtime;
GRANT SELECT, UPDATE ON timesheets TO app_runtime;

-- Checkout is performed by the assigned worker, while bill rates must remain
-- manager-only. This narrow SECURITY DEFINER function validates the exact
-- authenticated worker or manager before snapshotting a rate that the caller
-- cannot otherwise read. No general timesheet INSERT grant is given.
CREATE OR REPLACE FUNCTION app_record_timesheet_from_checkout(
    p_actor_user_id uuid,
    p_organization_id uuid,
    p_shift_id uuid,
    p_membership_id uuid,
    p_check_in_at timestamptz,
    p_check_out_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_timesheet_id uuid;
    v_inserted_id uuid;
BEGIN
    IF p_organization_id IS DISTINCT FROM NULLIF(current_setting('app.current_org_id', true), '')::uuid
       OR p_actor_user_id IS DISTINCT FROM NULLIF(current_setting('app.current_user_id', true), '')::uuid THEN
        RAISE EXCEPTION 'invalid timesheet context';
    END IF;

    IF NOT app_is_org_manager() AND NOT EXISTS (
        SELECT 1
        FROM organization_worker_memberships membership
        JOIN workers worker ON worker.id = membership.worker_id
        WHERE membership.id = p_membership_id
          AND membership.organization_id = p_organization_id
          AND membership.status = 'active'
          AND worker.user_id = p_actor_user_id
    ) THEN
        RAISE EXCEPTION 'timesheet checkout forbidden';
    END IF;

    IF p_check_out_at <= p_check_in_at
       OR extract(epoch FROM (p_check_out_at - p_check_in_at)) > 172800 THEN
        RAISE EXCEPTION 'invalid timesheet window';
    END IF;

    v_timesheet_id := gen_random_uuid();
    INSERT INTO timesheets (
        id, organization_id, shift_id, assignment_id,
        organization_worker_membership_id, care_recipient_id,
        check_in_at, check_out_at, recorded_minutes,
        pay_rate_cents_snapshot, bill_rate_cents_snapshot, currency
    )
    SELECT
        v_timesheet_id,
        assignment.organization_id,
        assignment.shift_id,
        assignment.id,
        assignment.organization_worker_membership_id,
        shift.care_recipient_id,
        p_check_in_at,
        p_check_out_at,
        GREATEST(1, round(extract(epoch FROM (p_check_out_at - p_check_in_at)) / 60)::integer),
        rate.pay_rate_cents,
        rate.bill_rate_cents,
        COALESCE(rate.currency, 'USD')
    FROM assignments assignment
    JOIN shifts shift
      ON shift.id = assignment.shift_id AND shift.organization_id = assignment.organization_id
    LEFT JOIN worker_financial_rates rate
      ON rate.organization_worker_membership_id = assignment.organization_worker_membership_id
    WHERE assignment.organization_id = p_organization_id
      AND assignment.shift_id = p_shift_id
      AND assignment.organization_worker_membership_id = p_membership_id
      AND assignment.response_status = 'accepted'
    ORDER BY assignment.responded_at DESC NULLS LAST, assignment.created_at DESC
    LIMIT 1
    ON CONFLICT (organization_id, shift_id, organization_worker_membership_id) DO NOTHING
    RETURNING id INTO v_inserted_id;

    IF v_inserted_id IS NOT NULL THEN
        INSERT INTO audit_log (
            actor_user_id, organization_id, target_organization_id,
            action, entity_type, entity_id, new_value
        ) VALUES (
            p_actor_user_id, p_organization_id, p_organization_id,
            'TIMESHEET_CREATED', 'timesheet', v_inserted_id,
            jsonb_build_object('shiftId', p_shift_id, 'membershipId', p_membership_id)
        );
        RETURN v_inserted_id;
    END IF;

    SELECT id INTO v_timesheet_id
    FROM timesheets
    WHERE organization_id = p_organization_id
      AND shift_id = p_shift_id
      AND organization_worker_membership_id = p_membership_id;

    IF v_timesheet_id IS NULL THEN
        RAISE EXCEPTION 'accepted assignment required for timesheet';
    END IF;
    RETURN v_timesheet_id;
END;
$$;

REVOKE ALL ON FUNCTION app_record_timesheet_from_checkout(uuid, uuid, uuid, uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_timesheet_from_checkout(uuid, uuid, uuid, uuid, timestamptz, timestamptz) TO app_runtime;

-- Preserve completed staging history. Each accepted assignment receives only
-- its latest valid paired visit; no amount is invented when a rate is absent.
WITH paired_visits AS (
    SELECT DISTINCT ON (checkout.organization_id, checkout.shift_id, checkout.organization_worker_membership_id)
        checkout.organization_id,
        checkout.shift_id,
        checkout.organization_worker_membership_id,
        checkin.occurred_at AS check_in_at,
        checkout.occurred_at AS check_out_at
    FROM verification_events checkout
    JOIN LATERAL (
        SELECT candidate.occurred_at
        FROM verification_events candidate
        WHERE candidate.organization_id = checkout.organization_id
          AND candidate.shift_id = checkout.shift_id
          AND candidate.organization_worker_membership_id = checkout.organization_worker_membership_id
          AND candidate.event_type = 'check_in'
          AND candidate.occurred_at < checkout.occurred_at
        ORDER BY candidate.occurred_at DESC
        LIMIT 1
    ) checkin ON true
    WHERE checkout.event_type = 'check_out'
    ORDER BY checkout.organization_id, checkout.shift_id,
             checkout.organization_worker_membership_id, checkout.occurred_at DESC
)
INSERT INTO timesheets (
    organization_id, shift_id, assignment_id,
    organization_worker_membership_id, care_recipient_id,
    check_in_at, check_out_at, recorded_minutes,
    pay_rate_cents_snapshot, bill_rate_cents_snapshot, currency
)
SELECT
    paired.organization_id,
    paired.shift_id,
    assignment.id,
    paired.organization_worker_membership_id,
    shift.care_recipient_id,
    paired.check_in_at,
    paired.check_out_at,
    GREATEST(1, round(extract(epoch FROM (paired.check_out_at - paired.check_in_at)) / 60)::integer),
    rate.pay_rate_cents,
    rate.bill_rate_cents,
    COALESCE(rate.currency, 'USD')
FROM paired_visits paired
JOIN LATERAL (
    SELECT candidate.id
    FROM assignments candidate
    WHERE candidate.organization_id = paired.organization_id
      AND candidate.shift_id = paired.shift_id
      AND candidate.organization_worker_membership_id = paired.organization_worker_membership_id
      AND candidate.response_status = 'accepted'
    ORDER BY candidate.responded_at DESC NULLS LAST, candidate.created_at DESC
    LIMIT 1
) assignment ON true
JOIN shifts shift
  ON shift.id = paired.shift_id AND shift.organization_id = paired.organization_id
LEFT JOIN worker_financial_rates rate
  ON rate.organization_worker_membership_id = paired.organization_worker_membership_id
WHERE paired.check_out_at > paired.check_in_at
  AND extract(epoch FROM (paired.check_out_at - paired.check_in_at)) <= 172800
ON CONFLICT (organization_id, shift_id, organization_worker_membership_id) DO NOTHING;
