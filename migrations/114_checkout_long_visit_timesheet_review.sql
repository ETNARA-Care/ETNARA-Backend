-- Migration 114: a visit left open for more than 48 h can be finished.
--
-- Incident 24-oct-2026: POST .../check-out answered 500 on every retry. The
-- check-out calls app_record_timesheet_from_checkout (058), which RAISEd
-- 'invalid timesheet window' when check-in -> check-out was longer than 48 h
-- (the timesheet table only accepts 1..2880 minutes). The whole transaction
-- rolled back: the caregiver could never finish the visit, the shift stayed
-- «en curso», and the supervisor override hit the same error.
--
-- Now, for a window longer than 48 h the function records no automatic
-- timesheet (those hours cannot be right without a human looking at them),
-- writes an audit entry and asks the agency managers to review the hours
-- (TIMESHEET_NEEDS_REVIEW, one per manager and shift). It returns NULL and the
-- check-out completes normally. Every other rule of 058 is unchanged: same
-- context and authority checks, check-out must be after check-in, accepted
-- assignment required, rate snapshot, idempotent per shift and membership.
-- No data is modified by this migration. Grants are kept (CREATE OR REPLACE).

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_timesheet_review_once
  ON notifications (user_id, notification_type, related_entity_id)
  WHERE notification_type = 'TIMESHEET_NEEDS_REVIEW';

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

    IF p_check_out_at <= p_check_in_at THEN
        RAISE EXCEPTION 'invalid timesheet window';
    END IF;

    -- 114: longer than 48 h -> no automatic timesheet; the agency reviews it.
    IF extract(epoch FROM (p_check_out_at - p_check_in_at)) > 172800 THEN
        IF NOT EXISTS (
            SELECT 1 FROM assignments assignment
            WHERE assignment.organization_id = p_organization_id
              AND assignment.shift_id = p_shift_id
              AND assignment.organization_worker_membership_id = p_membership_id
              AND assignment.response_status = 'accepted'
        ) THEN
            RAISE EXCEPTION 'accepted assignment required for timesheet';
        END IF;
        PERFORM app_notify_shift_managers(p_organization_id, p_shift_id, 'TIMESHEET_NEEDS_REVIEW');
        INSERT INTO audit_log (
            actor_user_id, organization_id, target_organization_id,
            action, entity_type, entity_id, new_value
        ) VALUES (
            p_actor_user_id, p_organization_id, p_organization_id,
            'TIMESHEET_SKIPPED_LONG_VISIT', 'shift', p_shift_id,
            jsonb_build_object('membershipId', p_membership_id,
                               'minutes', round(extract(epoch FROM (p_check_out_at - p_check_in_at)) / 60)::integer)
        );
        RETURN NULL;
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
