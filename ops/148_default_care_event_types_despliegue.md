# 148: tipos de registro de cuidado por defecto (despliegue y reversión)

Hallazgo A1 de la validación de agencias fundadoras (4-nov-2026): una agencia creada por ETNARA
Central no podía registrar ningún cuidado (409 `EVENT_TYPE_NOT_ENABLED`). Solo Casa Demo
funcionaba, porque `seedDemo` insertaba su configuración.

Nada de esto se hace sin la aprobación expresa de Rafa en cada paso marcado con «APROBACIÓN».

## Qué cambia en producción
- **Esquema:**
  - una tabla nueva sin acceso para `app_runtime` (`care_event_type_default_grants`, con RLS y sin permisos);
  - 3 funciones;
  - un disparador `AFTER INSERT ON organizations`.
- **Datos:** solo **inserta** filas en `organization_care_event_types` para:
  - toda agencia nueva (8 filas);
  - las agencias existentes **sin ninguna fila** y no archivadas (relleno).
  - Nunca hace UPDATE ni DELETE. Las agencias con configuración propia, incluida Casa Demo, **no cambian**.
- **Código del backend:** ningún cambio funcional. Railway aplica la 148 en el `preDeploy` (`bootstrap:staging`) y el ejecutor la envuelve en una transacción: si algo falla, no queda nada aplicado y el despliegue anterior sigue sirviendo.
- **Portal:** sin cambios. Ya muestra los 7 tipos y PHOTO va por el módulo de fotos, apagado.

## Pasos

| Paso | Qué | Comprobación | Si falla |
|---|---|---|---|
| D0 | PITR sano y anotar la hora (UTC) previa al despliegue | Logs de la base: `archive-push … completed successfully` en los últimos minutos | No continuar |
| D1 · solo lectura | Cuántas agencias recibirán el relleno: ver la consulta Q1 | Anotar el número. Se espera que Casa Demo **no** aparezca. | Si aparece una agencia con configuración, revisar antes de seguir |
| D2 · APROBACIÓN | Fusionar el PR. Railway despliega y aplica la 148. | Log del despliegue: `OK: 148_default_care_event_types.sql` y la línea `148: N agencias sin configuración recibieron M tipos` (N = D1, M = 8 × N). Después, `DB_RUNTIME_ROLE` con `app_runtime` y `ready:true`. | La transacción se deshace sola y el despliegue anterior sigue sirviendo. Revisar el log. |
| D3 · solo lectura | Consultas Q2 y Q3 | Q2: toda agencia no archivada tiene ≥ 1 fila. Q3: Casa Demo idéntica a la anotada en D1. | Reversión estándar (R1) |
| D4 | Prueba de humo con una agencia de prueba **ficticia** creada por Central, o la primera agencia fundadora antes de recibir datos reales: un registro de cuidado desde el iPhone | 201 y visible en la cronología de la familia | R1 |

## Consultas de solo lectura (superusuario o rol de lectura)
```sql
-- Q1 (antes): agencias que recibirán el relleno
SELECT o.id, o.name, o.status FROM organizations o
 WHERE o.archived_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM organization_care_event_types x WHERE x.organization_id = o.id)
 ORDER BY o.created_at;
-- Q1b (antes): configuración actual de Casa Demo, para comparar en D3
SELECT cet.code, o.is_enabled, o.label_override, o.display_order, o.is_required
  FROM organization_care_event_types o JOIN care_event_types cet ON cet.id = o.care_event_type_id
  JOIN organizations g ON g.id = o.organization_id
 WHERE g.name LIKE 'Cuidado en Casa Demo%' ORDER BY cet.code;
-- Q2 (después): ninguna agencia activa sin tipos
SELECT o.name FROM organizations o WHERE o.archived_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM organization_care_event_types x WHERE x.organization_id = o.id AND x.is_enabled);
-- Q3 (después): qué insertó 148
SELECT source, count(DISTINCT organization_id) agencias, count(*) filas FROM care_event_type_default_grants GROUP BY 1;
```

## Reversión
- **R1 · estándar (recomendada)**, `ops/148_default_care_event_types.rollback.sql`:
  - retira el disparador, las funciones y el registro; el esquema queda **idéntico al de 147** (probado);
  - **conserva** la configuración creada, así que las agencias siguen pudiendo registrar cuidados;
  - no hace falta volver a desplegar el código;
  - las agencias que se creen después volverán a nacer sin tipos.
- **R2 · completa**, `ops/148_default_care_event_types.rollback_full.sql`:
  - además borra **solo** las filas que puso 148 y que nadie modificó;
  - conserva las que una agencia cambió y las anteriores a 148;
  - devuelve el hallazgo A1 a las agencias afectadas, así que **úsala solo si hay una razón concreta**.
- **R0 · Railway rollback del despliegue:** no revierte la 148, porque está en la base. No hace falta: el código anterior funciona igual con la 148 aplicada.

## Pruebas que la respaldan (CI, bases desechables y datos ficticios)
- `scripts/verifyDefaultCareEventTypes.ts`, en ambos modos (superusuario y `app_runtime`):
  - agencia nueva por HTTP con los 8 tipos;
  - ciclo completo hasta que la familia ve los 7 registros;
  - PHOTO rechazado con el módulo apagado;
  - aislamiento entre agencias;
  - `app_runtime` sin acceso a la función ni al registro;
  - relleno solo sin configuración, respetando la configuración propia y las archivadas;
  - reaplicación idempotente.
- `scripts/verifyDefaultCareEventTypesRollback.ts`: R1 y R2 en bases propias; el esquema queda idéntico al de 147, con nueva aplicación tras la reversión y repetición sin error.
- `tests/defaultCareEventTypes148.test.ts`: garantías estáticas de la migración y de las reversiones.
