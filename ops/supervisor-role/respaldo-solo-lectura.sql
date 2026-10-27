-- B4 · Paso 1 · RESPALDO del estado actual de la supervisora demo · SOLO LECTURA (un único SELECT)
-- Guarda una captura del resultado: es la referencia exacta para verificar y, si hiciera falta, revertir.
SELECT u.email                                         AS cuenta,
       u.status                                        AS estado_cuenta,
       o.name                                          AS agencia,
       om.organization_id                              AS agencia_id,
       om.id                                           AS membresia_id,
       om.status                                       AS estado_membresia,
       ur.id                                           AS user_role_id,
       r.code                                          AS rol,
       ur.created_at                                   AS rol_desde,
       (SELECT count(DISTINCT om2.id)
          FROM organization_memberships om2
          JOIN user_roles ur2 ON ur2.organization_membership_id = om2.id AND ur2.organization_id = om2.organization_id
          JOIN roles r2 ON r2.id = ur2.role_id
          JOIN users u2 ON u2.id = om2.user_id
         WHERE om2.organization_id = om.organization_id AND om2.status = 'active'
           AND u2.status = 'active' AND r2.code = 'ORGANIZATION_ADMIN')   AS administradoras_activas_en_agencia,
       (SELECT count(*) FROM roles WHERE code = 'SUPERVISOR')             AS existe_rol_supervisor
FROM users u
JOIN organization_memberships om ON om.user_id = u.id
JOIN organizations o ON o.id = om.organization_id
LEFT JOIN user_roles ur ON ur.organization_membership_id = om.id
LEFT JOIN roles r ON r.id = ur.role_id
WHERE lower(u.email) = 'etnaracare+demo-supervisor@gmail.com'
ORDER BY om.id, r.code;
