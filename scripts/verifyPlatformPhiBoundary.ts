import pg from "pg";

// CI-only, disposable PostgreSQL. Never point at production.
const url = process.env.MIGRATIONS_DATABASE_URL;
if (!url || process.env.ETNARA_DISPOSABLE_DB !== "true") {
  throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
}
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");

const tables = [
  "care_recipients", "care_plans", "care_events", "care_event_photos",
  "observations", "incidents", "incident_timeline_entries",
  "incident_attachments", "resident_documents", "family_relationships",
  "consent_records", "family_invitations", "message_threads",
  "message_thread_participants", "messages", "stored_files",
  "documents", "document_versions", "shifts", "assignments",
  "assignment_history", "verification_events", "verification_overrides",
] as const;

const client = new pg.Client({ connectionString: url });
async function main() {
  await client.connect();
  try {
    // Fixtures are inserted as migration owner and discarded by ROLLBACK.
    await client.query("BEGIN");
    const user = await client.query(
      "INSERT INTO users (email, status) VALUES ('phi-boundary-ci@example.invalid','active') RETURNING id"
    );
    const userId = user.rows[0].id as string;
    await client.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [userId]);
    const org = await client.query(
      "INSERT INTO organizations (name, organization_type, status) VALUES ('PHI Boundary CI','HOME_CARE_AGENCY','active') RETURNING id"
    );
    const resident = await client.query(
      "INSERT INTO care_recipients (organization_id, first_name, last_name) VALUES ($1,'Synthetic','Patient') RETURNING id",
      [org.rows[0].id]
    );

    // Prove the synthetic target exists before testing its invisibility.
    // Otherwise an empty table could make a broken policy appear safe.
    const seeded = await client.query(
      "SELECT id FROM care_recipients WHERE id=$1",
      [resident.rows[0].id]
    );
    if (seeded.rowCount !== 1) {
      throw new Error("Synthetic resident fixture not visible to migration owner");
    }

    const policies = await client.query(
      "SELECT tablename, roles, cmd, qual FROM pg_policies WHERE schemaname='public' AND policyname='platform_phi_deny' AND permissive='RESTRICTIVE'"
    );
    const covered = new Set(policies.rows.map((r: { tablename: string }) => r.tablename));
    for (const table of tables) {
      if (!covered.has(table)) throw new Error("Missing restrictive policy: " + table);
      const policy = policies.rows.find((row: { tablename: string }) => row.tablename === table);
      if (!policy || !["ALL", "SELECT"].includes(policy.cmd)) {
        throw new Error("PHI read-deny policy does not cover SELECT: " + table);
      }
      // pg_policies.roles is a PostgreSQL name[]; pg drivers may return
      // it as an array or as its text representation ({app_runtime}).
      const policyRoles = Array.isArray(policy.roles)
        ? policy.roles.map(String)
        : String(policy.roles ?? "").replace(/[{}"]/g, "").split(",");
      if (!policyRoles.some((role: string) => role.trim() === "public" || role.trim() === "app_runtime")) {
        throw new Error("PHI deny policy does not apply to app_runtime: " + table);
      }
      if (!policy.qual || typeof policy.qual !== "string" ||
          !/NOT\s+app_is_superadmin\s*\(\s*\)/i.test(policy.qual)) {
        throw new Error("PHI deny policy must reject verified platform admins: " + table);
      }
    }

    await client.query("SAVEPOINT before_runtime");
    await client.query("SET LOCAL ROLE app_runtime");
    await client.query("SELECT set_config('app.current_user_id',$1,true)", [userId]);
    await client.query("SELECT set_config('app.current_org_id','',true)");
    await client.query("SELECT set_config('app.is_superadmin','true',true)");
    const role = await client.query(
      "SELECT current_user AS role, row_security_active('care_recipients'::regclass) AS active, app_is_superadmin() AS admin"
    );
    if (role.rows[0].role !== "app_runtime" || !role.rows[0].active || !role.rows[0].admin) {
      throw new Error("RLS or platform admin fixture not active");
    }
    const runtimeRole = await client.query(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user"
    );
    if (runtimeRole.rows[0]?.rolbypassrls || runtimeRole.rows[0]?.rolsuper) {
      throw new Error("Runtime role bypasses RLS; negative probe is invalid");
    }
    for (const table of tables) {
      const status = await client.query(
        "SELECT row_security_active($1::regclass) AS active",
        [table]
      );
      if (!status.rows[0]?.active) throw new Error("RLS inactive for " + table);
    }
    for (const table of tables) {
      const result = await client.query('SELECT 1 FROM "' + table + '" LIMIT 1');
      if ((result.rowCount ?? 0) !== 0) throw new Error("Platform PHI exposure: " + table);
    }
    const direct = await client.query("SELECT id FROM care_recipients WHERE id=$1", [resident.rows[0].id]);
    if (direct.rowCount !== 0) throw new Error("Platform admin accessed seeded resident");
    // Positive control: the same protected record remains available to an
    // ordinary active member of its own organization. This prevents a
    // blanket deny policy from passing the negative tests while breaking
    // legitimate agency workflows.
    await client.query("RESET ROLE");
    const agencyUser = await client.query(
      "INSERT INTO users (email, status) VALUES ('phi-agency-ci@example.invalid','active') RETURNING id"
    );
    const agencyUserId = agencyUser.rows[0].id as string;
    await client.query(
      "INSERT INTO organization_memberships (user_id, organization_id, status) VALUES ($1,$2,'active')",
      [agencyUserId, org.rows[0].id]
    );
    await client.query("SET LOCAL ROLE app_runtime");
    await client.query("SELECT set_config('app.current_user_id',$1,true)", [agencyUserId]);
    await client.query("SELECT set_config('app.current_org_id',$1,true)", [org.rows[0].id]);
    await client.query("SELECT set_config('app.is_superadmin','false',true)");
    const agencyRead = await client.query(
      "SELECT id FROM care_recipients WHERE id=$1",
      [resident.rows[0].id]
    );
    if (agencyRead.rowCount !== 1) {
      throw new Error("Agency member lost access to its own synthetic resident");
    }
    // A second agency must not see the first agency's resident, even when
    // the caller switches its claimed organization context.
    await client.query("RESET ROLE");
    const otherOrg = await client.query(
      "INSERT INTO organizations (name, organization_type, status) VALUES ('PHI Boundary Other Agency','HOME_CARE_AGENCY','active') RETURNING id"
    );
    const otherUser = await client.query(
      "INSERT INTO users (email, status) VALUES ('phi-other-agency-ci@example.invalid','active') RETURNING id"
    );
    await client.query(
      "INSERT INTO organization_memberships (user_id, organization_id, status) VALUES ($1,$2,'active')",
      [otherUser.rows[0].id, otherOrg.rows[0].id]
    );
    await client.query("SET LOCAL ROLE app_runtime");
    await client.query("SELECT set_config('app.current_user_id',$1,true)", [otherUser.rows[0].id]);
    await client.query("SELECT set_config('app.current_org_id',$1,true)", [otherOrg.rows[0].id]);
    await client.query("SELECT set_config('app.is_superadmin','false',true)");
    const crossTenant = await client.query(
      "SELECT id FROM care_recipients WHERE id=$1",
      [resident.rows[0].id]
    );
    if (crossTenant.rowCount !== 0) {
      throw new Error("Cross-tenant PHI exposure: another agency accessed the resident");
    }
    await client.query("SELECT set_config('app.current_org_id',$1,true)", [org.rows[0].id]);
    const forgedTenant = await client.query(
      "SELECT id FROM care_recipients WHERE id=$1",
      [resident.rows[0].id]
    );
    if (forgedTenant.rowCount !== 0) {
      throw new Error("Cross-tenant PHI exposure: forged organization context bypassed membership");
    }
    console.log("PASS: platform denied; agency allowed; other agency and forged context denied");
  } finally {
    try { await client.query("ROLLBACK"); } finally { await client.end(); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
