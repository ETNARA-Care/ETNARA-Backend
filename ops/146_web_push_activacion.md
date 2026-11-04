# 146 — Notificaciones push: activación y reversión

Nada de esto se hace sin la aprobación expresa de Rafa en cada paso marcado con «APROBACIÓN».

## Requisitos previos (bloqueantes)
1. **C1:** proteger `main` en ETNARA-Backend y ETNARAMVP (Settings › Branches o Rules: PR obligatorio, sin force-push, sin borrado). Hoy `main` no tiene protección ni reglas. Railway despliega `main` automáticamente (`checkSuites=false`).
2. **I-2 residual:** Backend #252 (barra final en los interruptores por agencia) fusionado y desplegado.
3. PITR sano y un respaldo reciente de la base de producción (procedimiento habitual).
4. Correo institucional de soporte para VAPID confirmado y funcionando (decisión 6).

## Activación (orden)
| Paso | Qué | Efecto visible | Reversión inmediata |
|---|---|---|---|
| A1 · APROBACIÓN | Fusionar el PR del backend (migración 146). Railway despliega y aplica la 146 en el pre-deploy. | Ninguno: `PUSH_ENABLED` es `off` por defecto. `/me/push/config` responde `enabled:false`. El interruptor nuevo existe apagado para todas las agencias. | Rollback de Railway (la 146 se queda, inactiva) |
| A2 | En TU computadora: `npx web-push generate-vapid-keys`. Copiar las dos claves en Railway: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (sellada), `VAPID_SUBJECT=mailto:<correo de soporte>`, `PUSH_APP_BASE_URL=https://app.etnaracare.com`. **Mantener `PUSH_ENABLED=off`.** Guardar la privada en el gestor de contraseñas; nunca en el repositorio ni en un chat. | Ninguno | Borrar las variables |
| A3 · APROBACIÓN | Fusionar el PR del portal. GitHub Pages publica iconos, manifest, service worker y la tarjeta. | Iconos PNG nuevos al reinstalar en la pantalla de inicio. La tarjeta **no aparece** mientras el servidor esté apagado. | Revertir el commit del portal |
| A4 · APROBACIÓN | `PUSH_ENABLED=on` en Railway (redeploy). Log esperado: ningún error `PUSH_*`. | La tarjeta aparece en los tres portales, pero **nada se envía** porque ninguna agencia tiene `PUSH_NOTIFICATIONS`. | `PUSH_ENABLED=off` |
| A5 · APROBACIÓN | Central › Organizaciones › Casa Demo › «Notificaciones en el teléfono» → encender (con motivo, auditado). | Solo Casa Demo recibe push. | Apagar el interruptor (efecto inmediato) |
| A6 | Pruebas en dispositivos reales (lista abajo) con cuentas de Casa Demo. | — | — |
| A7 · APROBACIÓN | Agencia piloto: encender su interruptor. | Esa agencia recibe push. | Apagar su interruptor |

### Vigilancia tras A4/A5
- Logs: `PUSH_TICK {"expanded":…,"sent":…,"retry":…,"gone":…,"failed":…}` y `PUSH_CLEANUP {…}`. Solo cuentan; nunca llevan endpoint, claves, ids ni texto.
- Consultas de solo lectura (superusuario):
  - `SELECT state, reason, count(*) FROM push_outbox WHERE created_at > now() - interval '1 day' GROUP BY 1, 2;`
  - `SELECT state, last_status, count(*) FROM push_deliveries WHERE created_at > now() - interval '1 day' GROUP BY 1, 2;`
  - `SELECT reason, sum(subscription_count) FROM push_subscription_events WHERE created_at > now() - interval '7 days' GROUP BY 1;`
- Alerta: muchos `failed` o `last_status` 403/401 indican un problema con las claves VAPID; si pasa, aplicar R1 y revisar.

## Pruebas en dispositivos reales (A6)
**iPhone (iOS 16.4+; ideal 17 y 18.4+):**
1. Safari sin instalar: la tarjeta muestra la guía «Añadir a pantalla de inicio».
2. Instalar, abrir desde el ícono, «Activar notificaciones» → permiso → «Activadas».
3. «Enviar prueba» con la app abierta, en segundo plano y cerrada (deslizada).
4. Pantalla bloqueada con «Mostrar vistas previas: Siempre» y «Si está desbloqueado»: solo «ETNARA Care» y el texto general.
5. Modos de concentración / No molestar.
6. Tocar el aviso con la sesión vigente → pantalla correcta.
7. Cerrar la app (sesión perdida) y tocar un aviso → inicio de sesión → pantalla correcta.
8. Silencio nocturno: no suena; el aviso está en la bandeja.
9. Bloquear en Ajustes › Notificaciones › ETNARA → la tarjeta muestra «Bloqueadas» con instrucciones; reactivar desde Ajustes.
10. Borrar el ícono de la pantalla de inicio → el siguiente envío borra la suscripción (`ENDPOINT_GONE`).
11. Cerrar sesión → no llegan más avisos a ese teléfono.
12. Dos cuentas en el mismo iPhone: la segunda no recibe los avisos de la primera.
13. Icono: el logotipo se ve correcto en la pantalla de inicio (sin captura de pantalla).

**Android (Chrome y Samsung Internet), instalada y sin instalar:** casos 2–12, ahorro de batería y canal de notificaciones del navegador.

**Por rol (Casa Demo):**
- Cuidadora: turno nuevo, cambio de horario (requiere #235), cambio de dirección, cancelación, retiro.
- Agencia, administradora: aceptado o rechazado, llegada, retraso, sin llegada a los 15 min, incidente.
- Supervisora: nada hasta marcar «Recibir también los avisos de la agencia».
- Familia: llegada (una sola vez), retraso, visita cancelada, cambio de cuidadora, mensaje. **Incidente: solo en la bandeja.**
- Agencia suspendida desde Central: no llega nada; las suscripciones de quien no tiene otro acceso se borran (auditado).

## Reversión
| Nivel | Cuándo | Cómo | Efecto |
|---|---|---|---|
| R0 | Una agencia | Central: apagar «Notificaciones en el teléfono» | Inmediato. Esa agencia deja de enviar push; la bandeja sigue igual. |
| R1 | Todas las agencias | Railway: `PUSH_ENABLED=off` y redeploy | No se envía nada; la tarjeta desaparece; las suscripciones se conservan. |
| R2 | Código | Railway: rollback al despliegue anterior | La 146 queda en la base. El disparador sigue encolando avisos de quienes activaron su teléfono. Si R2 dura más de un día, aplicar R3 o vaciar `push_outbox` (`DELETE FROM push_outbox;`). |
| R3 | Retiro total | Tras R2, como superusuario: `ops/146_web_push_notifications.rollback.sql` | Borra tablas, funciones, disparadores y el interruptor. La bandeja no se toca. Antes, si se debe conservar la auditoría: `\copy push_subscription_events TO 'push_eventos.csv' CSV HEADER`. |
| Portal | Fallo en el portal | Revertir el commit del portal | Si el backend sigue activo, quien ya activó su teléfono sigue recibiendo avisos (R0/R1 para detenerlo). |

**Claves VAPID:** cambiarlas invalida todas las suscripciones (cada persona tendrá que activar de nuevo). Solo si la clave privada se expone: generar un par nuevo, actualizar las variables, y luego `DELETE FROM push_subscriptions;` (auditar el conteo antes).
