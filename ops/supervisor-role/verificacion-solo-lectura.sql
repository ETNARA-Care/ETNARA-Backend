-- B4 · Paso 3 · VERIFICACIÓN después de la corrección · SOLO LECTURA (un único SELECT)
-- Esperado: supervisora = SUPERVISOR; admin = ORGANIZATION_ADMIN; maria y carlos = WORKER; familia = FAMILY;
-- administradoras_casa_demo igual que antes menos 1; ultima_auditoria = STAFF_ROLE_CORRECTED.
SELECT split_part(u.email, '@', 1) AS cuenta,
       u.status AS estado,
       COALESCE((SELECT string_agg(DISTINCT r.code, ', ')
                   FROM organization_memberships om
                   JOIN user_roles ur ON ur.organization_membership_id = om.id
                   JOIN roles r ON r.id = ur.role_id
                  WHERE om.user_id = u.id AND om.status = 'active'), '—') AS roles,
       (SELECT count(*) FROM organization_memberships om
         WHERE om.user_id = u.id AND om.status = 'active') AS agencias,
       (SELECT count(DISTINCT om.id) FROM organization_memberships om
          JOIN user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
          JOIN roles r ON r.id = ur.role_id
         WHERE om.organization_id = 'febe519d-3504-4488-a741-d962db40be89' AND om.status = 'active'
           AND r.code = 'ORGANIZATION_ADMIN') AS administradoras_casa_demo,
       (SELECT a.action || ' ' || to_char(a.occurred_at AT TIME ZONE 'America/Puerto_Rico', 'DD-MM HH24:MI')
          FROM audit_log a
         WHERE a.action IN ('STAFF_ROLE_CORRECTED', 'STAFF_ROLE_CORRECTION_REVERTED')
           AND a.organization_id = 'febe519d-3504-4488-a741-d962db40be89'
         ORDER BY a.occurred_at DESC LIMIT 1) AS ultima_auditoria,
       (SELECT count(*) FROM platform_admins p WHERE p.user_id = u.id AND p.revoked_at IS NULL) AS central
FROM users u
WHERE lower(u.email) IN ('etnaracare+demo-admin@gmail.com', 'etnaracare+demo-supervisor@gmail.com',
                         'etnaracare+demo-maria@gmail.com', 'etnaracare+demo-carlos@gmail.com',
                         'etnaracare+demo-familia@gmail.com')
ORDER BY 1;
