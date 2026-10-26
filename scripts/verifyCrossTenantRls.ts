/**
 * Security audit 26-oct-2026 — generic cross-agency probe at the DATABASE layer (no application code involved).
 *
 * For every public table with an organization_id column, as a real user of agency A (admin, then caregiver):
 *   - SELECT rows of any other agency                   → must see 0 (unless the table is cross-agency by design)
 *   - UPDATE / DELETE rows of any other agency          → must affect 0 rows (inside a savepoint, always rolled back)
 * The same probe as `postgres` shows what the database does NOT block when the backend runs as the superuser
 * (production before the fix). Counts only; no row content is ever read or printed.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> npx tsx scripts/verifyCrossTenantRls.ts
 * Run it on a database that already holds data of several agencies (e.g. after the CI suites).
 */
import pg from "pg";
import { randomBytes } from "node:crypto";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");

// Tables where rows of other agencies are visible ON PURPOSE, with the reason (reviewed list; anything else fails).
const CROSS_AGENCY_BY_DESIGN: Record<string, string> = {};

// The user's OWN rows in other agencies are not a leak: her memberships and roles (agency switcher) and her own
// notifications (/me/notifications lists every agency). Anything else of another agency is.
const SELF_FILTERS: Record<string, string> = {
  organization_memberships: "x.user_id = $2::uuid",
  notifications: "x.user_id = $2::uuid",
  user_roles: "EXISTS (SELECT 1 FROM organization_memberships om WHERE om.id = x.organization_membership_id AND om.user_id = $2::uuid)",
};
// Readable by design but never writable: a caregiver's professional files (no agency; every agency she works for
// reads them). Writes on them are still probed (and covered in detail by X07–X10).
const READ_ONLY_BY_DESIGN: Record<string, string> = {
  stored_files: "x.scope_type = 'PLATFORM_PROFESSIONAL' AND x.organization_id IS NULL",
};
const readFilter = (t: string) => `(${READ_ONLY_BY_DESIGN[t] ?? "false"})`;
const selfFilter = (t: string) => `(${SELF_FILTERS[t] ?? "false"} AND $2::uuid IS NOT NULL)`;

type Probe = { table: string; foreignRows: number; visible: number; updatable: number; deletable: number; error?: string };
const results: { check: string; pass: boolean; detail: string }[] = [];
const check = (check: string, pass: boolean, detail = "") => results.push({ check, pass, detail });

async function probeAs(client: pg.Client, tables: string[], org: string, user: string, label: string): Promise<Probe[]> {
  const out: Probe[] = [];
  for (const t of tables) {
    const p: Probe = { table: t, foreignRows: 0, visible: 0, updatable: 0, deletable: 0 };
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_user_id', $1, true), set_config('app.current_org_id', $2, true), set_config('app.is_superadmin', 'false', true)", [user, org]);
      p.visible = Number((await client.query(`SELECT count(*) AS n FROM public."${t}" x WHERE x.organization_id IS DISTINCT FROM $1::uuid AND NOT ${selfFilter(t)} AND NOT ${readFilter(t)}`, [org, user])).rows[0].n);
      await client.query("SAVEPOINT w");
      try {
        p.updatable = (await client.query(`UPDATE public."${t}" x SET organization_id = x.organization_id WHERE x.organization_id IS DISTINCT FROM $1::uuid AND NOT ${selfFilter(t)}`, [org, user])).rowCount ?? 0;
      } catch { p.updatable = 0; } // refused (no privilege / trigger): counts as blocked
      await client.query("ROLLBACK TO SAVEPOINT w");
      try {
        p.deletable = (await client.query(`DELETE FROM public."${t}" x WHERE x.organization_id IS DISTINCT FROM $1::uuid AND NOT ${selfFilter(t)}`, [org, user])).rowCount ?? 0;
      } catch { p.deletable = 0; }
      await client.query("ROLLBACK TO SAVEPOINT w");
      await client.query("ROLLBACK");
    } catch (e) {
      // SELECT refused entirely (no privilege) = blocked; record the code for the report.
      p.error = (e as { code?: string }).code ?? "ERR";
      await client.query("ROLLBACK").catch(() => undefined);
    }
    out.push(p);
  }
  void label;
  return out;
}

async function main() {
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  const runtimePassword = randomBytes(18).toString("hex");
  await admin.query(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  const runtime = new pg.Client({ connectionString: u.toString() }); await runtime.connect();

  const tables = (await admin.query<{ t: string }>(`
    SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1`)).rows.map((r) => r.t);
  const noRls = (await admin.query<{ t: string }>(`
    SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity AND c.relname = ANY($1) ORDER BY 1`, [tables])).rows.map((r) => r.t);
  check("X01 every table with organization_id has row level security enabled", noRls.length === 0, `tables=${tables.length} withoutRls=[${noRls.join(",")}]`);

  // Agencies that hold data, with one active admin and one active caregiver each.
  const actors = (await admin.query<{ org: string; role: string; user_id: string }>(`
    SELECT DISTINCT ON (om.organization_id, kind) om.organization_id AS org, kind AS role, om.user_id
    FROM organization_memberships om
    JOIN LATERAL (SELECT CASE WHEN EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.organization_membership_id = om.id AND r.code = 'ORGANIZATION_ADMIN') THEN 'admin'
                              WHEN EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.organization_membership_id = om.id AND r.code = 'WORKER') THEN 'caregiver' END AS kind) k ON k.kind IS NOT NULL
    WHERE om.status = 'active'
    ORDER BY om.organization_id, kind, om.created_at`)).rows;
  const orgsWithData = new Set(actors.map((a) => a.org));
  check("X02 the database holds several agencies with admins and caregivers (the probe is meaningful)", orgsWithData.size >= 3 && actors.some((a) => a.role === "caregiver"),
    `agencies=${orgsWithData.size} actors=${actors.length}`);

  const sampleActors = actors; // every agency, admin and caregiver
  const leaks: string[] = []; const leakDetail: Array<Record<string, unknown>> = []; const superuserExposure = new Map<string, number>();
  let probes = 0;
  for (const a of sampleActors) {
    const asRuntime = await probeAs(runtime, tables, a.org, a.user_id, "app_runtime");
    const asPostgres = await probeAs(admin, tables, a.org, a.user_id, "postgres");
    for (let i = 0; i < tables.length; i++) {
      const r = asRuntime[i], s = asPostgres[i];
      probes++;
      if (s.visible > 0) superuserExposure.set(r.table, Math.max(superuserExposure.get(r.table) ?? 0, s.visible));
      if (CROSS_AGENCY_BY_DESIGN[r.table]) continue;
      if (r.visible > 0 || r.updatable > 0 || r.deletable > 0) {
        leaks.push(`${r.table}(${a.role}: see=${r.visible} upd=${r.updatable} del=${r.deletable})`);
        leakDetail.push({ table: r.table, role: a.role, org: a.org, user: a.user_id, see: r.visible, upd: r.updatable, del: r.deletable });
      }
    }
  }
  check("X03 as app_runtime, no admin or caregiver can read, update or delete another agency's rows in any organization table",
    leaks.length === 0, `probes=${probes} leaks=[${leaks.slice(0, 15).join(", ")}${leaks.length > 15 ? ", …" : ""}]`);
  if (process.env.CROSS_TENANT_DETAIL) console.log("LEAKS " + JSON.stringify(leakDetail));
  check("X04 control: as postgres (current production) the same probes reach other agencies' rows (RLS bypassed)",
    superuserExposure.size > 0, `tablesExposedToSuperuser=${superuserExposure.size}/${tables.length}`);

  // Professional files (migration 130): a caregiver active in agencies A and B; another agency must never alter them.
  {
    const tag = randomBytes(4).toString("hex");
    const one = async (s: string, p: unknown[] = []) => (await admin.query(s, p)).rows[0];
    const roleId = async (code: string) => (await one(`SELECT id FROM roles WHERE code = $1`, [code])).id as string;
    const org = async (n: string) => (await one(`INSERT INTO organizations (name, organization_type, status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [`X130 ${n} ${tag}`])).id as string;
    const user = async (n: string) => (await one(`INSERT INTO users (email, status) VALUES ($1,'active') RETURNING id`, [`x130-${n}-${tag}@example.invalid`])).id as string;
    const member = async (u: string, o: string, code: string) => {
      const m = (await one(`INSERT INTO organization_memberships (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`, [u, o])).id as string;
      await admin.query(`INSERT INTO user_roles (organization_membership_id, organization_id, role_id) VALUES ($1,$2,$3)`, [m, o, await roleId(code)]);
    };
    const orgA = await org("A"), orgB = await org("B"), orgC = await org("C");
    const adminA = await user("admin-a"), adminB = await user("admin-b"), cgUser = await user("caregiver"), adminC = await user("admin-c");
    await member(adminA, orgA, "ORGANIZATION_ADMIN"); await member(adminB, orgB, "ORGANIZATION_ADMIN"); await member(adminC, orgC, "ORGANIZATION_ADMIN");
    await member(cgUser, orgA, "WORKER"); await member(cgUser, orgB, "WORKER");
    const worker = (await one(`INSERT INTO workers (user_id, display_name) VALUES ($1,'X130 Caregiver') RETURNING id`, [cgUser])).id as string;
    for (const o of [orgA, orgB]) await admin.query(`INSERT INTO organization_worker_memberships (worker_id, organization_id, status, internal_role) VALUES ($1,$2,'active','caregiver')`, [worker, o]);
    const file = (await one(`INSERT INTO stored_files (scope_type, owner_worker_id, storage_key, content_type, original_filename, size_bytes, uploaded_by_user_id, visibility, status)
      VALUES ('PLATFORM_PROFESSIONAL',$1,$2,'application/pdf','licencia-ficticia.pdf',100,$3,'private','active') RETURNING id`, [worker, `credentials/x130/${tag}`, cgUser])).id as string;

    const as = async <T>(u: string, o: string, work: () => Promise<T>) => {
      await runtime.query("BEGIN");
      try {
        await runtime.query("SELECT set_config('app.current_user_id', $1, true), set_config('app.current_org_id', $2, true), set_config('app.is_superadmin', 'false', true)", [u, o]);
        return await work();
      } finally { await runtime.query("ROLLBACK"); }
    };
    const attempt = async (sqlText: string, p: unknown[]) => {
      await runtime.query("SAVEPOINT a");
      try { const r = await runtime.query(sqlText, p); await runtime.query("RELEASE SAVEPOINT a"); return `rows=${r.rowCount}`; }
      catch (e) { await runtime.query("ROLLBACK TO SAVEPOINT a"); return `denied:${(e as { code?: string }).code}`; }
    };

    const b = await as(adminB, orgB, async () => ({
      sees: Number((await runtime.query(`SELECT count(*) AS n FROM stored_files WHERE id = $1`, [file])).rows[0].n),
      hide: await attempt(`UPDATE stored_files SET status = 'hidden' WHERE id = $1`, [file]),
      visibility: await attempt(`UPDATE stored_files SET visibility = 'organization' WHERE id = $1`, [file]),
      owner: await attempt(`UPDATE stored_files SET owner_worker_id = NULL WHERE id = $1`, [file]),
      del: await attempt(`DELETE FROM stored_files WHERE id = $1`, [file]),
    }));
    check("X07 professional file of a caregiver shared by agencies A and B: agency B still reads it, but cannot hide it, change visibility or owner, or delete it",
      b.sees === 1 && /rows=0|denied/.test(b.hide) && b.visibility.startsWith("denied") && b.owner.startsWith("denied") && b.del.startsWith("denied"), JSON.stringify(b));

    const a = await as(adminA, orgA, async () => {
      const ins = await attempt(`INSERT INTO stored_files (scope_type, owner_worker_id, storage_key, content_type, original_filename, size_bytes, uploaded_by_user_id, visibility, status)
        VALUES ('PLATFORM_PROFESSIONAL',$1,$2,'application/pdf','x.pdf',1,$3,'private','hidden')`, [worker, `credentials/x130/${tag}/a`, adminA]);
      const id = (await runtime.query(`SELECT id FROM stored_files WHERE storage_key = $1`, [`credentials/x130/${tag}/a`])).rows[0]?.id;
      const forgedUploader = await attempt(`INSERT INTO stored_files (scope_type, owner_worker_id, storage_key, content_type, original_filename, size_bytes, uploaded_by_user_id, visibility, status)
        VALUES ('PLATFORM_PROFESSIONAL',$1,$2,'application/pdf','x.pdf',1,$3,'private','hidden')`, [worker, `credentials/x130/${tag}/forged`, cgUser]);
      const preActive = await attempt(`INSERT INTO stored_files (scope_type, owner_worker_id, storage_key, content_type, original_filename, size_bytes, uploaded_by_user_id, visibility, status)
        VALUES ('PLATFORM_PROFESSIONAL',$1,$2,'application/pdf','x.pdf',1,$3,'private','active')`, [worker, `credentials/x130/${tag}/active`, adminA]);
      const complete = id ? await attempt(`UPDATE stored_files SET status = 'active' WHERE id = $1`, [id]) : "missing";
      const reHide = await attempt(`UPDATE stored_files SET status = 'hidden' WHERE id = $1`, [file]);
      return { ins, forgedUploader, preActive, complete, reHide };
    });
    check("X08 a manager uploading for the caregiver (credentialing flow): inserts a hidden file as uploader and completes it; cannot forge the uploader, insert it already active, or touch the caregiver's existing file",
      a.ins === "rows=1" && a.complete === "rows=1" && a.forgedUploader.startsWith("denied") && a.preActive.startsWith("denied") && /rows=0|denied/.test(a.reHide), JSON.stringify(a));

    const w = await as(cgUser, orgB, async () => {
      const ins = await attempt(`INSERT INTO stored_files (scope_type, owner_worker_id, storage_key, content_type, original_filename, size_bytes, uploaded_by_user_id, visibility, status)
        VALUES ('PLATFORM_PROFESSIONAL',$1,$2,'application/pdf','x.pdf',1,$3,'private','hidden')`, [worker, `credentials/x130/${tag}/w`, cgUser]);
      const id = (await runtime.query(`SELECT id FROM stored_files WHERE storage_key = $1`, [`credentials/x130/${tag}/w`])).rows[0]?.id;
      return { ins, complete: id ? await attempt(`UPDATE stored_files SET status = 'active' WHERE id = $1`, [id]) : "missing" };
    });
    check("X09 the caregiver uploads and completes her own professional file", w.ins === "rows=1" && w.complete === "rows=1", JSON.stringify(w));

    const c = await as(adminC, orgC, async () => ({
      sees: Number((await runtime.query(`SELECT count(*) AS n FROM stored_files WHERE id = $1`, [file])).rows[0].n),
      ins: await attempt(`INSERT INTO stored_files (scope_type, owner_worker_id, storage_key, content_type, original_filename, size_bytes, uploaded_by_user_id, visibility, status)
        VALUES ('PLATFORM_PROFESSIONAL',$1,$2,'application/pdf','x.pdf',1,$3,'private','hidden')`, [worker, `credentials/x130/${tag}/c`, adminC]),
    }));
    check("X10 an agency where the caregiver does not work neither sees her professional files nor uploads in her name", c.sees === 0 && c.ins.startsWith("denied"), JSON.stringify(c));
  }

  // Superuser-only escalation attempts must fail for app_runtime.
  const esc: string[] = [];
  for (const [label, sqlText] of [
    ["SET ROLE postgres", "SET ROLE postgres"],
    ["ALTER ROLE self BYPASSRLS", "ALTER ROLE app_runtime BYPASSRLS"],
    ["disable RLS", "ALTER TABLE public.care_recipients DISABLE ROW LEVEL SECURITY"],
    ["session_replication_role", "SET session_replication_role = replica"],
    ["read server file", "SELECT pg_read_file('postgresql.conf')"],
    ["create role", "CREATE ROLE etnara_probe_tmp"],
  ] as const) {
    try { await runtime.query("BEGIN"); await runtime.query(sqlText); esc.push(label); } catch { /* refused: good */ } finally { await runtime.query("ROLLBACK").catch(() => undefined); }
  }
  check("X05 app_runtime cannot escalate (SET ROLE postgres, BYPASSRLS, disable RLS, replication role, server files, CREATE ROLE)", esc.length === 0, `allowed=[${esc.join(",")}]`);

  const role = (await runtime.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`)).rows[0];
  const owned = Number((await runtime.query(`SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND pg_has_role(current_user, c.relowner, 'USAGE')`)).rows[0].n);
  check("X06 app_runtime is NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB and owns no object in public", !role.rolsuper && !role.rolbypassrls && !role.rolcreaterole && !role.rolcreatedb && owned === 0, JSON.stringify({ ...role, owned }));

  await runtime.end(); await admin.end();
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const passed = results.filter((r) => r.pass).length;
  console.log(`Cross-tenant RLS: ${passed}/${results.length} ${passed === results.length ? "PASS" : "FAIL"}`);
  if (passed !== results.length) process.exitCode = 1;
}
main().catch((e) => { console.error("cross-tenant probe failed:", (e as Error).message); process.exit(1); });
