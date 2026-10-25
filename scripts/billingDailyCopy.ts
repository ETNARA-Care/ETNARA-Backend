/**
 * Facturación F2.3 — independent daily copy of billing documents (append-only, verified by SHA-256).
 * NOT scheduled in production until authorised. Intended as a Railway cron service that alone holds
 * the backup bucket's credentials.
 *
 *   MIGRATIONS_DATABASE_URL   read-only transaction: keys and hashes only
 *   BILLING_STORAGE_*         the billing bucket (source)
 *   BILLING_BACKUP_STORAGE_*  the backup bucket (destination; must be a different bucket)
 *   npx tsx scripts/billingDailyCopy.ts
 * Exit code 1 when any object is missing/altered at the source or conflicts in the copy (alert).
 */
import pg from "pg";
import { bucketFromEnv, dailyCopy, EXPECTED_OBJECTS_SQL } from "../src/modules/billing/billingBackup.js";

async function main() {
  const source = bucketFromEnv("BILLING_STORAGE");
  const backup = bucketFromEnv("BILLING_BACKUP_STORAGE");
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!source || !backup || !url) { console.error("BILLING_STORAGE_*, BILLING_BACKUP_STORAGE_* and MIGRATIONS_DATABASE_URL are required"); process.exit(2); }
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  let expected: { key: string; sha256: string }[];
  try {
    await db.query("BEGIN TRANSACTION READ ONLY");
    expected = (await db.query<{ key: string; sha256: string }>(EXPECTED_OBJECTS_SQL)).rows;
    await db.query("COMMIT");
  } finally { await db.end(); }
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Puerto_Rico" }).format(new Date());
  const report = await dailyCopy(source, backup, expected, day);
  console.log(JSON.stringify({ day, expected: expected.length, ...report }));
  if (report.missingOrAlteredInSource.length || report.conflictingCopy.length) process.exitCode = 1;
}
main().catch((e) => { console.error("daily copy failed:", (e as Error).message); process.exit(1); });
