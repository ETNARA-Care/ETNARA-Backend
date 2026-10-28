SELECT
  (SELECT string_agg(filename, ', ' ORDER BY filename) FROM schema_migrations WHERE filename >= '127') AS migraciones_recientes,
  (SELECT count(*) FROM schema_migrations WHERE filename ~ '^13[0-5]_') AS migraciones_130_135_ya_aplicadas,
  (SELECT to_regclass('public.shift_schedule_corrections') IS NOT NULL) AS tabla_135_ya_existe,
  (SELECT count(*) FROM pg_proc WHERE proname IN ('app_my_shift_preview', 'app_worker_messaging_window', 'app_correct_shift_schedule')) AS funciones_nuevas_ya_existentes,
  (SELECT count(*) FROM shifts WHERE scheduled_start <= now() AND status IN ('confirmed', 'unassigned')) AS turnos_comenzados_sin_cerrar,
  (SELECT count(*) FROM assignments a JOIN shifts s ON s.id = a.shift_id
    WHERE a.response_status = 'pending' AND s.scheduled_end > now()) AS asignaciones_pendientes_futuras,
  (SELECT count(DISTINCT om.id) FROM organization_memberships om
     JOIN user_roles ur ON ur.organization_membership_id = om.id
     JOIN roles r ON r.id = ur.role_id
     JOIN users u ON u.id = om.user_id
    WHERE r.code = 'SUPERVISOR' AND om.status = 'active'
      AND lower(u.email) NOT LIKE 'etnaracare+demo-%') AS supervisoras_no_demo,
  (SELECT count(*) FROM organization_worker_memberships WHERE status = 'inactive') AS cuidadoras_inactivas
