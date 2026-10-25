/**
 * Facturación F2.3 — recover ONE lost or damaged invoice PDF without changing the issued invoice.
 * Operator tool (ETNARA). Dry run by default: it only reports whether the stored object is intact and
 * whether a verified rebuild is possible. It never prints invoice content, names or amounts.
 *
 *   MIGRATIONS_DATABASE_URL=postgres://<owner>@host/db   (reads billing rows; RLS is not forced for the owner)
 *   BILLING_STORAGE_*                                     (the billing bucket)
 *   npx tsx scripts/billingRecoverDocument.ts <organizationId> <invoiceId> <original|void_copy> <operatorUserId>
 *   BILLING_RECOVERY_APPLY=yes  → writes the rebuilt bytes back to the SAME key, only if their SHA-256 matches.
 * With BILLING_BACKUP_STORAGE_* set, the daily copy is tried first (verified by hash); then the rebuild.
 */
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { recoverInvoiceDocument } from "../src/modules/billing/billingRecovery.js";
import { bucketFromEnv } from "../src/modules/billing/billingBackup.js";

async function main() {
  const [organizationId, invoiceId, kind, actorUserId] = process.argv.slice(2);
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!uuid.test(organizationId ?? "") || !uuid.test(invoiceId ?? "") || !["original", "void_copy"].includes(kind ?? "") || !uuid.test(actorUserId ?? "")) {
    console.error("usage: billingRecoverDocument.ts <organizationId> <invoiceId> <original|void_copy> <operatorUserId>"); process.exit(2);
  }
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) { console.error("MIGRATIONS_DATABASE_URL is required"); process.exit(2); }
  const apply = process.env.BILLING_RECOVERY_APPLY === "yes";
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 1 }) }) });
  try {
    const out = await db.transaction().execute((trx) => recoverInvoiceDocument(trx as never, { organizationId, invoiceId, kind: kind as "original" | "void_copy", actorUserId, apply,
      copies: (() => { const backup = bucketFromEnv("BILLING_BACKUP_STORAGE"); const source = bucketFromEnv("BILLING_STORAGE"); return backup && source ? { backup, source } : undefined; })() }));
    console.log(JSON.stringify({ invoiceId, kind, apply, ...out }));
    process.exitCode = out.status === "REFUSED" ? 1 : 0;
  } finally { await db.destroy(); }
}
main().catch((e) => { console.error("recovery failed:", (e as Error).message); process.exit(1); });
