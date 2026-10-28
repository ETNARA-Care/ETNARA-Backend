# B4 · Reversión de las migraciones 132–135 (sin el editor SQL de Railway)

El editor «Query» de Railway añade `LIMIT` al texto y no puede ejecutar estas reversiones. Se ejecutan con una
función temporal de Railway (Bun), igual que la corrección del rol de la supervisora del 27-oct-2026.

| Archivo | PR | Qué hace |
|---|---|---|
| `revert-234-sim.function.ts` / `revert-234-apply.function.ts` | #234 | Revierte 134 y luego 132 (solo las que estén aplicadas) |
| `revert-235-sim.function.ts` / `revert-235-apply.function.ts` | #235 | Revierte 135 y luego 133 (solo las que estén aplicadas) |

- Ejecutan los scripts `ops/13x_*.rollback.sql` de cada PR, sin sus `BEGIN/COMMIT`, dentro de una sola transacción.
- La simulación hace siempre ROLLBACK. La aplicación solo hace COMMIT si se cumplen todas estas condiciones:
  - las migraciones quedan retiradas de `schema_migrations`;
  - sus funciones, disparadores y tabla ya no existen;
  - 12 tablas de datos quedan idénticas en recuento y huella (comprobado con una foto REPEATABLE READ dentro de la misma transacción).
- Solo red privada de Railway. Límites: 120 s en total, sentencia 30 s, bloqueo 5 s.

**Orden obligatorio:**
1. Revertir primero el **código** en `main`, lo que despliega el backend anterior. El backend anterior funciona con las migraciones aplicadas (probado).
2. Después, la base: simulación y luego aplicación.
3. Si se revierten los dos PR, primero #235 y después #234.

**Datos:** ninguna reversión borra datos.
- La de 135 renombra el historial a `shift_schedule_corrections_rolled_back_135` y lo conserva.
- Una segunda reversión de 135 se detiene si esa tabla ya existe; hay que renombrarla antes.
