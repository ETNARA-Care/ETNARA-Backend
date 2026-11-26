# Hogares F6 — Procedimientos y listas de verificación para producción

Preparado el 26-nov-2026. **Nada de esto se ha ejecutado.** Cada paso que toca producción, Railway, migraciones,
interruptores o Hogar Demo requiere la autorización expresa de Rafa y se hace en el orden indicado.
Lo que se pudo probar sin producción ya está cubierto por `scripts/verifyResidentialWalkthroughF6.ts` (base desechable,
datos ficticios) y por las pruebas de navegador de cada fase.

## 1. Integración secuencial (un PR a la vez, backend antes que portal)

Orden: F1 → «Crear turno» (#299) → F2 → F4 → F3 → F5 → F6. La corrección de seguridad 180 (#297) es independiente y
puede ir antes o después: el esquema resultante es idéntico en los dos órdenes (comprobado).

Para **cada** PR:
1. Actualizar la rama con `main` y volver a correr la CI completa (sin reducir pruebas).
2. Auditoría independiente de GPT cerrada y aprobación de Rafa en GitHub **sobre el commit exacto**.
3. Consulta de impacto de solo lectura en Railway (la ejecuta Rafa) cuando el PR trae migración.
4. Anotar T0 para PITR y confirmar el último diferencial del respaldo.
5. Fusionar = desplegar (Railway despliega `main`; el *pre-deploy* aplica la migración).
6. Verificar en los registros: `OK: 17x_….sql`, `DB_RUNTIME_ROLE app_runtime canBypassRls=false`,
   `DB_RUNTIME_READINESS ready=true`, arranque sin errores.
7. Vigilar 15 minutos: 0 errores 5xx, 0 `42501` inesperados.
8. Si algo falla: detener la integración; revertir el commit y ejecutar `ops/17x_…rollback.sql` (cada reversión se
   niega si ya hay datos de esa fase, para no perder registros).
9. Informe de resultado en el proyecto antes del siguiente PR.

| Migración | Fase | Reversión | Se niega con datos |
|---|---|---|---|
| 171 | F1 | `ops/171_…rollback.sql` | sí (establecimientos en uso) |
| 172 | F2 | `ops/172_…rollback.sql` | sí (semanas publicadas) |
| 173–175 | F4 | `ops/173…175_…rollback.sql` | sí (códigos, ponches, revisiones) |
| 176 | F3 | `ops/176_…rollback.sql` | sí (asignaciones o sustituciones) |
| 177 | F5 | `ops/177_…rollback.sql` | no hay datos (solo funciones y políticas) |
| 180 | Seguridad | `ops/180_…rollback.sql` | no hay datos (solo funciones y políticas) |

## 2. Creación y carga de Hogar Demo (D9) — después de F0 y con autorización

Lista de verificación:
- [ ] Central: alta de la organización «Hogar Demo», tipo `RESIDENTIAL_CARE_HOME`, con motivo registrado.
- [ ] Encender `DEMO_ENVIRONMENT` y confirmar la franja «Entorno de demostración — Datos ficticios» en los tres portales.
- [ ] Tres invitaciones normales a correos de alias de ETNARA: administración, cuidador y familia. Ninguna otra cuenta.
- [ ] Casa Demo (agencias) intacta: comparar sus conteos antes y después.
- [ ] Establecimiento con geocerca en un **lugar autorizado para pruebas**.
- [ ] Operación representativa con datos ficticios: 10 residentes, 6 habitaciones, 12 camas, 15 empleados con
      credenciales y documentos ficticios (los que no tienen cuenta, sin invitación).
- [ ] Encender `HOGAR_*` **solo en Hogar Demo**, en el orden de integración (calendario → ponches → asignaciones).
- [ ] Plantillas de día, tarde y noche; una semana publicada; asignaciones; una sustitución; ponches de ejemplo (uno fuera
      del perímetro, uno sin conexión; los de empleados sin cuenta, manuales); actividades.
- [ ] Central: Hogar Demo fuera de alertas comerciales y métricas (marca «Hogar Demo» en la lista).
- [ ] Prueba de RLS: las tres cuentas de demostración no ven ninguna otra organización (mismo método que
      `verifyFamilyRlsScope180` y la sonda entre agencias, con lectura solamente).
- [ ] Ningún correo ni aviso a personas ajenas (revisar el registro de envíos).

## 3. Recorrido completo desde el iPhone (F6) — en Hogar Demo

Anotar para cada paso: hora, resultado (PASS/FAIL) y captura.

**Administración**
- [ ] Panel del hogar: módulos activos, presentes, residentes sin cobertura, ponches por revisar, alertas y ocupación.
- [ ] Establecimientos y habitaciones: ocupación 9/12 (o la cargada) y «Sin configurar» donde no hay camas.
- [ ] Calendario: aplicar la plantilla a la semana siguiente, ver avisos de solape y publicar.
- [ ] Asistencia: imprimir el QR (hoja con QR y código de 6 dígitos), revisar un ponche pendiente con motivo.
- [ ] Asignaciones: asignar residentes, mover uno sin cobertura (exige motivo y alerta), sustituir (ver un bloqueo y
      completar una sustitución).
- [ ] Informes: asistencia de 7 días (validadas y pendientes aparte), CSV abierto en Excel/Numbers con el aviso de no
      nómina; asignaciones; ocupación.
- [ ] Mensajes: responder a la familia.
- [ ] Guía de la administración: abrir e imprimir (una página).

**Cuidador**
- [ ] Ponchar con el QR impreso y con el código de 6 dígitos; consentimiento de ubicación; sin señal (modo avión) el
      ponche queda en el teléfono y se envía al volver.
- [ ] Turnos: semana publicada; aviso de sustitución.
- [ ] Residentes: solo los asignados; registrar una comida y una observación.
- [ ] Solicitar la corrección de un ponche.
- [ ] Guía del cuidador: abrir e imprimir.

**Familia**
- [ ] Inicio: su familiar, hogar y habitación; actividades de hoy con autor y puesto.
- [ ] Cuidado: historial; no aparece calendario ni ningún dato del personal ajeno ni de otros residentes.
- [ ] Mensajes: escribir a la administración y recibir la respuesta.
- [ ] Inglés: cambiar el idioma y repetir Inicio y Cuidado.
- [ ] Guía de la familia: abrir e imprimir.

## 4. Regresión de agencias e independientes sobre `main` (después de cada integración)
- [ ] CI completa de `main` en verde (incluye la matriz de roles en los dos modos, la sonda entre agencias, no miembros,
      portal familiar, independientes y, tras la 180, `verifyFamilyRlsScope180`).
- [ ] Casa Demo desde el iPhone: administración (turno, asignar), cuidadora (En camino, llegada, registro, salida) y
      familia (Hoy, actividad, mensajes) sin cambios visibles.
- [ ] Práctica independiente de demostración: agenda, visita, registro y portal familiar sin cambios.
- [ ] Registros: 0 errores 5xx y 0 `42501` inesperados en 24 h.

## 5. Criterios de cierre de la modalidad (plan §11)
- [ ] F0 a F6 en producción con sus criterios cumplidos, repetidos sobre `main`.
- [ ] Recorrido completo en Hogar Demo desde el iPhone por los tres roles (sección 3).
- [ ] Regresión completa de agencias e independientes (sección 4).
- [ ] Guías de una página y QR imprimible disponibles en los portales.
