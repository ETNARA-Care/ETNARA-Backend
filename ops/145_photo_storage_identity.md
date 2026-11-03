# 145 — Identidad del almacenamiento de fotos (procedimiento de operación)

## Qué es
Antes de borrar o conciliar nada, el backend comprueba que el bucket de fotos es **el mismo** al que pertenece la base de datos:
- un marcador aleatorio vive en el bucket (`_etnara/storage-identity.json`);
- el mismo marcador está en la base (`photo_storage_identity`, una sola fila, solo de anexar).

Si no coinciden, o el marcador falta, la tarea de fotos y las eliminaciones **no tocan el bucket**:
- **Códigos posibles:** `STORAGE_IDENTITY_MISSING`, `STORAGE_IDENTITY_MISMATCH`, `STORAGE_IDENTITY_UNBOUND`, `STORAGE_ACCESS_DENIED`, `STORAGE_BUCKET_NOT_FOUND` y `STORAGE_UNREACHABLE`.
- **Dónde aparecen:** en el registro de ejecuciones (`photo_retention_runs.storage_check`) y en la alerta `PHOTO_STORAGE_CHECK_FAILED`.

## Vinculación automática
- **Cuándo ocurre:** solo en un despliegue nuevo de verdad. Las cinco condiciones deben cumplirse:
  - ninguna foto viva;
  - ninguna eliminación en cola;
  - ningún archivo de foto sin purgar en la base;
  - ningún marcador en el bucket;
  - ningún objeto `activity-photos/` en el bucket.
- **Cómo:** la base decide primero (una sola réplica gana) y luego escribe su marcador. Al arrancar aparece `PHOTO_STORAGE_IDENTITY OK`.
- **Lo que nunca hace:** adoptar un marcador ya existente, como el de otro despliegue.

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
`photo_missing_findings` (solo dueño) guarda cada foto viva cuyo archivo dio 404 en una conciliación, con su clave original (`original_storage_key`). Así un veredicto equivocado se puede rastrear aunque la marca de eliminada sobrescriba la clave.

**Qué cuenta como confirmación:** solo las ejecuciones limpias, con la política APPROVED y sin freno. Cada una debe ser al menos 12 h posterior a la anterior. Las ejecuciones con política provisional o detenidas registran el hallazgo pero **no cuentan**.

**Cuándo se marca como eliminada:**
- solo con dos confirmaciones;
- la primera hace al menos 24 h;
- se comprueba otra vez en el momento;
- nunca con una retención vigente (`held`) ni con una retención legal (`legal_hold`).

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
