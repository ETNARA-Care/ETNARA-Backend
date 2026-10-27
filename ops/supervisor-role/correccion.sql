-- B4 · Paso 2 (v2) · Supervisora demo: ORGANIZATION_ADMIN -> SUPERVISOR · ESCRIBE (requiere autorización de Rafa)
-- Un solo bloque = una sola transacción. Cualquier error revierte TODO (rol nuevo, rol quitado y auditoría).
DO $$
DECLARE
  c_email     constant text := 'etnaracare+demo-supervisor@gmail.com';
  c_org       constant uuid := 'febe519d-3504-4488-a741-d962db40be89';
  c_org_name  constant text := 'Cuidado en Casa Demo';
  v_user uuid; v_memb uuid; v_rol_sup uuid; v_rol_admin uuid;
  v_ur_admin uuid; v_ur_admin_desde timestamptz; v_ur_sup uuid; v_audit uuid;
  v_roles text; v_n int; v_otras int; v_otros_antes text; v_otros_despues text;
BEGIN
  -- Si algo está bloqueado más de 5 s, se aborta en vez de esperar.
  PERFORM set_config('lock_timeout', '5s', true);

  -- 1. Mismo candado que usa la app para cambiar roles en esta agencia.
  PERFORM pg_advisory_xact_lock(hashtext('team-roles:' || c_org::text));

  -- 2. Roles del sistema.
  v_rol_sup   := (SELECT id FROM roles WHERE code = 'SUPERVISOR');
  v_rol_admin := (SELECT id FROM roles WHERE code = 'ORGANIZATION_ADMIN');
  IF v_rol_sup IS NULL OR v_rol_admin IS NULL THEN RAISE EXCEPTION 'ABORTADO: falta el rol SUPERVISOR u ORGANIZATION_ADMIN'; END IF;

  -- 3. Agencia: por id y por nombre, activa (bloqueada).
  PERFORM 1 FROM organizations WHERE id = c_org AND name = c_org_name AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ABORTADO: la agencia no coincide (id, nombre o estado)'; END IF;

  -- 4. Cuenta: exactamente una con ese correo, activa (bloqueada).
  v_n := (SELECT count(*) FROM users WHERE lower(email) = c_email);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ABORTADO: cuentas con ese correo = %', v_n; END IF;
  v_user := (SELECT id FROM users WHERE lower(email) = c_email AND status = 'active' FOR SHARE);
  IF v_user IS NULL THEN RAISE EXCEPTION 'ABORTADO: la cuenta no está activa'; END IF;

  -- 5. Una sola membresía activa, y es en Casa Demo (bloqueada).
  v_n := (SELECT count(*) FROM organization_memberships WHERE user_id = v_user AND status = 'active');
  IF v_n <> 1 THEN RAISE EXCEPTION 'ABORTADO: membresías activas = %', v_n; END IF;
  v_memb := (SELECT id FROM organization_memberships
              WHERE user_id = v_user AND organization_id = c_org AND status = 'active' FOR UPDATE);
  IF v_memb IS NULL THEN RAISE EXCEPTION 'ABORTADO: la membresía activa no es de Casa Demo'; END IF;

  -- 6. Bloquear todas las filas de rol de la agencia; huella de las que NO son de esta cuenta.
  PERFORM 1 FROM user_roles WHERE organization_id = c_org FOR UPDATE;
  v_otros_antes := (SELECT string_agg(id::text || ':' || organization_membership_id::text || ':' || role_id::text, ',' ORDER BY id)
                      FROM user_roles WHERE organization_id = c_org AND organization_membership_id <> v_memb);

  -- 7. Roles actuales: exactamente ORGANIZATION_ADMIN, y esa fila es de Casa Demo.
  v_roles := (SELECT string_agg(r.code, ',' ORDER BY r.code)
                FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.organization_membership_id = v_memb);
  IF v_roles IS DISTINCT FROM 'ORGANIZATION_ADMIN' THEN RAISE EXCEPTION 'ABORTADO: roles actuales = %', coalesce(v_roles, 'ninguno'); END IF;
  v_ur_admin := (SELECT id FROM user_roles
                  WHERE organization_membership_id = v_memb AND organization_id = c_org AND role_id = v_rol_admin);
  IF v_ur_admin IS NULL THEN RAISE EXCEPTION 'ABORTADO: la fila de ORGANIZATION_ADMIN no es de Casa Demo'; END IF;
  v_ur_admin_desde := (SELECT created_at FROM user_roles WHERE id = v_ur_admin);

  -- 8. Debe quedar al menos otra administradora activa.
  v_otras := (SELECT count(DISTINCT om.id) FROM organization_memberships om
                JOIN user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
                JOIN users u ON u.id = om.user_id
               WHERE om.organization_id = c_org AND om.status = 'active' AND u.status = 'active'
                 AND ur.role_id = v_rol_admin AND om.id <> v_memb);
  IF v_otras < 1 THEN RAISE EXCEPTION 'ABORTADO: no quedaría otra administradora'; END IF;

  -- 9. Cambios, cada uno con su número de filas comprobado.
  INSERT INTO user_roles (organization_membership_id, organization_id, role_id)
  VALUES (v_memb, c_org, v_rol_sup) RETURNING id INTO v_ur_sup;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'ABORTADO: filas insertadas = %', v_n; END IF;

  DELETE FROM user_roles WHERE id = v_ur_admin AND organization_membership_id = v_memb AND role_id = v_rol_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'ABORTADO: filas eliminadas = %', v_n; END IF;

  INSERT INTO audit_log (actor_user_id, organization_id, action, entity_type, entity_id, previous_value, new_value, device_metadata)
  VALUES (NULL, c_org, 'STAFF_ROLE_CORRECTED', 'organization_membership', v_memb,
          jsonb_build_object('roles', jsonb_build_array('ORGANIZATION_ADMIN'), 'user_role_id', v_ur_admin, 'rol_desde', v_ur_admin_desde),
          jsonb_build_object('roles', jsonb_build_array('SUPERVISOR'), 'user_role_id', v_ur_sup,
                             'motivo', 'B4: la cuenta demo de supervisora tenia rol de administradora'),
          jsonb_build_object('via', 'consulta SQL manual en Railway', 'autorizado_por', 'Rafa', 'referencia', 'B4'))
  RETURNING id INTO v_audit;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 OR v_audit IS NULL THEN RAISE EXCEPTION 'ABORTADO: auditoría no registrada'; END IF;

  -- 10. Comprobación final dentro de la misma transacción.
  v_roles := (SELECT string_agg(r.code, ',' ORDER BY r.code)
                FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.organization_membership_id = v_memb);
  IF v_roles IS DISTINCT FROM 'SUPERVISOR' THEN RAISE EXCEPTION 'ABORTADO: roles finales = %', coalesce(v_roles, 'ninguno'); END IF;
  v_otros_despues := (SELECT string_agg(id::text || ':' || organization_membership_id::text || ':' || role_id::text, ',' ORDER BY id)
                        FROM user_roles WHERE organization_id = c_org AND organization_membership_id <> v_memb);
  IF v_otros_despues IS DISTINCT FROM v_otros_antes THEN RAISE EXCEPTION 'ABORTADO: cambiaron roles de otras cuentas'; END IF;

  RAISE NOTICE 'CORRECCION_APLICADA membresia=% rol_nuevo=% rol_quitado=% auditoria=%', v_memb, v_ur_sup, v_ur_admin, v_audit;
END $$;
