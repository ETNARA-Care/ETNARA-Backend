/**
 * Bootstrap de staging: aplica las migraciones PENDIENTES (llevando un
 * registro en `schema_migrations`, no un unico gate de "¿existe
 * `organizations`?"), rota la contraseña de app_runtime al valor real
 * (operacion en si idempotente -- fijar la misma password de nuevo no
 * tiene efecto adverso), y siembra los datos demo -- todo idempotente.
 *
 * Importante: este script YA NO se detiene solo porque `organizations`
 * exista. Antes, una vez que staging tenia el schema base, cualquier
 * migracion agregada despues (034_workers_display_name.sql en adelante)
 * nunca se aplicaba. Ahora cada archivo de `migrations/` se aplica una
 * sola vez, registrado individualmente -- ver scripts/lib/runMigrations.ts.
 *
 * Requiere DOS variables de entorno distintas:
 *   MIGRATIONS_DATABASE_URL -- conexion administrativa (superusuario del
 *     proveedor). Se usa SOLO aqui, nunca en la app en ejecucion.
 *   APP_RUNTIME_PASSWORD -- contraseña real (reemplaza el placeholder de
 *     la migracion 017) para el rol app_runtime.
 *
 * Uso: MIGRATIONS_DATABASE_URL=... APP_RUNTIME_PASSWORD=... npx tsx scripts/bootstrapStaging.ts
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

async function main() {
  const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
  const runtimePassword = process.env.APP_RUNTIME_PASSWORD;
  if (!adminUrl) throw new Error("MIGRATIONS_DATABASE_URL is required for bootstrap.");
  if (!runtimePassword) throw new Error("APP_RUNTIME_PASSWORD is required for bootstrap.");

  const client = new Client({ connectionString: adminUrl });
  await client.connect();

  console.log("Aplicando migraciones pendientes (idempotente, no borra ni resetea nada)...");
  await applyPendingMigrations(client, MIGRATIONS_DIR);

  console.log("Rotando password placeholder de app_runtime...");
  await client.query(`ALTER ROLE app_runtime PASSWORD '${runtimePassword.replace(/'/g, "''")}'`);

  await client.end();

  console.log("Sembrando datos demo usando la conexion administrativa (crear una organizacion es una operacion de plataforma sin endpoint de usuario -- app_runtime, correctamente, no puede hacerlo por diseño de RLS)...");
  const { execSync } = await import("node:child_process");
  execSync("npx tsx scripts/seedDemo.ts", {
    cwd: join(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: adminUrl },
    stdio: "inherit",
  });

  const url = new URL(adminUrl);

  console.log("\nBootstrap completo.");
  console.log("DATABASE_URL de la app en ejecucion (rol app_runtime, nunca el superusuario):");
  console.log(`  postgres://app_runtime:<APP_RUNTIME_PASSWORD>@${url.host}${url.pathname}`);
}

main().catch((err) => {
  console.error("Bootstrap fallo:", err);
  process.exit(1);
});
