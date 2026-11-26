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

## Corrección: migración 180 (aprobada por Rafa el 26-nov-2026)
Políticas `RESTRICTIVE` para app_runtime, solo para el usuario **solo familia** (rol FAMILY y ningún otro rol ni
membresía de empleado activa en la organización actual), en cualquier modalidad:
- `users`: solo su propia fila.
- `shifts`, `assignments`: solo de su familiar (directos o de su habitación, como su portal).
- `workers`, `organization_worker_memberships`, `credentials`: solo del personal con asignación aceptada en turnos de su
  familiar o que registró actividades de su familiar (lo que hoy muestra su portal: nombre del cuidador y su credencial
  verificada, y el autor de cada actividad).
- `worker_unavailability_periods`, `establishment_worker_assignments`: nada.
- Cinco funciones `SECURITY DEFINER` con `search_path` fijo que solo devuelven sí/no; PUBLIC no puede ejecutarlas.

Verificación: `scripts/verifyFamilyRlsScope180.ts` (16/16, en agencia, independiente y hogar), reversión 4/4, y la
compatibilidad con 171–177: el esquema resultante es idéntico aplicando la 180 antes o después de ellas (4.616 objetos:
políticas, funciones, columnas, disparadores y permisos), y sus verificaciones pasan juntas en la rama combinada.

## Auditoría independiente (26-nov-2026) — ajustes sobre `b5f3df4`

La RLS restringe filas, no columnas, así que se alinearon las filas visibles con lo que el portal familiar ya devuelve:

- **Credenciales:** antes, todas las del personal visible (las credenciales son de la persona, así que también las subidas o revisadas solo en otra organización). Ahora solo las **activas, vigentes y aprobadas por la organización actual**, de personal visible con **membresía activa** (igual que `listFamilyShifts`). Nueva función `app_family_visible_credential(uuid)` (SECURITY DEFINER, boolean).
- **Documentos (`documents`) y archivos profesionales (`stored_files` con `PLATFORM_PROFESSIONAL`):** la familia ya no los ve (antes veía nombre original y clave de almacenamiento de los del personal visible). Los archivos operativos de la organización (fotos de actividades, adjuntos de incidentes) no cambian.
- **Historial y turnos cancelados:** dan visibilidad del nombre y el puesto (el portal muestra quién atendió); las credenciales solo si la persona sigue activa y la credencial está vigente y aprobada aquí. Invitaciones pendientes o rechazadas no dan nada.
- **Riesgo residual (bajo):** la familia sigue leyendo `organization_memberships` y `user_roles` de su organización (identificadores y códigos de rol, sin contactos), porque la conversación con la administración los usa en su propia sesión. Cerrarlo exige cambiar código; queda fuera de la 180.
- Verificador: 19/19 en main + 180 y en 171–177 + 180 (nueva comprobación C1).
