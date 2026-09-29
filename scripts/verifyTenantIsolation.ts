import pg from "pg";

const { Client } = pg;
const connectionString = process.env.MIGRATIONS_DATABASE_URL;
if (!connectionString) throw new Error("MIGRATIONS_DATABASE_URL is required");

const client = new Client({ connectionString });
const q = (text: string, params: unknown[] = []) => client.query(text, params);

async function main() {
  await client.connect();
  try {
    const orgs = await q(`SELECT id FROM organizations ORDER BY created_at NULLS LAST, id LIMIT 2`);
    if (orgs.rowCount !== 2) throw new Error("E.4 requires at least two seeded organizations");
    const [orgA, orgB] = orgs.rows.map((r) => r.id as string);

    const membership = await q(
      `SELECT user_id FROM organization_memberships WHERE organization_id = $1 AND status = 'active' LIMIT 1`,
      [orgA],
    );
    if (!membership.rowCount) throw new Error("E.4 requires an active user in organization A");
    const userA = membership.rows[0].user_id as string;

    await q("BEGIN");
    await q("SET LOCAL ROLE app_runtime");
    await q("SELECT set_config('app.current_user_id', $1, true)", [userA]);
    await q("SELECT set_config('app.current_org_id', $1, true)", [orgA]);
    await q("SELECT set_config('app.is_superadmin', 'false', true)");

    const checks: Array<[string, string]> = [
      ["residents", "SELECT 1 FROM care_recipients WHERE organization_id = $1 LIMIT 1"],
      ["worker memberships", "SELECT 1 FROM organization_worker_memberships WHERE organization_id = $1 LIMIT 1"],
      ["compliance reviews", "SELECT 1 FROM organization_credential_reviews WHERE organization_id = $1 LIMIT 1"],
      ["shifts", "SELECT 1 FROM shifts WHERE organization_id = $1 LIMIT 1"],
      ["assignments", "SELECT 1 FROM assignments WHERE organization_id = $1 LIMIT 1"],
    ];

    for (const [name, sql] of checks) {
      const result = await q(sql, [orgB]);
      if ((result.rowCount ?? 0) !== 0) throw new Error(`TENANT ISOLATION FAILURE: organization A can read B ${name}`);
    }

    const mutation = await q(
      `UPDATE shifts SET updated_at = updated_at WHERE organization_id = $1 RETURNING id`,
      [orgB],
    );
    if ((mutation.rowCount ?? 0) !== 0) throw new Error("TENANT ISOLATION FAILURE: organization A can mutate B shifts");

    await q("ROLLBACK");
    console.log("E.4 tenant isolation verification passed");
  } catch (error) {
    try { await q("ROLLBACK"); } catch {}
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
