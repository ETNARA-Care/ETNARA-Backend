/**
 * Pilot preflight for ONE organization in production. STRICTLY READ-ONLY and
 * least-privilege: it logs in as etnara_preflight_ro (ops/rehearsal/
 * preflight-ro-role.create.sql), which has NO table privileges, and calls the
 * fixed summary function etnara_preflight.pilot_summary() inside
 * BEGIN READ ONLY ... ROLLBACK. Refuses any other login, any login with a direct
 * table grant, and any table access it cannot attribute to a PUBLIC grant; access
 * inherited from PUBLIC grants is reported explicitly (privileges + visible row
 * count). Prints the summary only (flags, counts, e-mail domains); no names, birth dates, addresses or clinical fields.
 *   PILOT_ORG_ID  full uuid the summary must belong to (cross-check)
 *   PREFLIGHT_URL connection string (Railway variable; never logged)
 */
import { Client } from "pg";

const EXPECTED_ROLE = "etnara_preflight_ro";
const c = new Client({ connectionString: process.env.PREFLIGHT_URL, connectionTimeoutMillis: 15000, statement_timeout: 20000 });

(async () => {
  const org = process.env.PILOT_ORG_ID ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(org)) throw new Error("PILOT_ORG_ID must be a full uuid");
  // The connection string must name the dedicated login (checked before connecting; never printed).
  let urlUser = "";
  try { urlUser = decodeURIComponent(new URL(process.env.PREFLIGHT_URL ?? "").username); } catch { /* invalid URL */ }
  if (urlUser !== EXPECTED_ROLE) throw new Error(`refused: PREFLIGHT_URL must log in as ${EXPECTED_ROLE}`);
  await c.connect();

  const who = (await c.query<{ u: string; su: boolean; bypass: boolean; createrole: boolean; ro: string }>(
    `SELECT current_user u, r.rolsuper su, r.rolbypassrls bypass, r.rolcreaterole createrole,
            current_setting('default_transaction_read_only') ro
       FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  // Table access, split by where it comes from. relacl grantee 0 = PUBLIC (every login).
  const acl = (await c.query<{ tbl: string; effective: boolean; direct: boolean; via_public: string | null; rls: boolean; forced: boolean }>(
    `SELECT n.nspname||'.'||k.relname tbl,
            has_table_privilege(current_user, k.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') effective,
            EXISTS (SELECT 1 FROM aclexplode(k.relacl) a WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname=current_user)) direct,
            (SELECT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) FROM aclexplode(k.relacl) a WHERE a.grantee = 0) via_public,
            k.relrowsecurity rls, k.relforcerowsecurity forced
       FROM pg_class k JOIN pg_namespace n ON n.oid=k.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND k.relkind IN ('r','p','v','m')`)).rows.filter((r) => r.effective);
  const direct = acl.filter((r) => r.direct).map((r) => r.tbl);
  const unexplained = acl.filter((r) => !r.direct && !r.via_public).map((r) => r.tbl);
  if (who.u !== EXPECTED_ROLE || who.su || who.bypass || who.createrole || who.ro !== "on" || direct.length || unexplained.length)
    throw new Error(`refused: role=${who.u} superuser=${who.su} bypassrls=${who.bypass} createrole=${who.createrole} read_only=${who.ro} direct_table_grants=${direct.join("|") || 0} unexplained_access=${unexplained.join("|") || 0}`);
  console.log(`PILOT_PREFLIGHT_ROLE ${who.u} superuser=${who.su} bypassrls=${who.bypass} read_only=${who.ro} direct_table_grants=0`);

  await c.query("BEGIN READ ONLY");
  if ((await c.query<{ v: string }>(`SELECT current_setting('transaction_read_only') v`)).rows[0].v !== "on") throw new Error("refused: transaction is not read-only");
  // Report explicitly any access this login inherits from PUBLIC grants (pre-existing, not ours),
  // and how many rows it can see there with no application context (a count, never row content).
  for (const t of acl.filter((r) => r.via_public)) {
    const [schema, table] = t.tbl.split(".");
    let visible: string;
    await c.query("SAVEPOINT public_probe");   // a failed probe must not abort the transaction
    try {
      visible = String((await c.query<{ n: number }>(`SELECT count(*)::int n FROM ${c.escapeIdentifier(schema)}.${c.escapeIdentifier(table)}`)).rows[0].n);
      await c.query("RELEASE SAVEPOINT public_probe");
    } catch (e) { visible = `error:${e instanceof Error ? e.message : e}`; await c.query("ROLLBACK TO SAVEPOINT public_probe"); }
    console.log(`PILOT_PREFLIGHT_PUBLIC_ACCESS table=${t.tbl} public_privileges=${t.via_public} rls=${t.rls} forced_rls=${t.forced} visible_rows_without_context=${visible}`);
  }
  const summary = (await c.query<{ s: { organization: { id: string } | null } }>(`SELECT etnara_preflight.pilot_summary() s`)).rows[0].s;
  await c.query("ROLLBACK");
  if (!summary || !summary.organization) throw new Error("refused: summary has no organization (wrong id or organization missing)");
  if (summary.organization.id !== org) throw new Error("summary is for a different organization than PILOT_ORG_ID");
  console.log("PILOT_PREFLIGHT " + JSON.stringify(summary));
})().catch((e) => { console.error("PILOT_PREFLIGHT_ERROR", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => c.end().catch(() => undefined));
