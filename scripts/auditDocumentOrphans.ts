/**
 * READ-ONLY orphan audit for resident and establishment document files.
 *
 * Background: before migration 125, uploads put the file in object storage
 * first and then the INSERT failed (42501), leaving files with no database
 * row. This script counts them. It NEVER deletes or changes anything: there is
 * no delete, put or copy code here, and the database work runs in a READ ONLY
 * transaction. Deciding what to do with orphans is a separate, human step.
 *
 * Output: ONLY counts per organization id and per prefix, plus total bytes.
 * Never object keys, file names, resident ids or establishment ids.
 *
 *   MIGRATIONS_DATABASE_URL=postgres://<owner or BYPASSRLS role>@host/db
 *   STORAGE_ENDPOINT / STORAGE_REGION / STORAGE_BUCKET /
 *   STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY [/ STORAGE_FORCE_PATH_STYLE]
 *   AUDIT_READ_ONLY_CONFIRM=yes   required when the database or the storage
 *                                 endpoint is not on this machine.
 *   AUDIT_RECENT_MINUTES=15       objects newer than this are reported apart
 *                                 (an upload may still be committing).
 */
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

const PREFIXES = [
  { prefix: "resident-documents/", table: "resident_documents" },
  { prefix: "establishment-documents/", table: "establishment_documents" },
] as const;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const isLocal = (raw: string) => {
  try { return LOCAL_HOSTS.has(new URL(raw).hostname); } catch { return false; }
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

type Tally = { objects: number; bytes: number; orphans: number; orphanBytes: number; recent: number; missing: number };
const blank = (): Tally => ({ objects: 0, bytes: 0, orphans: 0, orphanBytes: 0, recent: 0, missing: 0 });

async function main() {
  const dbUrl = required("MIGRATIONS_DATABASE_URL");
  const endpoint = required("STORAGE_ENDPOINT");
  const local = isLocal(dbUrl) && isLocal(endpoint);
  if (!local && process.env.AUDIT_READ_ONLY_CONFIRM !== "yes") {
    throw new Error("Non-local database or storage: set AUDIT_READ_ONLY_CONFIRM=yes to run this read-only audit");
  }
  const recentMs = Number(process.env.AUDIT_RECENT_MINUTES ?? 15) * 60_000;

  const s3 = new S3Client({
    endpoint,
    region: required("STORAGE_REGION"),
    forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE ?? "true") !== "false",
    credentials: { accessKeyId: required("STORAGE_ACCESS_KEY_ID"), secretAccessKey: required("STORAGE_SECRET_ACCESS_KEY") },
  });
  const bucket = required("STORAGE_BUCKET");

  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  const known = new Map<string, Set<string>>();
  try {
    await db.query("BEGIN TRANSACTION READ ONLY");
    // RLS (FORCE since 125) would hide every row from an ordinary role and make
    // every file look orphaned: refuse instead of printing a wrong answer.
    const role = await db.query<{ ok: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS ok FROM pg_roles WHERE rolname = current_user"
    );
    if (!role.rows[0]?.ok) throw new Error("This audit needs a superuser or BYPASSRLS role (read only); current role would see 0 rows");
    for (const { table } of PREFIXES) {
      const rows = await db.query<{ storage_key: string }>(`SELECT storage_key FROM ${table}`);
      known.set(table, new Set(rows.rows.map((r) => r.storage_key)));
    }
    await db.query("ROLLBACK");
  } finally {
    await db.end();
  }

  const byOrg = new Map<string, Record<string, Tally>>();
  const totals: Record<string, Tally> = {};
  const now = Date.now();
  for (const { prefix, table } of PREFIXES) {
    const keys = known.get(table)!;
    const seen = new Set<string>();
    const total = (totals[prefix] = blank());
    let token: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      for (const obj of page.Contents ?? []) {
        const key = obj.Key ?? "";
        const size = obj.Size ?? 0;
        const org = key.slice(prefix.length).split("/")[0] || "(unknown)";
        const perOrg = byOrg.get(org) ?? {};
        const t = (perOrg[prefix] ??= blank());
        byOrg.set(org, perOrg);
        t.objects++; t.bytes += size; total.objects++; total.bytes += size;
        if (keys.has(key)) { seen.add(key); continue; }
        if (obj.LastModified && now - obj.LastModified.getTime() < recentMs) { t.recent++; total.recent++; continue; }
        t.orphans++; t.orphanBytes += size; total.orphans++; total.orphanBytes += size;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    // Rows whose file is gone (counted by organization, never listed).
    for (const key of keys) {
      if (seen.has(key) || !key.startsWith(prefix)) continue;
      const org = key.slice(prefix.length).split("/")[0] || "(unknown)";
      const perOrg = byOrg.get(org) ?? {};
      (perOrg[prefix] ??= blank()).missing++;
      byOrg.set(org, perOrg);
      total.missing++;
    }
  }

  console.log("Document orphan audit (read only; nothing was changed)\n");
  console.log("| Organization id | Prefix | Objects | Orphans | Orphan bytes | Recent (skipped) | Rows without file |");
  console.log("|---|---|---|---|---|---|---|");
  for (const [org, perOrg] of [...byOrg.entries()].sort()) {
    for (const [prefix, t] of Object.entries(perOrg)) {
      console.log(`| ${org} | ${prefix} | ${t.objects} | ${t.orphans} | ${t.orphanBytes} | ${t.recent} | ${t.missing} |`);
    }
  }
  console.log("\nTotals per prefix:");
  for (const [prefix, t] of Object.entries(totals)) {
    console.log(`  ${prefix} objects=${t.objects} bytes=${t.bytes} orphans=${t.orphans} orphanBytes=${t.orphanBytes} recent=${t.recent} rowsWithoutFile=${t.missing}`);
  }
  const orphanTotal = Object.values(totals).reduce((a, t) => a + t.orphans, 0);
  const orphanBytes = Object.values(totals).reduce((a, t) => a + t.orphanBytes, 0);
  console.log(`\nTOTAL orphans=${orphanTotal} orphanBytes=${orphanBytes}`);
}

main().catch((error) => {
  // Message only: never a stack with keys or connection strings.
  console.error("Document orphan audit failed:", error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, "<db-url>") : "unknown error");
  process.exit(1);
});
