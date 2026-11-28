# Habitación técnica de los hogares (RESIDENTIAL_CARE_HOME)

**Regla:** la habitación técnica **no es una habitación**. Es el ancla interna que permite que un turno pertenezca
a un establecimiento de hogar sin modificar la tabla `shifts` (decisión D2 del plan de hogares; migración 171).

## Qué es
- Cada establecimiento activo de un hogar tiene exactamente **una unidad técnica y una habitación técnica**,
  registradas en `establishment_technical_rooms` (clave: el establecimiento).
- Se crean solas al crear el establecimiento (disparador `locations_residential_ensure`) y por el relleno de la 171.
  Repetir la creación no duplica nada: los identificadores son estables (`app_residential_stable_uuid`).
- Su nombre es el centinela `__etnara_technical__`. Si aparece en una respuesta, las pruebas de CI fallan.

## Garantías (en la base de datos, también contra `app_runtime` directo)
- **Nunca tiene residentes**, para nadie, incluido el propietario de la base (`care_recipients_residential_room_guard`).
- No se edita, archiva, elimina ni traslada, y no admite otras habitaciones ni camas (`room_profiles`), salvo dentro del
  procedimiento de cierre `app_residential_close_establishment()`. La marca del procedimiento no vale si la fija
  `app_runtime`.
- No cuenta como capacidad, ocupación ni suscripción.

## Para quien programa (personas y agentes)
- **Toda consulta de `units` o `rooms` que devuelva datos o cuente debe excluirla**: usar
  `NOT EXISTS (SELECT 1 FROM establishment_technical_rooms t WHERE t.unit_id = u.id)` / `t.room_id = r.id`, o
  `app_is_technical_unit()` / `app_is_technical_room()`.
- Nunca mostrarla en los portales, ni en Central, ni en exportaciones.
- Los turnos que la usan (F2 en adelante) se presentan como «del establecimiento».
  F2 (172): el calendario semanal publica sus turnos en ella. Las respuestas de turnos devuelven `room_id` null cuando
  es la técnica y `establishment_name` con el nombre del establecimiento (`scheduling.service.ts`); la verificación S23
  de `scripts/verifyResidentialSchedule172.ts` busca su id en todas las respuestas.
  F4 (173–175): los ponches solo se registran sobre turnos de la habitación técnica de su establecimiento (guarda de la
  base) y las respuestas de asistencia nunca incluyen su id: hablan del establecimiento.
- El acceso a residentes nunca sale de la habitación técnica: sale de la asignación de residentes (F3).
  F3 (176): `shift_resident_assignments` guarda periodos (effective_from/effective_until) por turno de la habitación
  técnica, persona y residente. `app_worker_has_recipient_assignment` (134) y `app_worker_messaging_window` (132) ganan
  una rama OR que solo se cumple con una asignación activa AHORA (aceptada, turno no cancelado, membresía activa, dentro
  de la cobertura recortada por sustituciones); sin las 24 h de gracia en hogares. Fuera de los hogares nada cambia.
- Verificación: `scripts/verifyResidentialEstablishments171.ts` (V1 busca los identificadores y el centinela en todas
  las respuestas; V2 los conteos de Central).
