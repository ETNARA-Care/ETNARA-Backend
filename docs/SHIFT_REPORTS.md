# Informe de Turno: contrato por fases

F1 está implementado en la migración 126 (este PR). F2–F5 están **documentados, sin implementar**: este contrato evita retrabajo y no exige cambios de esquema, salvo donde se indica.

## Principios (todas las fases)
- **El informe es una foto fija** de registros que ya existen: «Llegué» (`shift_arrivals`), inicio y salida (`verification_events`), registros de cuidado del turno, y los incidentes y observaciones que la cuidadora presentó durante la visita.
- **Nunca se inventan** actividades, horarios, datos clínicos ni tareas pendientes. Una sección sin registros es una lista vacía.
- **Los registros originales nunca se escriben desde este módulo.** Las correcciones son añadidos o versiones nuevas, nunca ediciones silenciosas.
- **Un informe aprobado no cambia**, ni siquiera para el dueño de la tabla. Solo puede pasar a `SUPERSEDED` cuando existe una versión corregida.
- **El historial (`shift_report_events`) es de solo añadir.** Guarda quién, cuándo, qué paso y conteos; nunca el texto del informe.
- **ETNARA central no lee informes** (`platform_phi_deny`). El texto libre se conserva tal cual: no se traduce.

## Estados y versiones
| Estado | Quién llega a él | Fase |
|---|---|---|
| DRAFT | El sistema, al terminar la visita (se crea al abrirlo o en la lista de la agencia) | F1 |
| SUBMITTED | La cuidadora, dentro de las 24 h siguientes al final real | F2 |
| RETURNED | La agencia devuelve un SUBMITTED con una nota; la cuidadora puede reenviarlo dentro de su ventana | F2 |
| APPROVED | La agencia (ORGANIZATION_ADMIN o SUPERVISOR): `family_sections` y `agency_summary` opcional | F1 |
| SUPERSEDED | Una versión corregida (`version` n+1, `supersedes_report_id`) reemplaza a la aprobada | F4 |

## Contenido (`content`, schema 1)
- `organization.name`, `recipient {id, name}`, `caregiver {membershipId, name}`.
- `shift {id, scheduledStart, scheduledEnd}`.
- `times.arrival {at, proximity, recordedOffline, needsReview, reviewed} | null`, `times.start {at, recordedOffline}`, `times.end {at, recordedOffline}`.
- `sections`:
  - `meals`: `mealType`, `amountConsumed`;
  - `hydration`: `amount`;
  - `hygiene`: TOILETING, `result`;
  - `mobility`: `activity`;
  - `activities`: `label`, `durationMinutes`;
  - `mood`: `mood`;
  - `notes`: `text`.
  - Cada elemento lleva `careEventId`, `at` y `note`.
- `incidents [{incidentId, at, severity, status, description}]` y `observations [{observationId, at, category, status, description}]`.
- `photos {count, photoEvents}`: solo conteos. Las fotos se comparten con su propio flujo de aprobación (115).
- `totals`.

## Quién revisa y aprueba
- **Siempre** el ORGANIZATION_ADMIN de la agencia.
- **Un SUPERVISOR solo si un administrador lo autorizó** de forma expresa (`shift_report_reviewers`).
  - La autorización nunca se edita ni se borra: solo se revoca una vez, y queda quién y cuándo.
  - Deja de valer si la persona deja de ser supervisora activa.
- **Permiso independiente** de Finanzas, SmartMatch, Facturación y Horas (`app_can_review_shift_reports`).
- **Nadie aprueba el informe de su propia visita**, tampoco un administrador que trabajó el turno. Lo bloquean el servicio y la base de datos (SHIFT_REPORT_SELF_APPROVAL).
- **«Devolver»** (RETURNED) llega con F2, cuando la cuidadora pueda enviar a revisión. Lo usarán las mismas personas.

## API F1 (detrás de SHIFT_REPORTS; administradores y supervisores autorizados)
- `GET /organizations/:org/shift-reports?status=DRAFT|APPROVED`: crea los borradores que falten de visitas terminadas en los últimos 7 días (máximo 50) y lista.
- `GET /organizations/:org/shifts/:shiftId/shift-reports`: informes del turno con historial; crea el borrador si falta.
- `POST /organizations/:org/shift-reports/:id/refresh`: solo DRAFT. Reconstruye el contenido (por ejemplo, un registro sin conexión que llegó tarde).
- `POST /organizations/:org/shift-reports/:id/approve {expectedGeneratedAt, familySections?, agencySummary?}`: rechaza con 409 SHIFT_REPORT_CHANGED si el borrador cambió desde que se leyó, y con 403 SHIFT_REPORT_SELF_APPROVAL si es de su propia visita.
- `GET /organizations/:org/shift-report-access`: `{canReview, canManageReviewers}`.
- `GET|POST /organizations/:org/shift-report-reviewers` y `POST .../shift-report-reviewers/:membershipId/revoke`: solo administradores.

## F2: revisión de la cuidadora (implementado en la migración 128)
- **Un solo constructor, en la base** (`app_shift_report_build_content`). Solo lee registros existentes.
  - Lo usan el borrador automático, la agencia y, en F3, la familia.
  - No es ejecutable por el rol de la aplicación.
- **Borrador automático:** un proceso cada 60 s (`app_shift_reports_generate_pending`) crea el borrador de cada visita terminada en los últimos 7 días, solo en agencias con SHIFT_REPORTS.
  - El evento GENERATED queda con actor de sistema.
  - La cuidadora recibe un aviso en el portal: SHIFT_REPORT_READY.
- **Lectura de la cuidadora:** solo los informes de sus propias visitas, por RLS de solo lectura, también después del servicio.
  - Mientras su membresía en la agencia esté activa. Si la retiran, pierde el acceso.
  - No ve las secciones familiares ni el resumen de la agencia.
- **Escritura, solo mediante funciones protegidas y dentro de las 24 h del final real:**
  - **Observación final** (hasta 1000 caracteres). Reemplazarla añade otro OBSERVATION_ADDED; todas las versiones quedan en el historial.
  - **«Enviar a revisión»:** DRAFT o RETURNED → SUBMITTED.
  - Nunca edita la foto del turno ni sus registros, nunca aprueba y nunca borra.
- **Agencia:**
  - **«Devolver»** (SUBMITTED → RETURNED, con nota obligatoria), solo mientras la ventana de la cuidadora siga abierta. Ella recibe el aviso SHIFT_REPORT_RETURNED.
  - **Aprobar:** desde DRAFT, SUBMITTED o RETURNED.
  - **«Actualizar borrador»:** solo DRAFT o RETURNED. Lo enviado es lo que ella revisó.
  - **«Por aprobar»** (`status=PENDING`) = DRAFT, SUBMITTED y RETURNED, con los enviados primero.
- **Plazo vencido sin envío:** el informe **sigue DRAFT, sin cambios**. No se borra nada.
  - La cuidadora ya no puede anotar ni enviar.
  - La agencia ve «Plazo de la cuidadora vencido» (`caregiverWindowExpired`) y puede revisarlo, actualizarlo y aprobarlo como cualquier borrador.
- **API de la cuidadora:**
  - `GET /organizations/:org/me/shift-reports`
  - `GET .../me/shift-reports/:id`
  - `POST .../me/shift-reports/:id/observation {text}`
  - `POST .../me/shift-reports/:id/submit`
- **API de la agencia:** `POST /organizations/:org/shift-reports/:id/return {note}`.
- **Recuperación:** `ops/128_shift_reports_caregiver_review.rollback.sql` se aborta si ya hay observaciones, envíos o devoluciones.

## F3: familia y PDF
- Solo informes APPROVED del residente con relación familiar activa (`app_user_authorized_for_recipient`) y rol FAMILY activo.
- Se proyectan solo las secciones `family_sections = true`. Las observaciones solo con estado `reviewed`, como hoy en el portal familiar.
- Al revocar la relación se pierde el acceso en el momento.
- PDF generado en el servidor bajo demanda a partir del informe aprobado (identificación del informe, fecha de emisión y versión). No se guarda; cada descarga añade `PDF_DOWNLOADED`.
- Dependencia nueva a revisar (por ejemplo, pdfkit con fuentes que admitan acentos).

## F4: avisos y correcciones
- Correo con enlace al portal (Resend), sin nombre del residente ni datos de salud y sin adjuntos. También aviso en la app.
- Corrección: versión n+1 en DRAFT con `supersedes_report_id`. Al aprobarla, la anterior pasa a SUPERSEDED en la misma transacción. Evento `CORRECTED`.

## F5 (pospuesta)
- Tareas del plan por turno («Hecho» o «No realizado» y motivo) y tipos HIGIENE y ACOMPAÑAMIENTO.
- No implementar sin autorización.

## Recuperación
- **Primero:** `ops/126_shift_reports_rollback_assessment.sql` (solo lectura, solo conteos).
- **Camino recomendado ante un problema:** apagar SHIFT_REPORTS y corregir hacia adelante.
- **Rollback (`ops/126_shift_reports.rollback.sql`):** solo con todo en 0. Se aborta si hay informes, historial o filas del interruptor.
