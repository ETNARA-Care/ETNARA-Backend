-- ROLLBACK of migration 114 (check-out of visits open > 48 h). NOT recommended:
-- it brings the incident back (check-out of a visit open > 48 h answers 500 and
-- the visit can never be finished). A code-only rollback does NOT need this:
-- the previous backend works with 114 (same function signature).
-- Restores the exact 058 definition and removes the 114 notice index; the
-- TIMESHEET_NEEDS_REVIEW notices and audit rows already written are kept.
-- Never touches migration 113 (En Camino, #205). Run as the database owner, in one go.
BEGIN;
DROP INDEX IF EXISTS idx_notifications_timesheet_review_once;
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
DELETE FROM schema_migrations WHERE filename = '114_checkout_long_visit_timesheet_review.sql';
COMMIT;
