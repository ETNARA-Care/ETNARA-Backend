/**
 * Bootstrap de staging: aplica migraciones pendientes, rota la contraseña
 * de app_runtime, siembra datos demo y finalmente separa la identidad
 * administrativa de ETNARA Plataforma de las organizaciones demo.
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

  console.log("Sembrando datos demo usando la conexion administrativa...");
  const { execSync } = await import("node:child_process");
  const childEnv = { ...process.env, DATABASE_URL: adminUrl };
  execSync("npx tsx scripts/seedDemo.ts", {
    cwd: join(__dirname, ".."),
    env: childEnv,
    stdio: "inherit",
  });

  console.log("Separando ETNARA Plataforma de las membresias de organizaciones...");
  execSync("npx tsx scripts/decouplePlatformAdmin.ts", {
    cwd: join(__dirname, ".."),
    env: childEnv,
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
