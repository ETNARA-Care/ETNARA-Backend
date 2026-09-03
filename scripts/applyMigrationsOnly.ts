/**
 * Aplica exclusivamente las migraciones PENDIENTES (registradas en
 * `schema_migrations`), sin sembrar datos demo ni rotar contraseñas.
 *
 * Ya no usa "¿existe `organizations`?" como gate: cada archivo se aplica
 * una sola vez de forma independiente -- ver scripts/lib/runMigrations.ts.
 *
 * Requiere:
 *   MIGRATIONS_DATABASE_URL -- conexion administrativa (superusuario del proveedor).
 *
 * Uso: MIGRATIONS_DATABASE_URL=... npx tsx scripts/applyMigrationsOnly.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

async function main(): Promise<void> {
  const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
  if (!adminUrl) throw new Error("MIGRATIONS_DATABASE_URL is required for applyMigrationsOnly.");

  const client = new Client({ connectionString: adminUrl });
  await client.connect();

  console.log("Aplicando migraciones pendientes (idempotente, no borra ni resetea nada)...");
  await applyPendingMigrations(client, MIGRATIONS_DIR);

  await client.end();
  console.log("Listo. Conexion cerrada.");
}

main().catch((err) => {
  console.error("applyMigrationsOnly fallo:", err);
  process.exit(1);
});
