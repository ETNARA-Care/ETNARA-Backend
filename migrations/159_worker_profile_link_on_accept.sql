-- 159: una persona, un perfil de cuidador, también al aceptar invitaciones. 23-nov-2026.
--
-- Problema (LaCasita de Tony, 23-nov-2026): workers.user_id es UNIQUE (006: un perfil global por cuenta, unido a cada
-- organización por organization_worker_memberships). El flujo de invitación crea una ficha NUEVA (perfil sin cuenta) y
-- al aceptar intentaba vincularla a la cuenta. Si la cuenta ya tenía su perfil (en otra organización o en la misma),
-- fallaba con workers_user_id_key → 500. Afectaba a cualquier cuidadora con perfil que se uniera a otra organización y a
-- una administradora con perfil previo que quisiera ser también cuidadora.
--
-- Qué cambia (solo la rama de invitación de CUIDADOR de app_activate_access_invitation, definida en 046):
--   · Sin perfil propio, o es el mismo: comportamiento idéntico a 046.
--   · La cuenta ya tiene su perfil:
--       - si ya es cuidadora en esa organización → WORKER_ALREADY_IN_ORGANIZATION, sin cambios;
--       - si la ficha de la invitación no está vacía (cuenta, credenciales, documentos, archivos u otras membresías)
--         → WORKER_PROFILE_CONFLICT, sin cambios;
--       - si está vacía → la membresía de esa organización pasa a apuntar al perfil único. Turnos, asignaciones,
--         horas y demás cuelgan del id de la membresía y no cambian. La ficha provisional queda sin uso: no se borra.
--         Auditado (WORKER_PROFILE_LINKED_ON_ACCEPT).
--   · Todo en la misma transacción, con FOR UPDATE sobre la membresía y el perfil. Una agencia nunca elige ni vincula el
--     perfil de otra persona: la unión ocurre solo al aceptar, con la identidad ya comprobada (INVITATION_IDENTITY_MISMATCH).
-- Qué NO cambia: invitaciones de familia, roles (WORKER se añade sin quitar otros), creación de cuentas nuevas,
-- invitaciones administrativas (052/085), RLS, permisos. Firma y GRANT de la función idénticos.
-- Idempotente (CREATE OR REPLACE). Reversión: ops/159_worker_profile_link_on_accept.rollback.sql (restaura 046).

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
    v_own_worker_id uuid;
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
          AND owm.status = 'active'
        FOR UPDATE;
        IF v_worker_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'WORKER_NOT_ACTIVE';
        END IF;

        -- 159: una persona, un perfil. ¿La cuenta ya tiene su perfil de cuidador (en esta u otra organización)?
        SELECT own.id INTO v_own_worker_id
        FROM public.workers AS own
        WHERE own.user_id = v_user_id
        FOR UPDATE;

        IF v_own_worker_id IS NULL OR v_own_worker_id = v_worker_id THEN
            -- Sin perfil propio (o es el mismo): comportamiento de 046, sin cambios.
            UPDATE public.workers AS target_worker
            SET user_id = v_user_id, updated_at = now()
            WHERE target_worker.id = v_worker_id
              AND (target_worker.user_id IS NULL OR target_worker.user_id = v_user_id);
            GET DIAGNOSTICS v_rows = ROW_COUNT;
            IF v_rows <> 1 THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'WORKER_ALREADY_LINKED';
            END IF;
        ELSE
            -- Ya es cuidadora en esta organización: nada que unir, no se duplica.
            IF EXISTS (SELECT 1 FROM public.organization_worker_memberships AS mine
                       WHERE mine.worker_id = v_own_worker_id AND mine.organization_id = v_inv.organization_id) THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'WORKER_ALREADY_IN_ORGANIZATION';
            END IF;
            -- La ficha provisional de la invitación debe estar vacía: sin cuenta, credenciales, documentos,
            -- archivos ni otras membresías. Si no, no se mueve nada (lo resuelve la agencia o soporte).
            IF EXISTS (SELECT 1 FROM public.workers AS ph WHERE ph.id = v_worker_id AND ph.user_id IS NOT NULL) THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'WORKER_ALREADY_LINKED';
            END IF;
            IF EXISTS (SELECT 1 FROM public.credentials AS c WHERE c.worker_id = v_worker_id)
               OR EXISTS (SELECT 1 FROM public.documents AS d WHERE d.worker_id = v_worker_id)
               OR EXISTS (SELECT 1 FROM public.stored_files AS sf WHERE sf.owner_worker_id = v_worker_id)
               OR EXISTS (SELECT 1 FROM public.organization_worker_memberships AS other
                          WHERE other.worker_id = v_worker_id AND other.id <> v_inv.worker_membership_id) THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'WORKER_PROFILE_CONFLICT';
            END IF;
            -- Unir la ficha de esta organización al perfil único. Turnos, asignaciones y horas cuelgan de la
            -- membresía (id), así que no cambian. La ficha provisional queda sin uso; no se borra.
            UPDATE public.organization_worker_memberships AS target_membership
            SET worker_id = v_own_worker_id, updated_at = now()
            WHERE target_membership.id = v_inv.worker_membership_id;
            INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, previous_value, new_value)
            VALUES (v_user_id, v_inv.organization_id, v_inv.organization_id, 'WORKER_PROFILE_LINKED_ON_ACCEPT',
                    'organization_worker_membership', v_inv.worker_membership_id,
                    jsonb_build_object('workerId', v_worker_id), jsonb_build_object('workerId', v_own_worker_id, 'invitationId', v_inv.id));
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
