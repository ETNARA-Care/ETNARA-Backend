# Auditoría de agencias y expedientes — 22 octubre 2026

## Alcance verificado (lectura de código, no prueba de producción)
- `src/modules/establishmentDocuments/establishmentDocuments.routes.ts`: listar, historial, cargar, revisar, descargar y archivar.
- `src/modules/residentDocuments/residentDocuments.routes.ts`: listar, cargar, descargar y archivar.
- Servicios correspondientes: operaciones bajo `withTenantContext`, filtro por organización/establecimiento; archivos en almacenamiento privado.
- `docs/security/ISSUE_170_PLATFORM_PHI_BOUNDARY.md`: auditoría de accesos privilegiados aún pendiente de remediación.

## Hallazgos que bloquean la aceptación de seguridad
1. **Privilegios globales**: `allowed()` de documentos de establecimientos y `assertManager()` de documentos de residentes permiten `app_is_superadmin()`. Es incompatible con la política de ETNARA Administración sin acceso a expedientes privados. No cambiar aisladamente sin auditar todas las políticas RLS.
2. **Revisión de establecimientos**: `reviewEstablishmentDocument()` requiere `app_is_superadmin()`; el flujo actual presupone que ETNARA central revisa documentos del establecimiento. Definir revisión por autoridad de la agencia o metadatos de verificación separados antes de modificar permisos.
3. **Descarga de documentos de establecimientos archivados**: `getEstablishmentDocumentDownload()` no comprueba `archived_at IS NULL`. Definir acceso histórico expresamente autorizado; por defecto impedir descargar versiones archivadas mediante el endpoint corriente.
4. **Carga de archivos**: validar MIME permitido, firma/magic bytes, tamaño cero, límites y limpieza de objetos si la transacción de BD falla; no confiar solo en Content-Type declarado por cliente.
5. **Almacenamiento**: el objeto se sube dentro de la transacción SQL. Si falla el INSERT/UPDATE, puede quedar un objeto privado huérfano; añadir reconciliación idempotente.
6. **Pruebas negativas**: comprobar administrador de plataforma sin membresía, agencia A frente a B, acceso a archivo de residente de otro establecimiento, versión archivada, revocación de permisos y rechazo con motivo.

## Plan de cierre sin Railway
- P0: auditoría de privilegios globales y RLS; corregir en migración revisada y probar en PostgreSQL efímero.
- P0: definir dueño de la aprobación documental y evitar acceso de ETNARA central a archivos de agencias.
- P1: pruebas de rutas/servicios de documentos con usuarios sintéticos y comprobación de 403/404.
- P1: corregir descarga archivada y endurecer validaciones de subida con pruebas.
- P2: probar el recorrido completo desde el portal de agencias con almacenamiento de pruebas.
- P2: desplegar en staging físicamente separado; nunca usar la BD de producción.

**Estado**: auditoría estática inicial; no implica certificación de seguridad ni cambios desplegados.
