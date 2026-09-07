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
 * Este runner aplica cada archivo de `migrations/` y registra su nombre
 * dentro de la MISMA transaccion explicita. Si cualquier instruccion o el
 * registro falla, se hace ROLLBACK y el archivo queda pendiente.
 *
 * Para bases ya bootstrapeadas ANTES de que existiera esta tabla (como
 * staging), no hay registro previo de que 001..033 ya corrieron. Por
 * eso solo se reconoce el bloque 001..033 cuando existe el testigo
 * exclusivo de la ultima migracion histórica. Nunca se interpreta un
 * error generico de objeto duplicado como prueba de que un archivo entero
 * se aplico: una base ambigua se detiene para reconciliacion manual.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";

type MigrationClient = Pick<Client, "query">;
const MIGRATION_LOCK_ID = 1_847_201_038;

export async function ensureSchemaMigrationsTable(client: MigrationClient): Promise<boolean> {
  const existing = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`
  );
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename    text PRIMARY KEY,
       applied_at  timestamptz NOT NULL DEFAULT now()
     )`
  );
  return !existing.rows[0]?.exists;
}

async function baselineLegacyDatabase(
  client: MigrationClient,
  files: string[],
  historyTableWasCreated: boolean
): Promise<void> {
  if (!historyTableWasCreated) return;

  const legacy = await client.query<{ has_schema: boolean; has_last_legacy_migration: boolean }>(`
    SELECT
      to_regclass('public.organizations') IS NOT NULL AS has_schema,
      EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'care_events'
          AND policyname = 'care_events_family_read'
      ) AS has_last_legacy_migration
  `);
  const state = legacy.rows[0];
  if (!state?.has_schema) return;
  if (!state.has_last_legacy_migration) {
    throw new Error(
      "La base contiene un schema previo pero no se pudo confirmar la migracion 033. " +
        "Se detuvo sin marcar migraciones como aplicadas; requiere reconciliacion manual."
    );
  }

  // El bootstrap anterior aplicaba 001..033 secuencialmente y se detenía
  // ante el primer error. La política exclusiva de 033 es por tanto un
  // testigo verificable de que ese bloque histórico terminó completo.
  const legacyFiles = files.filter((file) => Number(file.slice(0, 3)) <= 33);
  await client.query("BEGIN");
  try {
    for (const file of legacyFiles) {
      await client.query(
        `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING`,
        [file]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
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
export async function applyPendingMigrations(client: MigrationClient, migrationsDir: string): Promise<void> {
  const files = listMigrationFiles(migrationsDir);
  await client.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`);
  try {
    const historyTableWasCreated = await ensureSchemaMigrationsTable(client);
    await baselineLegacyDatabase(client, files, historyTableWasCreated);
    const { rows: appliedRows } = await client.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations`
    );
    const applied = new Set(appliedRows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  SKIP (ya registrada): ${file}`);
        continue;
      }

      const migrationSql = readFileSync(join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(migrationSql);
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
        await client.query("COMMIT");
        console.log(`  OK: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migracion ${file} fallo y fue revertida: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`);
  }
}
