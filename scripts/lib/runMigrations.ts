/**
 * Runner de migraciones idempotente, respaldado por una tabla de control
 * (`schema_migrations`) en vez de un unico gate "¿existe `organizations`?".
 *
 * Root cause que esto corrige: bootstrapStaging.ts/applyMigrationsOnly.ts
 * usaban `SELECT ... FROM organizations` como unico gate para decidir si
 * corrian TODAS las migraciones o NINGUNA. Una vez que `organizations`
 * existe (staging ya bootstrapeado), cualquier migracion agregada despues
 * (034_workers_display_name.sql y siguientes) nunca se volvia a intentar,
 * aunque el archivo estuviera en el repo.
 *
 * Este runner aplica cada archivo de `migrations/` como una unidad atomica
 * (Postgres ejecuta un query multi-statement dentro de una transaccion
 * implicita: o se aplica completo, o no se aplica nada de ese archivo) y
 * registra su nombre en `schema_migrations` al terminar. En la siguiente
 * corrida, cualquier archivo ya registrado se salta.
 *
 * Para bases ya bootstrapeadas ANTES de que existiera esta tabla (como
 * staging), no hay registro previo de que 001..033 ya corrieron. Por
 * convencion de este repo, un archivo de migracion ya aplicado nunca se
 * edita despues (los cambios nuevos siempre son un archivo nuevo, ver
 * 034 y el duplicado 037 de 035_backfill_worker_roles.sql) -- por lo
 * tanto, si reintentamos un archivo viejo y falla porque el objeto que
 * crea ya existe (columna/tabla/politica/funcion duplicada), es seguro
 * concluir que ESE ARCHIVO COMPLETO ya se aplico anteriormente (gracias a
 * la atomicidad por archivo) y simplemente registrarlo, sin reintentar
 * partes. Cualquier otro error se propaga y detiene el bootstrap.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";

// Codigos SQLSTATE de Postgres para "el objeto que este archivo intenta
// crear ya existe" -- ver https://www.postgresql.org/docs/current/errcodes-appendix.html
const ALREADY_EXISTS_SQLSTATES = new Set([
  "42701", // duplicate_column
  "42710", // duplicate_object (ej. policy, role)
  "42P07", // duplicate_table (incluye indices/relaciones)
  "42723", // duplicate_function
  "42P06", // duplicate_schema
  "42P04", // duplicate_database
  "42712", // duplicate_alias
  "23505", // unique_violation -- migraciones de seed/catalogo antiguas (ej.
           // 027) insertan una fila fija sin ON CONFLICT; en un re-intento
           // legitimo esto solo puede significar que ese archivo, como
           // unidad atomica, ya se aplico por completo antes.
]);

export async function ensureSchemaMigrationsTable(client: Client): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename    text PRIMARY KEY,
       applied_at  timestamptz NOT NULL DEFAULT now()
     )`
  );
}

export function listMigrationFiles(migrationsDir: string): string[] {
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  if (files.length === 0) {
    throw new Error(`No se encontraron archivos de migracion en ${migrationsDir}.`);
  }
  return files;
}

/**
 * Aplica cada migracion pendiente (no registrada en `schema_migrations`).
 * Idempotente y seguro para correr repetidamente contra la misma base,
 * incluyendo una base bootstrapeada antes de que existiera la tabla de
 * control.
 */
export async function applyPendingMigrations(client: Client, migrationsDir: string): Promise<void> {
  await ensureSchemaMigrationsTable(client);

  const files = listMigrationFiles(migrationsDir);
  const { rows: appliedRows } = await client.query<{ filename: string }>(
    `SELECT filename FROM schema_migrations`
  );
  const applied = new Set(appliedRows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  SKIP (ya registrada): ${file}`);
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), "utf8");
    try {
      await client.query(sql);
      console.log(`  OK: ${file}`);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code && ALREADY_EXISTS_SQLSTATES.has(code)) {
        console.log(`  YA APLICADA (objeto duplicado detectado, se registra sin reintentar): ${file} [${code}]`);
      } else {
        throw new Error(`Migracion ${file} fallo: ${(err as Error).message}`);
      }
    }

    await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING`, [file]);
  }
}
