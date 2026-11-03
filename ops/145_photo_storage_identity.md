# 145 — Identidad del almacenamiento de fotos (procedimiento de operación)

## Qué es
Antes de borrar o conciliar nada, el backend comprueba que el bucket de fotos es **el mismo** al que pertenece la base de datos:
- un marcador aleatorio vive en el bucket (`_etnara/storage-identity.json`);
- el mismo marcador está en la base (`photo_storage_identity`, una sola fila, solo de anexar).

Si no coinciden, o el marcador falta, la tarea de fotos y las eliminaciones **no tocan el bucket**:
- **Códigos posibles:** `STORAGE_IDENTITY_MISSING`, `STORAGE_IDENTITY_MISMATCH`, `STORAGE_IDENTITY_UNBOUND`, `STORAGE_ACCESS_DENIED`, `STORAGE_BUCKET_NOT_FOUND` y `STORAGE_UNREACHABLE`.
- **Dónde aparecen:** en el registro de ejecuciones (`photo_retention_runs.storage_check`) y en la alerta `PHOTO_STORAGE_CHECK_FAILED`.

## Vinculación automática
- **Cuándo ocurre:** con la base **sin ninguna foto viva** y sin marcador, el arranque (`PHOTO_STORAGE_IDENTITY OK`) o la tarea escriben el marcador en el bucket y lo registran en la base.
- **Por qué es segura:** solo se permite con cero fotos vivas, así que nunca puede «adoptar» un bucket equivocado por encima de fotos reales.

## Vinculación por operador (solo si ya hay fotos y no hay marcador)
Requiere autorización. Úsese solo después de comprobar a mano que el bucket configurado contiene las fotos de esta base:
- abrir una muestra de 5 claves de `stored_files` y verificar que existen en el bucket;
- comprobar que el número de objetos `activity-photos/` coincide con el de fotos vivas.

1. Generar un UUID y subir `_etnara/storage-identity.json` con `{"marker":"<uuid>"}` al bucket correcto (privado, sin URL pública).
2. Como dueño de la base:
   ```sql
   INSERT INTO photo_storage_identity (marker, bound_by) VALUES ('<uuid>', 'operator');
   ```
3. Reiniciar o esperar al arranque: debe aparecer `PHOTO_STORAGE_IDENTITY OK`.

**Cambiar de bucket** (migración planificada) exige copiar todos los objetos, **incluido el marcador**. Nunca se borra la fila de la base para «arreglar» un `MISMATCH`: primero se averigua por qué el bucket no es el esperado.

## Hallazgos de archivos ausentes
`photo_missing_findings` (solo dueño) guarda cada foto viva cuyo archivo dio 404 en una conciliación. Lo que pasa con cada hallazgo:
- con la política **PROVISIONAL**: solo se registra (`policy_provisional`);
- con la política **APPROVED**: se marca como eliminada solo tras una segunda conciliación al menos 24 h después y una tercera comprobación en el momento;
- nunca con una retención vigente (`held`) ni con una retención legal (`legal_hold`);
- nunca si la ejecución se detuvo (`halted`).

Revisión (solo lectura):
```sql
SELECT status, last_outcome, count(*) FROM photo_missing_findings GROUP BY 1, 2;
SELECT started_at, storage_check, missing_found, reconcile_halted, error_codes FROM photo_retention_runs ORDER BY started_at DESC LIMIT 20;
```

## Frenos (H1)
Una conciliación se detiene entera, sin marcar ni borrar nada, si:
- hay más de max(5; 2 %) archivos ausentes (`MISSING_ANOMALY`);
- hay más de max(3; 1 %) errores de almacenamiento (`STORAGE_ERRORS`);
- hay más de max(20; 10 %) huérfanos (`ORPHAN_ANOMALY`).

La purga se detiene tras 5 fallos seguidos (`PURGE_HALTED`).

## Reversión
`ops/145_activity_photos_hardening.rollback.sql`:
- se ejecuta **antes** de revertir 144 y **después** de volver al código anterior;
- se niega a ejecutarse si quedan hallazgos abiertos;
- el marcador del bucket se queda donde está (es inocuo).
