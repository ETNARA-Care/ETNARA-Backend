-- Migration 045: secure account invitations for workforce and Family.
-- Raw invitation tokens are never stored. Only SHA-256 hashes are persisted,
-- tokens expire after seven days, and acceptance is atomic and single-use.

CREATE TYPE access_invitation_type_enum AS ENUM ('worker', 'family');
CREATE TYPE access_invitation_status_enum AS ENUM ('pending', 'accepted', 'expired', 'revoked');

CREATE TABLE access_invitations (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         uuid NOT NULL REFERENCES organizations(id),
    invited_by_user_id      uuid NOT NULL REFERENCES users(id),
    invitation_type         access_invitation_type_enum NOT NULL,
    email                   text NOT NULL,
    worker_membership_id    uuid NULL,
    care_recipient_id       uuid NULL,
    relationship_type       text NULL,
    token_hash              text NOT NULL UNIQUE,
    status                  access_invitation_status_enum NOT NULL DEFAULT 'pending',
    expires_at              timestamptz NOT NULL,
    accepted_at             timestamptz NULL,
    revoked_at              timestamptz NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (worker_membership_id, organization_id)
        REFERENCES organization_worker_memberships (id, organization_id),
    FOREIGN KEY (care_recipient_id, organization_id)
        REFERENCES care_recipients (id, organization_id),
    CONSTRAINT access_invitations_target_matches_type CHECK (
        (invitation_type = 'worker' AND worker_membership_id IS NOT NULL
            AND care_recipient_id IS NULL AND relationship_type IS NULL)
        OR
        (invitation_type = 'family' AND care_recipient_id IS NOT NULL
            AND worker_membership_id IS NULL AND relationship_type IS NOT NULL)
    )
);

CREATE UNIQUE INDEX access_invitations_one_pending_worker
    ON access_invitations (organization_id, worker_membership_id, lower(email))
    WHERE status = 'pending' AND invitation_type = 'worker';

CREATE UNIQUE INDEX access_invitations_one_pending_family
    ON access_invitations (organization_id, care_recipient_id, lower(email))
    WHERE status = 'pending' AND invitation_type = 'family';

ALTER TABLE access_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY access_invitations_manager_read ON access_invitations
    FOR SELECT
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
        OR app_is_superadmin()
    );

CREATE POLICY access_invitations_manager_insert ON access_invitations
    FOR INSERT
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND invited_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        AND app_is_org_manager()
        OR app_is_superadmin()
    );

CREATE POLICY access_invitations_manager_update ON access_invitations
    FOR UPDATE
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
        OR app_is_superadmin()
    )
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
        OR app_is_superadmin()
    );

-- The runtime role was created before this table, so grant only the exact
-- table privileges needed by the manager-facing service. No DELETE is granted.
GRANT SELECT, INSERT, UPDATE ON access_invitations TO app_runtime;

-- /me runs before an organization is selected. These narrowly-scoped helpers
-- answer only whether the CURRENT signed-in user still has an active Worker or
-- Family access anchor in the requested organization. SECURITY DEFINER avoids
-- recursive RLS between workers and memberships; the caller cannot inspect a
-- different user because p_user_id must equal app.current_user_id.
CREATE OR REPLACE FUNCTION app_self_has_active_worker_access(p_user_id uuid, p_organization_id uuid)
RETURNS boolean AS $$
    SELECT p_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
       AND EXISTS (
            SELECT 1 FROM public.workers w
            JOIN public.organization_worker_memberships owm ON owm.worker_id = w.id
            WHERE w.user_id = p_user_id
              AND owm.organization_id = p_organization_id
              AND owm.status = 'active'
       );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION app_self_has_active_family_access(p_user_id uuid, p_organization_id uuid)
RETURNS boolean AS $$
    SELECT p_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
       AND EXISTS (
            SELECT 1 FROM public.family_relationships fr
            WHERE fr.user_id = p_user_id
              AND fr.organization_id = p_organization_id
              AND fr.status = 'active'
       );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION app_self_has_active_worker_access(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_self_has_active_family_access(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_self_has_active_worker_access(uuid, uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION app_self_has_active_family_access(uuid, uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION app_inspect_access_invitation(p_token_hash text)
RETURNS TABLE (
    invitation_type text,
    email_masked text,
    organization_name text,
    target_name text,
    account_exists boolean,
    expires_at timestamptz
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        ai.invitation_type::text,
        left(ai.email, 1) || '***@' || split_part(ai.email, '@', 2),
        o.name,
        CASE
            WHEN ai.invitation_type = 'worker' THEN coalesce(w.display_name, 'Personal de cuidado')
            ELSE coalesce(cr.preferred_name, cr.first_name || ' ' || cr.last_name)
        END,
        EXISTS (SELECT 1 FROM public.users u WHERE lower(u.email) = lower(ai.email)),
        ai.expires_at
    FROM public.access_invitations ai
    JOIN public.organizations o ON o.id = ai.organization_id
    LEFT JOIN public.organization_worker_memberships owm ON owm.id = ai.worker_membership_id
    LEFT JOIN public.workers w ON w.id = owm.worker_id
    LEFT JOIN public.care_recipients cr ON cr.id = ai.care_recipient_id
    WHERE ai.token_hash = p_token_hash
      AND ai.status = 'pending'
      AND ai.expires_at > now()
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVITATION_NOT_AVAILABLE';
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

-- Accepts either a brand-new account (password hash supplied) or an already
-- authenticated account (existing user id supplied). It never resets an
-- existing password and verifies that the account email matches the invite.
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
    SELECT * INTO v_inv
    FROM public.access_invitations ai
    WHERE ai.token_hash = p_token_hash
    FOR UPDATE;

    IF NOT FOUND OR v_inv.status <> 'pending' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVITATION_NOT_AVAILABLE';
    END IF;
    IF v_inv.expires_at <= now() THEN
        UPDATE public.access_invitations
        SET status = 'expired', updated_at = now()
        WHERE id = v_inv.id;
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVITATION_EXPIRED';
    END IF;

    SELECT * INTO v_existing
    FROM public.users u
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
        RETURNING id INTO v_user_id;
    END IF;

    INSERT INTO public.organization_memberships (user_id, organization_id, status, revoked_at, updated_at)
    VALUES (v_user_id, v_inv.organization_id, 'active', NULL, now())
    ON CONFLICT (user_id, organization_id) DO UPDATE
      SET status = 'active', revoked_at = NULL, updated_at = now()
    RETURNING id INTO v_membership_id;

    SELECT r.id INTO v_role_id
    FROM public.roles r
    WHERE r.code = CASE WHEN v_inv.invitation_type = 'worker' THEN 'WORKER' ELSE 'FAMILY' END
    LIMIT 1;
    IF v_role_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ROLE_NOT_CONFIGURED';
    END IF;

    INSERT INTO public.user_roles (organization_membership_id, organization_id, role_id)
    VALUES (v_membership_id, v_inv.organization_id, v_role_id)
    ON CONFLICT (organization_membership_id, role_id) DO NOTHING;

    IF v_inv.invitation_type = 'worker' THEN
        SELECT owm.worker_id INTO v_worker_id
        FROM public.organization_worker_memberships owm
        WHERE owm.id = v_inv.worker_membership_id
          AND owm.organization_id = v_inv.organization_id
          AND owm.status = 'active';
        IF v_worker_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'WORKER_NOT_ACTIVE';
        END IF;

        UPDATE public.workers
        SET user_id = v_user_id, updated_at = now()
        WHERE id = v_worker_id AND (user_id IS NULL OR user_id = v_user_id);
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
        ON CONFLICT (user_id, care_recipient_id) DO UPDATE
          SET organization_id = EXCLUDED.organization_id,
              relationship_type = EXCLUDED.relationship_type,
              status = 'active', revoked_at = NULL;
    END IF;

    UPDATE public.access_invitations
    SET status = 'accepted', accepted_at = now(), updated_at = now()
    WHERE id = v_inv.id;

    RETURN QUERY SELECT v_user_id, v_inv.organization_id, v_inv.invitation_type::text;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION app_inspect_access_invitation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_activate_access_invitation(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_inspect_access_invitation(text) TO app_runtime;
GRANT EXECUTE ON FUNCTION app_activate_access_invitation(text, text, uuid) TO app_runtime;
