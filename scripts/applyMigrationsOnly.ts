/**
 * Aplica exclusivamente las 36 migraciones si el schema no existe todavía.
 *
 * Requiere:
 *   MIGRATIONS_DATABASE_URL -- conexion administrativa (superusuario del proveedor).
 *
 * Uso: MIGRATIONS_DATABASE_URL=... npx tsx scripts/applyMigrationsOnly.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

async function main() {
  const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
  if (!adminUrl) throw new Error("MIGRATIONS_DATABASE_URL is required for applyMigrationsOnly.");

  const client = new Client({ connectionString: adminUrl });
  await client.connect();

  const existing = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'organizations' LIMIT 1`
  );
  if (existing.rows.length > 0) {
    console.log("Schema ya existe -- no se aplican migraciones.");
    await client.end();
    return;
  }

  console.log("Base vacia detectada. Aplicando 36 migraciones en orden...");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  if (files.length !== 36) {
    await client.end();
    throw new Error(`Se esperaban 36 migraciones, se encontraron ${files.length}. Abortando.`);
  }
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    await client.query(sql);
    console.log(`  OK: ${file}`);
  }

  await client.end();
  console.log("Todas las migraciones aplicadas. Conexion cerrada.");
}

main().catch((err) => {
  console.error("applyMigrationsOnly fallo:", err);
  process.exit(1);
});
