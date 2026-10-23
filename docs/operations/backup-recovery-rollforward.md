# ETNARA Care — Respaldo, recuperación y roll-forward (producción)

Estado: preparado el 23-oct-2026. **Nada de esto se ha ejecutado en producción.** Cada paso que toca producción requiere autorización expresa del propietario.

## 1. Inventario de producción (solo lectura, verificado el 23-oct-2026)

| Pieza | Dónde | Cómo se despliega |
|---|---|---|
| API | Railway `hopeful-education` → servicio `etnara-care-backend-staging` | Push a `main` de ETNARA-Backend. `preDeploy`: `npm run bootstrap:staging` (aplica las migraciones pendientes) |
| Base de datos | Railway `hopeful-education` → `etnara-care-staging-db` (PostgreSQL 18, volumen de 500 MB) | **Sin endpoint público** (sin proxy TCP): solo es accesible desde la red privada del proyecto |
| Web | GitHub Pages, desde `main` de ETNARAMVP (`deploy.yml`) | Push a `main` |
| Migración actual | `087_offline_check_in_out.sql` | — |

Cómo se aplican las migraciones: `scripts/lib/runMigrations.ts` aplica cada archivo **en su propia transacción**, bajo un advisory lock. Si un archivo falla, ese archivo se revierte completo, `preDeploy` falla, Railway aborta el despliegue y la versión anterior sigue sirviendo. No quedan migraciones a medias.

## 2. Antes de cualquier despliegue a producción

1. **Ventana y aviso.** Elegir un horario de poco uso y avisar a las agencias. Nadie hace cambios manuales en Railway durante la ventana.
2. **Respaldo A: snapshot del volumen.** En Railway, servicio de la base → *Backups* → crear un respaldo manual y anotar fecha y hora. Antes de contar con esta opción, confirmar que el plan la incluye.
3. **Respaldo B: volcado lógico.** Es el que se puede verificar.
   - Como la base no tiene endpoint público, se hace con un servicio temporal dentro de `hopeful-education`. Ese servicio usa la imagen `postgres:18`, sin dominio ni variables extra. Corre `pg_dump --format=custom` con `PGOPTIONS='-c default_transaction_read_only=on'` y sube el archivo cifrado a un almacenamiento acordado con el propietario. El volcado nunca va al repositorio ni a un chat.
   - Crear ese servicio es un cambio de infraestructura en producción y **requiere autorización**. Al terminar, se elimina.
4. **Verificar el respaldo B y ensayar las migraciones en una sola corrida.** Se usa `scripts/rehearsal/rehearseMigrations.ts` (§4) desde el servicio temporal, con un destino aislado. Si el ensayo da PASS, quedan probadas dos cosas: el volcado se puede restaurar y las migraciones pendientes aplican sobre los datos reales.
5. **Plan de vuelta atrás escrito.** Anotar el ID del despliegue actual del backend (Railway → Deployments) y el commit actual de `main` en ambos repositorios.

## 3. Despliegue

Orden recomendado. Cada liberación va separada y se autoriza por separado:

1. **Hotfix de seguridad 088** (PR #203): migración 088 más 4 archivos de código. Es independiente de SmartMatch.
2. **SmartMatch y Gates 6/7** (PR #198 y #216), más adelante, con las funciones piloto apagadas para todas las agencias, salvo la agencia piloto.

En cada despliegue:
- Fusionar el PR a `main`. Railway construye y `preDeploy` aplica las migraciones.
- Seguimiento durante 30 minutos:
  - estado del despliegue y `GET /health`;
  - logs con `error`/`FAILED`;
  - tasa de HTTP 5xx;
  - consultas de solo lectura: `SELECT max(filename) FROM schema_migrations`, y el conteo de políticas en las tablas tocadas.
- Prueba manual con cuentas sintéticas, si existen en producción, o con la cuenta de ETNARA central: iniciar sesión, «Turnos», y comenzar y finalizar un turno de prueba.

## 4. Ensayo de migraciones con copia aislada

Herramienta: `scripts/rehearsal/rehearseMigrations.ts`.

Barreras, probadas una por una; las 9 rechazan la ejecución:

| # | Barrera | Resultado al probarla |
|---|---|---|
| 1 | Exige `REHEARSAL_CONFIRM=TARGET-IS-DISPOSABLE` | rechazado |
| 2 | El destino no puede ser la misma base que el origen | rechazado |
| 3 | El destino debe estar **vacío** (una base nueva en cada corrida) | rechazado |
| 4 | Una copia de ensayo ya usada no se reutiliza | rechazado |
| 5 | Lista de hosts de producción prohibidos como destino (`PRODUCTION_DB_HOSTS`) | rechazado |
| 6 | Host interno de producción incorporado (`etnara-care-staging-db.railway.internal`) | rechazado |
| 7 | El destino no puede estar en el mismo clúster PostgreSQL que el origen (`system_identifier`) | rechazado |
| 8 | El origen no puede ser una copia de ensayo (tabla marcador) | rechazado |
| 9 | No corre con `NODE_ENV=production` | rechazado |

Además:
- La sesión con el origen es de **solo lectura**: se verifica con `SHOW transaction_read_only`, y `pg_dump` corre con `default_transaction_read_only=on`.
- El volcado se borra al terminar.
- El informe JSON contiene solo conteos, nombres de tablas y restricciones, y tiempos. Nunca filas.

Qué comprueba el ensayo:
- migraciones aplicadas y tiempo aproximado de cada una;
- conteos de filas antes y después (no debe perderse ninguna);
- tablas nuevas;
- políticas RLS;
- tablas sin RLS;
- que los datos existentes cumplen todas las restricciones `NOT VALID` (se validan y se revierte).

Prueba local, con una base sustituta de producción en 087 y datos sintéticos de demostración:
- **PASS**: 21 migraciones (088–109) en 0,26 s;
- 0 filas perdidas;
- 5 restricciones `NOT VALID` cumplidas;
- 6 tablas de catálogo sin RLS, igual que hoy;
- **origen sin cambios**: mismos conteos, sigue en 087.

Ejecución contra producción (requiere autorización):
```
# dentro de un servicio temporal en hopeful-education (red privada), imagen con Node 20 + postgresql-client-18
REHEARSAL_SOURCE_URL=<URL de un rol de solo lectura en producción> \
REHEARSAL_TARGET_URL=<base PG18 vacía en un proyecto Railway aislado> \
REHEARSAL_CONFIRM=TARGET-IS-DISPOSABLE \
PRODUCTION_DB_HOSTS=etnara-care-staging-db.railway.internal \
npx tsx scripts/rehearsal/rehearseMigrations.ts
```
Al terminar se elimina la base de destino. Contiene datos reales, así que vive solo el tiempo del ensayo, en un proyecto aislado y sin dominio público.

## 5. Recuperación: árbol de decisión

| Síntoma | Acción | Riesgo |
|---|---|---|
| `preDeploy` falla (una migración falla) | Nada que revertir: el archivo se revirtió y Railway mantiene la versión anterior. Corregir con roll-forward (§6) | Bajo |
| Error de la aplicación con el esquema correcto | **Revertir el código**: Railway → Deployments → *Redeploy* del despliegue anterior, o revertir el commit en `main`. Para el hotfix 088 está **probado**: la UI de producción contra el código de `main` sobre una base con 088 da 5/5 | Bajo |
| 088 bloquea un flujo legítimo que no se detectó | 1) Revertir el código (no basta, porque el bloqueo está en la base). 2) Aplicar el roll-forward con la corrección. 3) Solo como último recurso, `ops/088_production_security_hotfix.rollback.sql` (probado: deja políticas, permisos y triggers **idénticos** a 087) | Reabre las vulnerabilidades |
| SmartMatch (090–109) en producción y algo falla | **Roll-forward**. Revertir el código a `main` antiguo rompe el guardado de direcciones (Fase 12.1). Las funciones nuevas se pueden **apagar por agencia** (108) sin desplegar | Medio |
| Pérdida o corrupción de datos | Restaurar el volcado B en un **servicio de base nuevo**, verificarlo con conteos y cambiar `DATABASE_URL` del backend. Alternativa: restaurar el snapshot A del volumen. Así no se sobrescribe la base original, que se conserva para el análisis | Ventana de datos perdidos = tiempo desde el respaldo |

Objetivos, estimados sobre una base de menos de 500 MB:
- RPO = momento del respaldo previo al despliegue;
- RTO ≈ 15–30 minutos (restaurar, verificar y cambiar la URL).

## 6. Roll-forward (forma preferida de corregir)

1. Rama desde `main`, con la corrección mínima y una **migración nueva**. Nunca se edita una migración ya aplicada.
2. CI completo: réplica local `ci_pg.sh` más el verificador específico.
3. Ensayo (§4) sobre una copia del estado actual.
4. Expediente al propietario: archivos, migraciones, servicios, riesgos, pruebas y recuperación.
5. Autorización, despliegue y seguimiento (§3).

## 7. Servicios `etnara-reset-once` (1–4) en `hopeful-education`

Revisados en solo lectura el 23-oct-2026:
- Cada uno es una **Railway Function** (bun) de una sola línea: `POST /auth/password-reset/request` para `etnaracare@gmail.com` contra la API de producción.
- Sin cron, sin variables, sin dominios, sin volúmenes.
- Se ejecutaron el 04-oct-2026 (`RESET_REQUEST 200`) y no han vuelto a correr.

Riesgo de mantenerlos: un *Redeploy* o un reinicio de la plataforma envía otro correo de restablecimiento a la cuenta de ETNARA central. No exponen secretos y nada depende de ellos.

**Recomendación**: retirarlos. Ninguna otra pieza los referencia. Antes de eliminarlos se puede guardar su código, ya transcrito en este documento. Hasta tener autorización, no se tocan.
