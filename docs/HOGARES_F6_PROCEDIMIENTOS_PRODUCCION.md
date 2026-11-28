# Hogares F6 — Procedimientos y listas de verificación para producción

Preparado el 26-nov-2026 y actualizado el 28-nov-2026. **Integración de F0 a F5 y de la 180: hecha** (sección 1).
**Hogar Demo, interruptores y recorrido en iPhone: nada ejecutado.** Cada paso que toca producción, Railway,
interruptores o Hogar Demo requiere la autorización expresa de Rafa y se hace en el orden indicado.
Lo que se pudo probar sin producción ya está cubierto por `scripts/verifyResidentialWalkthroughF6.ts` (base desechable,
datos ficticios) y por las pruebas de navegador de cada fase.

## 1. Integración secuencial (un PR a la vez, backend antes que portal)

**Hecha del 26 al 28-nov-2026**, en este orden: 180 (#297) → F1 (#282, #292, «Crear turno» #299) → F2 (#289, #300) →
F4 (#291, #302) → body-parser 2.4.0 (#300 del backend) → F3 (#293, #304) → F5 (#295, #306). Producción: migraciones
170–177 y 180 (aplicadas 175 → 180 → 176 → 177), todos los interruptores de hogar y DEMO_ENVIRONMENT apagados.
F6 (#298, #308) no trae migración ni cambios de `src`: solo este documento, el recorrido aislado, la CI y las guías.
El procedimiento de abajo es el que se siguió y sigue valiendo para F6 y para cualquier cambio posterior.

Para **cada** PR:
1. Actualizar la rama con `main` y volver a correr la CI completa (sin reducir pruebas).
2. Auditoría independiente de GPT cerrada y aprobación de Rafa en GitHub **sobre el commit exacto**.
3. Consulta de impacto de solo lectura en Railway (la ejecuta Rafa) cuando el PR trae migración.
4. Anotar T0 para PITR y confirmar el último diferencial del respaldo.
5. Fusionar = desplegar (Railway despliega `main`; el *pre-deploy* aplica la migración).
6. Verificar en los registros: `OK: 17x_….sql`, `DB_RUNTIME_ROLE app_runtime canBypassRls=false`,
   `DB_RUNTIME_READINESS ready=true`, arranque sin errores.
7. Vigilar 30 minutos: 0 errores 5xx, 0 `42501` inesperados; `/health` y `/health/db` en `ok`.
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

## 2. Hogar Demo permanente — PROPUESTA de procedimiento definitivo (no ejecutar sin autorización expresa)

Hogar Demo es una organización de hogar real en producción, con datos **ficticios**, para enseñar y probar la modalidad
desde el iPhone. Se carga a través del portal y de la API (como un hogar real), **nunca** escribiendo en la base.

### 2.0 Decisiones y requisitos previos (de Rafa)
- [ ] F6 integrado (backend y portal) y este procedimiento aprobado.
- [ ] Correos de las cuentas de demostración (propuesta: alias de la cuenta de ETNARA, uno por rol: administración,
      cuidador/a, sustituto/a y familia). Ninguna otra cuenta recibe invitación.
- [ ] Punto de la geocerca: un **lugar autorizado para pruebas** (no la dirección de un hogar real ni de una persona).
- [ ] `ATTENDANCE_CODE_SECRET`: lo genera y lo guarda Rafa en Railway (backend), nunca en GitHub, chats ni documentos.
      Sin él la asistencia responde 503 y no se puede encender HOGAR_PONCHES.
- [ ] Textos jurídicos de §13 validados: aviso de geolocalización y «no es nómina» de las exportaciones.
- [ ] Franja «Entorno de demostración» (DEMO_ENVIRONMENT): hoy se superpone a la barra superior al desplazarse
      (pendiente visto el 27-nov). Decidir si se corrige antes (PR pequeño del portal, con su auditoría) o se acepta.
- [ ] Ventana de trabajo y respaldo: anotar T0 para PITR y confirmar el último WAL antes de empezar.

### 2.1 Alta y aislamiento (Central)
1. Consulta de solo lectura «antes» (la ejecuta Rafa): organizaciones por tipo, interruptores encendidos (ninguno de
   hogar ni demo), conteos de Casa Demo (agencia) para compararlos después.
2. Central → Organizaciones → «Nueva organización»: nombre «Hogar Demo», tipo «Hogar / establecimiento residencial».
3. Central → Funcionalidades de Hogar Demo: encender **primero DEMO_ENVIRONMENT**, con motivo. Así queda fuera de la
   alerta comercial y de las métricas antes de cargar residentes. Los interruptores HOGAR_* siguen apagados.
4. Central → «Invitar admin» con el alias de administración; activar la cuenta desde el enlace del correo.
5. Comprobar: la franja de demostración aparece en los tres portales; Hogar Demo no aparece en la alerta de Central.

### 2.2 Carga ficticia (administración de Hogar Demo, desde el portal)
6. Configuración → Establecimientos: crear el establecimiento; en «Establecimientos y habitaciones», la geocerca
   (punto autorizado, 100 m) y 6 habitaciones con 12 camas.
7. 10 residentes ficticios (9 ubicados, 1 sin habitación) y 15 empleados ficticios con credenciales y documentos
   ficticios; uno sin credenciales, para enseñar el bloqueo de una sustitución. Solo se invitan los alias del 2.0.
8. Invitar a la familia (alias) desde la ficha de un residente.

### 2.3 Activación por módulo, solo en Hogar Demo (cada paso con su comprobación; si falla, se detiene)
9. **HOGAR_CALENDARIO** (Central, con motivo) → plantilla de día, tarde y noche; publicar una semana; la cuidadora la
   ve en «Mi horario» y acepta sus turnos en «Turnos».
10. **HOGAR_PONCHES**: con el secreto ya configurado y el backend redesplegado, comprobar que la hoja del QR responde sin
    503; entonces encender (Central, con motivo); imprimir el QR; ponches de ejemplo: dentro, fuera del perímetro,
    sin conexión y manuales de quien no tiene cuenta.
11. **HOGAR_ASIGNACIONES** (Central, con motivo) → asignar residentes; una sustitución bloqueada y una completada.
12. Actividades de la cuidadora y un mensaje de la familia a la administración.

### 2.4 Verificación y cierre
13. Consulta de solo lectura «después»: interruptores encendidos **solo** en Hogar Demo; ninguna otra organización
    cambió; Casa Demo con los mismos conteos; Hogar Demo excluido de la alerta; sin avisos a correos ajenos.
14. Recorrido desde el iPhone por los tres roles (sección 3) y regresión de agencias e independientes (sección 4).
15. Informe en el proyecto con los resultados.

**Marcha atrás:** apagar los HOGAR_* de Hogar Demo desde Central (con motivo); los datos ficticios se conservan y
nada de otras organizaciones depende de ellos. Retirar Hogar Demo por completo sería una decisión aparte; no se borra
ningún dato sin autorización.

## 3. Recorrido completo desde el iPhone (F6) — en Hogar Demo

Anotar para cada paso: hora, resultado (PASS/FAIL) y captura.

**Administración**
- [ ] Panel del hogar: módulos activos, presentes (solo entradas confirmadas), residentes sin cobertura, ponches por
      revisar, alertas y ocupación.
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
- [ ] «Mi horario»: semana publicada y horas; «Turnos»: aceptar un turno; aviso de sustitución.
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
- [ ] F0 a F6 en producción con sus criterios cumplidos, repetidos sobre `main` (F0–F5 y 180 hechos el 26–28-nov).
- [ ] Recorrido completo en Hogar Demo desde el iPhone por los tres roles (sección 3).
- [ ] Regresión completa de agencias e independientes (sección 4).
- [ ] Guías de una página y QR imprimible disponibles en los portales.
