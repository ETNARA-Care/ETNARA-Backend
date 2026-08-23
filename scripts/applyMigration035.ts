import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const migrationPath = join(
    __dirname,
    "..",
    "migrations",
    "035_backfill_worker_roles.sql"
  );

  const sql = readFileSync(migrationPath, "utf8");

  const client = new Client({
    connectionString: databaseUrl,
  });

  await client.connect();

  try {
    console.log("Applying migration 035_backfill_worker_roles...");
    await client.query(sql);
    console.log("Migration 035 applied successfully.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Migration 035 failed:", error);
  process.exit(1);
});
