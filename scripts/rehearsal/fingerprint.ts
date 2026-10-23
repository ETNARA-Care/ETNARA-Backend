/**
 * Read-only fingerprint of a database, to prove that a PITR copy equals its
 * source and that the source was not touched. Prints ONE line:
 *   FINGERPRINT {"label":...,"tables":N,"rows":N,"dataHash":"…","schemaHash":"…",...}
 * Hashes only -- never row data. The session is forced read-only.
 *
 *   FINGERPRINT_URLS="label1=postgres://…,label2=postgres://…" npx tsx scripts/rehearsal/fingerprint.ts
 */
import { createHash } from "node:crypto";
import { Client } from "pg";

export async function fingerprint(url: string) {
  const c = new Client({ connectionString: url, options: "-c default_transaction_read_only=on" });
  await c.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = (await c.query<{ t: string }>(
      `SELECT format('%I.%I', schemaname, tablename) t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.t);
    const perTable: Record<string, { rows: number; hash: string }> = {};
    for (const t of tables) {
      const r = (await c.query<{ n: string; h: string }>(
        `SELECT count(*)::text n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM ${t} x`)).rows[0];
      perTable[t] = { rows: Number(r.n), hash: r.h };
    }
    const one = async (q: string) => String(Object.values((await c.query(q)).rows[0] ?? {})[0] ?? "");
    const schemaHash = await one(`SELECT md5(string_agg(d, E'\\n' ORDER BY d)) FROM (
        SELECT format('%s.%s %s %s', table_name, column_name, data_type, is_nullable) d FROM information_schema.columns WHERE table_schema='public'
        UNION ALL SELECT format('policy %s.%s %s %s %s %s', tablename, policyname, permissive, cmd, qual, with_check) FROM pg_policies WHERE schemaname='public'
        UNION ALL SELECT format('trigger %s %s', tgrelid::regclass, tgname) FROM pg_trigger WHERE NOT tgisinternal
        UNION ALL SELECT format('fn %s %s', p.oid::regprocedure, md5(pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')
        UNION ALL SELECT format('grant %s %s %s', table_name, grantee, privilege_type) FROM information_schema.role_table_grants WHERE table_schema='public'
        UNION ALL SELECT format('colgrant %s.%s %s %s', table_name, column_name, grantee, privilege_type) FROM information_schema.column_privileges WHERE table_schema='public' AND grantee='app_runtime'
      ) s`);
    const hasHistory = (await one(`SELECT to_regclass('public.schema_migrations') IS NOT NULL`)) === "true";
    const lastMigration = hasHistory ? await one(`SELECT max(filename) FROM schema_migrations`) : null;
    let timeline: number | null = null;
    try { timeline = Number(await one(`SELECT timeline_id FROM pg_control_checkpoint()`)); } catch { timeline = null; }
    const dataHash = createHash("sha256").update(tables.map((t) => `${t}:${perTable[t].rows}:${perTable[t].hash}`).join("\n")).digest("hex");
    await c.query("COMMIT");
    return {
      tables: tables.length, rows: Object.values(perTable).reduce((a, b) => a + b.rows, 0),
      dataHash, schemaHash, lastMigration, timeline,
      policies: Number(await one(`SELECT count(*) FROM pg_policies WHERE schemaname='public'`)),
      perTable,
    };
  } finally { await c.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const pairs = (process.env.FINGERPRINT_URLS ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    if (!pairs.length) throw new Error("FINGERPRINT_URLS is required");
    for (const pair of pairs) {
      const i = pair.indexOf("=");
      const label = pair.slice(0, i), url = pair.slice(i + 1);
      const f = await fingerprint(url);
      const { perTable, ...summary } = f;
      // per-table hashes kept short (counts + first 12 hex chars) so two runs can be diffed from logs
      const compact = Object.fromEntries(Object.entries(perTable).map(([t, v]) => [t.replace(/^public\./, ""), `${v.rows}:${v.hash.slice(0, 12)}`]));
      console.log(`FINGERPRINT ${JSON.stringify({ label, ...summary, perTable: compact })}`);
    }
  })().catch((e) => { console.error((e as Error).message); process.exit(1); });
}
