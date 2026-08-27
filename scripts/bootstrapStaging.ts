/**
 * Bootstrap de staging: aplica las 38 migraciones (solo si el schema no
 * existe todavia), rota la contraseña placeholder de app_runtime a un
 * valor real, y siembra los datos demo -- idempotente.
 *
 * Requiere DOS variables de entorno distintas:
 *   MIGRATIONS_DATABASE_URL -- conexion administrativa (superusuario del
 *     proveedor). Se usa SOLO aqui, nunca en la app en ejecucion.
 *   APP_RUNTIME_PASSWORD -- contraseña real (reemplaza el placeholder de
 *     la migracion 017) para el rol app_runtime.
 *
 * Uso: MIGRATIONS_DATABASE_URL=... APP_RUNTIME_PASSWORD=... npx tsx scripts/bootstrapStaging.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

async function main() {
  const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
  const runtimePassword = process.env.APP_RUNTIME_PASSWORD;
  if (!adminUrl) throw new Error("MIGRATIONS_DATABASE_URL is required for bootstrap.");
  if (!runtimePassword) throw new Error("APP_RUNTIME_PASSWORD is required for bootstrap.");

  const client = new Client({ connectionString: adminUrl });
  await client.connect();

  const existing = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'organizations' LIMIT 1`
  );
  if (existing.rows.length > 0) {
    console.log("Schema ya existe -- bootstrap omitido (idempotente).");
    await client.end();
    return;
  }

  console.log("Base vacia detectada. Aplicando 38 migraciones en orden...");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  if (files.length !== 38) {
    throw new Error(`Se esperaban 38 migraciones, se encontraron ${files.length}. Abortando.`);
  }
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    await client.query(sql);
    console.log(`  OK: ${file}`);
  }

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
