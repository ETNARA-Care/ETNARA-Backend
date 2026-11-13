# Etapa 0 — Invitaciones de administrador sin token para ETNARA Central: despliegue y reversión

PR de backend (ETNARA-Backend) y PR de frontend (ETNARAMVP), en la rama `claude/session-continuation-q649y3`.
**No fusionar ni desplegar sin la autorización de Rafa.**

## Qué cambia

**Backend**
- `POST /platform/organizations/:id/admin-invitations` deja de devolver `activationToken`.
- `emailDelivery` pasa a ser `{status, error?}` con códigos fijos.

**Rutas nuevas, solo para administradores de la plataforma:**
- `GET /platform/organizations/:id/admin-invitations`
- `POST …/admin-invitations/:invitationId/resend`
- `POST …/admin-invitations/:invitationId/revoke`

**Base de datos**
- Sin migraciones ni cambios de esquema o permisos.
- Solo se añaden filas a `audit_log`, que es de solo inserción para `app_runtime`.

**Frontend**
- El portal de Central deja de mostrar el token.
- Añade la lista de invitaciones con Reenviar y Revocar.

## Orden de despliegue

1. **Frontend primero** (fusionar el PR de ETNARAMVP, que publica GitHub Pages).
   - Funciona con el backend actual: el token, si llega, se descarta en `api/platformOrganizations.ts`.
   - Mientras el backend no tenga las rutas nuevas, la lista de invitaciones responde 404 y la página muestra «No pudimos cargar el estado de las invitaciones». Invitar sigue funcionando.
2. **Backend después** (fusionar el PR de ETNARA-Backend; Railway despliega desde `main`).
   - No hay migración, así que `bootstrap:staging` no aplica nada nuevo.
3. **Comprobación tras desplegar (sin invitaciones reales):**
   - en los logs de arranque, `DB_RUNTIME_ROLE` sigue en `app_runtime` / `requireRestricted:true`;
   - `GET /platform/organizations/:id/admin-invitations` con una sesión de Central responde 200 sin `token`;
   - la misma ruta con una sesión de agencia responde 403.
   - Si se quiere probar el reenvío, hacerlo solo con una agencia y un buzón ficticios autorizados.

## Reversión

| Situación | Acción | Datos |
|---|---|---|
| Problema en el frontend | `git revert` del commit del PR de ETNARAMVP en `main` y nueva publicación de Pages | Ninguno |
| Problema en el backend | `git revert` del commit del PR de ETNARA-Backend en `main`; Railway redespliega, o usar *Rollback* al despliegue anterior en Railway | Las filas `ORG_ADMIN_INVITATION_*` de `audit_log` se quedan (no estorban y no se borran) |
| Se revierte el backend con el frontend nuevo | Sin acción: invitar sigue funcionando; la lista y los botones responden 404 con un aviso | Ninguno |

**Notas sobre la reversión:**
- Un reenvío ya hecho cambió el hash del token de esa invitación. El enlace válido es el último enviado por correo, y eso sigue igual tras revertir.
- Si se revierte solo el backend, Central volvería a recibir `activationToken`, que era el comportamiento anterior. El frontend nuevo no lo muestra.

## Riesgos conocidos

- **Límite por usuario:** se guarda en memoria de una instancia y se reinicia al redesplegar. El límite por invitación está en la base y no se pierde.
- **Alcance de Central:** Central gestiona solo las invitaciones con la marca `ORG_ADMIN_INVITATION_CREATED`, o las anteriores cuyo invitador es administrador de la plataforma sin membresía en esa agencia. La marca solo la escribe la ruta de Central, porque todos los `INSERT INTO audit_log` del código usan acciones fijas. Falsificarla exigiría ejecutar SQL arbitrario como `app_runtime`.
- **Invitaciones de equipo:** las que crea una agencia siguen mostrando su enlace a esa agencia, que es el comportamiento actual. Quedan fuera de esta etapa.
