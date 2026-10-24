/**
 * Pilot preflight for ONE organization in production. STRICTLY READ-ONLY and
 * least-privilege: it logs in as etnara_preflight_ro (ops/rehearsal/
 * preflight-ro-role.create.sql), which has NO table privileges, and calls the
 * fixed summary function etnara_preflight.pilot_summary() inside
 * BEGIN READ ONLY ... ROLLBACK. Refuses any other login, and any login that can
 * read or write a table directly. Prints the summary only (flags, counts,
 * e-mail domains); no names, birth dates, addresses or clinical fields.
 *   PILOT_ORG_ID  full uuid the summary must belong to (cross-check)
 *   PREFLIGHT_URL connection string (Railway variable; never logged)
 */
import { Client } from "pg";

const EXPECTED_ROLE = "etnara_preflight_ro";
const c = new Client({ connectionString: process.env.PREFLIGHT_URL, connectionTimeoutMillis: 15000, statement_timeout: 20000 });

(async () => {
  const org = process.env.PILOT_ORG_ID ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(org)) throw new Error("PILOT_ORG_ID must be a full uuid");
  await c.connect();

  const who = (await c.query<{ u: string; su: boolean; bypass: boolean; createrole: boolean; ro: string; tables: number }>(
    `SELECT current_user u, r.rolsuper su, r.rolbypassrls bypass, r.rolcreaterole createrole,
            current_setting('default_transaction_read_only') ro,
            (SELECT count(*)::int FROM pg_class k JOIN pg_namespace n ON n.oid=k.relnamespace
              WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
                AND k.relkind IN ('r','p','v','m')
                AND has_table_privilege(current_user, k.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
                -- migration 074 grants this one to PUBLIC (every login); RLS + read-only apply
                AND NOT (n.nspname='public' AND k.relname='password_reset_tokens')) tables
       FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  if (who.u !== EXPECTED_ROLE || who.su || who.bypass || who.createrole || who.ro !== "on" || who.tables !== 0)
    throw new Error(`refused: role=${who.u} superuser=${who.su} bypassrls=${who.bypass} createrole=${who.createrole} read_only=${who.ro} tables_with_access=${who.tables}`);
  console.log(`PILOT_PREFLIGHT_ROLE ${who.u} superuser=${who.su} bypassrls=${who.bypass} read_only=${who.ro} tables_with_access=${who.tables}`);

  await c.query("BEGIN READ ONLY");
  if ((await c.query<{ v: string }>(`SELECT current_setting('transaction_read_only') v`)).rows[0].v !== "on") throw new Error("refused: transaction is not read-only");
  const summary = (await c.query<{ s: { organization: { id: string } | null } }>(`SELECT etnara_preflight.pilot_summary() s`)).rows[0].s;
  await c.query("ROLLBACK");
  if (summary.organization && summary.organization.id !== org) throw new Error("summary is for a different organization than PILOT_ORG_ID");
  console.log("PILOT_PREFLIGHT " + JSON.stringify(summary));
})().catch((e) => { console.error("PILOT_PREFLIGHT_ERROR", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => c.end().catch(() => undefined));
