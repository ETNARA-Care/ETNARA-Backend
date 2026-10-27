# Rotación de las cuentas demo de Casa Demo (Railway Functions, un solo uso)

Archivos para copiar tal cual en una Railway Function (Bun). Objetivos fijados en el código:
Casa Demo `febe519d-3504-4488-a741-d962db40be89`, 5 cuentas `@demo.etnara.care`, buzón de alias `etnaracare@gmail.com`.
Leen solo `DATABASE_URL` (referencia `${{etnara-care-staging-db.DATABASE_URL}}`), solo red privada `*.railway.internal`,
límite total 120 s, reinicio NEVER. Se eliminan al terminar.

- `simulate.function.ts` — simulación: `apply: false` fijo; huella antes/después (`sinCambios`). Ejecutada en producción el 27-oct-2026 08:42: sinCambios=true.
- `apply.function.ts` — rotación real: alias `etnaracare+demo-<cuenta>@gmail.com`, contraseñas aleatorias distintas, sesiones y enlaces anulados, auditoría; comprueba antes (5 cuentas, alias libres, lista aprobada) y después (11 chequeos).
- `revert-emails.function.ts` — recuperación: devuelve los 5 correos @demo.etnara.care desde la auditoría; las contraseñas siguen aleatorias.

Pruebas: `scripts/verifySecureDemoAccounts.ts` (con `VERIFY_ALIAS_MAILBOX=etnaracare@gmail.com VERIFY_CENTRAL_EMAIL=etnaracare@gmail.com`).
