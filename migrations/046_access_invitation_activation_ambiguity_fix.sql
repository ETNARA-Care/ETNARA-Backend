-- Hotfix 5.7: qualify every column that can collide with the OUT parameters
-- of app_activate_access_invitation. PostgreSQL exposes RETURNS TABLE names
-- as PL/pgSQL variables, so an unqualified workers.user_id reference made
-- worker activation fail at runtime with an ambiguous-column error.

CREATE OR REPLACE FUNCTION app_activate_access_invitation(
    p_token_hash text,
    p_password_hash text DEFAULT NULL,
    p_existing_user_id uuid DEFAULT NULL
)
RETURNS TABLE (user_id uuid, organization_id uuid, invitation_type text) AS $$
DECLARE
    v_inv public.access_invitations%ROWTYPE;
    v_existing public.users%ROWTYPE;
    v_user_id uuid;
    v_membership_id uuid;
    v_role_id uuid;
    v_worker_id uuid;
    v_rows integer;
BEGIN
    SELECT ai.* INTO v_inv
    FROM public.access_invitations AS ai
    WHERE ai.token_hash = p_token_hash
    FOR UPDATE;

    IF NOT FOUND OR v_inv.status <> 'pending' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVITATION_NOT_AVAILABLE';
    END IF;
    IF v_inv.expires_at <= now() THEN
        UPDATE public.access_invitations AS ai
        SET status = 'expired', updated_at = now()
        WHERE ai.id = v_inv.id;
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVITATION_EXPIRED';
    END IF;

    SELECT u.* INTO v_existing
    FROM public.users AS u
    WHERE lower(u.email) = lower(v_inv.email)
    LIMIT 1;

    IF FOUND THEN
        IF p_existing_user_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ACCOUNT_ALREADY_EXISTS';
        END IF;
        IF v_existing.id <> p_existing_user_id THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVITATION_IDENTITY_MISMATCH';
        END IF;
        IF v_existing.status <> 'active' THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ACCOUNT_DISABLED';
        END IF;
        v_user_id := v_existing.id;
    ELSE
        IF p_existing_user_id IS NOT NULL OR p_password_hash IS NULL OR length(p_password_hash) < 20 THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_ACTIVATION';
        END IF;
        INSERT INTO public.users (email, password_hash, status)
        VALUES (lower(v_inv.email), p_password_hash, 'active')
        RETURNING users.id INTO v_user_id;
    END IF;

    INSERT INTO public.organization_memberships (user_id, organization_id, status, revoked_at, updated_at)
    VALUES (v_user_id, v_inv.organization_id, 'active', NULL, now())
    ON CONFLICT ON CONSTRAINT organization_memberships_user_id_organization_id_key DO UPDATE
      SET status = 'active', revoked_at = NULL, updated_at = now()
    RETURNING organization_memberships.id INTO v_membership_id;

    SELECT r.id INTO v_role_id
    FROM public.roles AS r
    WHERE r.code = CASE WHEN v_inv.invitation_type = 'worker' THEN 'WORKER' ELSE 'FAMILY' END
    LIMIT 1;
    IF v_role_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ROLE_NOT_CONFIGURED';
    END IF;

    INSERT INTO public.user_roles (organization_membership_id, organization_id, role_id)
    VALUES (v_membership_id, v_inv.organization_id, v_role_id)
    ON CONFLICT ON CONSTRAINT user_roles_organization_membership_id_role_id_key DO NOTHING;

    IF v_inv.invitation_type = 'worker' THEN
        SELECT owm.worker_id INTO v_worker_id
        FROM public.organization_worker_memberships AS owm
        WHERE owm.id = v_inv.worker_membership_id
          AND owm.organization_id = v_inv.organization_id
          AND owm.status = 'active';
        IF v_worker_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'WORKER_NOT_ACTIVE';
        END IF;

        UPDATE public.workers AS target_worker
        SET user_id = v_user_id, updated_at = now()
        WHERE target_worker.id = v_worker_id
          AND (target_worker.user_id IS NULL OR target_worker.user_id = v_user_id);
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows <> 1 THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'WORKER_ALREADY_LINKED';
        END IF;
    ELSE
        INSERT INTO public.family_relationships (
            user_id, organization_id, care_recipient_id, relationship_type,
            status, revoked_at
        ) VALUES (
            v_user_id, v_inv.organization_id, v_inv.care_recipient_id,
            v_inv.relationship_type, 'active', NULL
        )
        ON CONFLICT ON CONSTRAINT family_relationships_user_id_care_recipient_id_key DO UPDATE
          SET organization_id = EXCLUDED.organization_id,
              relationship_type = EXCLUDED.relationship_type,
              status = 'active', revoked_at = NULL;
    END IF;

    UPDATE public.access_invitations AS ai
    SET status = 'accepted', accepted_at = now(), updated_at = now()
    WHERE ai.id = v_inv.id;

    RETURN QUERY SELECT v_user_id, v_inv.organization_id, v_inv.invitation_type::text;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION app_activate_access_invitation(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_activate_access_invitation(text, text, uuid) TO app_runtime;
