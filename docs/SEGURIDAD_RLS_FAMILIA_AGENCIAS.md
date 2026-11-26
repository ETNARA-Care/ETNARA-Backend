# Familia y RLS en agencias e independientes — investigación (26-nov-2026)

Autorizada por Rafa el 26-nov-2026, separada de hogares (F5 cierra el mismo hallazgo para hogares en la 177).
Solo bases desechables con datos ficticios; nada en producción.

## Hallazgo
Con `app_runtime` (el rol de producción desde el 31-oct) y el contexto de un usuario **solo familia**, la RLS permite
leer filas que no son de su familiar:

| Tabla | Qué puede leer la familia | Por qué |
|---|---|---|
| `users` | correo y teléfono de **todos** los miembros de la organización (administración y personal) | política por membresía activa |
| `credentials` | credenciales de **todo** el personal | `credentials_worker_scope` exige solo una membresía de empleado activa en la organización actual, no el rol de quien lee |
| `assignments` | asignaciones de **otros** residentes | `assignments_member_read` (cualquier miembro activo) |
| `workers`, `organization_worker_memberships` | todo el personal | lectura por organización compartida |
| `organization_memberships`, `user_roles` | quién es miembro y con qué rol | necesarias para algunas funciones; sin datos de contacto |

No puede leer otros residentes (`care_recipients`), sus actividades, incidentes ni conversaciones: esas políticas sí
filtran por la relación familiar.

## ¿Hay exposición real en producción?
**No se encontró ninguna.** `scripts/verifyFamilyExposure.ts` llama como el familiar a **todas las rutas GET**
registradas (144, de la organización y de /me), con ids reales de su familiar y de otro residente, en una agencia y en
un independiente, con incidentes, actividades y conversaciones creados. Ninguna respuesta contiene correos o teléfonos
del personal o de la administración, credenciales, el nombre de una empleada no asignada, otro residente ni su turno.
La familia solo llega a los datos por la API (no ejecuta SQL), así que hoy la exposición es teórica.

## Severidad: MEDIA
- **Impacto si se explotara:** datos de contacto personales del personal y la administración, metadatos de
  credenciales y horarios de asignaciones de otros residentes. No hay datos de salud ni de otros residentes.
- **Probabilidad:** baja. Haría falta un fallo nuevo en una ruta (una consulta que confíe solo en la RLS) o una
  inyección SQL. La RLS es justamente la segunda capa para ese caso, y hoy no la cumple para la familia.
- **No es crítica:** ninguna vía de explotación actual.

## Corrección propuesta (pendiente de aprobación; no implementada en esta rama)
Políticas `RESTRICTIVE` para app_runtime, solo para el usuario **solo familia** (rol FAMILY y ningún otro rol ni
membresía de empleado en la organización actual), en cualquier modalidad:
- `users`: solo su propia fila.
- `credentials`, `workers`, `organization_worker_memberships`: solo del personal con asignación aceptada en turnos de
  su familiar (lo que hoy muestra el portal familiar de agencias: nombre del cuidador asignado y su credencial
  verificada).
- `assignments`, `shifts`: solo de su familiar.
- Con la regresión completa del portal familiar de agencias (turnos de la familia, «En camino», historial, fotos,
  mensajes e incidentes) en los dos modos, y `verifyFamilyExposure` añadido a CI.

**Decisión pendiente:** número de migración. El rango 170–179 está reservado para hogares; esta corrección es
independiente y podría integrarse antes, así que necesita un número propio fuera de ese rango (por ejemplo, 180), con
la prueba de que las bases nuevas y producción aplican el mismo resultado sin importar el orden.
