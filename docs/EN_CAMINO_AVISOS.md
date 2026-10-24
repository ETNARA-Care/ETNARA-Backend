# Avisos de servicio y avisos del trayecto (migración 113)

24-oct-2026. Hay dos familias de avisos, separadas por tipo, texto y destino.

## 1. Avisos del servicio (cambios de la agencia sobre la visita)
| Tipo | A quién | Cuándo | Texto en la campana |
|---|---|---|---|
| `SHIFT_CANCELLED` | Cuidadoras asignadas (pendientes o aceptadas) | La agencia cancela el turno | «La agencia canceló uno de tus turnos» |
| `FAMILY_VISIT_CANCELLED` | Familiares activos, autorizados y con avisos activados | La agencia cancela una visita que aún no terminó | «La agencia canceló una visita» |
| `SHIFT_UNASSIGNED` | La cuidadora retirada (pendiente o aceptada) | La agencia la quita del turno | «Ya no tienes asignado un turno» |
| `FAMILY_CAREGIVER_CHANGED` | Familiares, como arriba | La agencia retira a una cuidadora que había **aceptado** | «Cambió la cuidadora de una visita» |

- **No dependen del trayecto:** se envían aunque la cuidadora no haya salido, y el texto no habla de «camino», «llegada» ni ubicación.
- **Sin duplicados:** uno por persona y visita (índice `idx_notifications_shift_cancelled_once` y `ON CONFLICT DO NOTHING`).
- **Sin datos de más:** nunca llevan dirección ni nombres, y nunca salen de la agencia ni llegan a ETNARA Central.
- **Alcance actual (piloto):** solo en agencias con el interruptor **EN_CAMINO activo**.
  - Es una decisión de alcance, no técnica: así no cambia nada para las agencias que no están en el piloto.
  - Ampliarlos a todas las agencias sería quitar la condición `app_org_feature_enabled(…, 'EN_CAMINO')` de `app_shift_cancel_notify` y `app_assignment_removal_notify`. Requiere aprobación aparte.

## 2. Avisos del trayecto («Voy en camino» / «Llegué»), solo con EN_CAMINO activo
`FAMILY_CAREGIVER_EN_ROUTE`, `FAMILY_CAREGIVER_DELAYED`, `FAMILY_CAREGIVER_ARRIVED`, `SHIFT_NOT_EN_ROUTE`, `SHIFT_DELAY_REPORTED`, `SHIFT_LATE_ARRIVAL` y `SHIFT_ARRIVAL_NEEDS_REVIEW`. Sin cambios de alcance: desde la migración 108 ya eran solo para el piloto.

## 3. Agencia con EN_CAMINO desactivado (comprobado, verificador S1/S2)
- **Cancelar un turno o quitar a una cuidadora:**
  - no se envía **ningún** aviso nuevo, ni de servicio ni de trayecto (0 filas);
  - el comportamiento es idéntico al de antes de la 113, cuando ninguna agencia recibía avisos de cancelación ni de retirada;
  - siguen igual los avisos generales de asignación que ya existían (`SHIFT_ASSIGNMENT_PENDING/ACCEPTED/REJECTED`).
- **El recorrido no se muestra:** la ruta responde 404 y el portal no dibuja la tarjeta.
  - Por eso la cuidadora tampoco ve el aviso automático en la pantalla del turno: se entera al recargar, como antes.

## 4. Registros sin señal (verificador O1–O10)
- **Hora:** se guarda la del teléfono (`occurred_at`), y el estado y el historial la muestran tal cual.
  - Límites: hasta 12 h después, nunca con hora futura, y siempre dentro de la ventana del turno.
- **Marca:** el registro queda con `recorded_offline = true`, y el historial de la agencia muestra «Registrado sin señal (hora del teléfono)».
- **Un registro que llega más de 30 min tarde, o después de la llegada o el inicio:**
  - no avisa a la familia ni crea alertas de retraso;
  - una llegada tardía solo pide revisión a la agencia;
  - una salida anterior a la llegada queda como historial y no cambia el estado.
- **El retraso se informa solo con conexión:** no tiene cola sin señal.
