import pg from "pg";

// Read-only regression probe against a disposable migrated database.
// Requires a seeded active platform_admin and at least one care recipient.
// Do not run with production credentials.
const connectionString = process.env.MIGRATIONS_DATABASE_URL;
if (!connectionString) throw new Error("MIGRATIONS_DATABASE_URL is required");
if (process.env.NODE_ENV === "production") throw new Error("Refusing production test");

const client = new pg.Client({ connectionString });
const protectedTables = [
  "care_recipients", "care_plans", "care_events", "care_event_photos",
  "observations", "incidents", "incident_timeline_entries",
  "incident_attachments", "resident_documents", "family_relationships",
  "consent_records", "family_invitations", "message_threads",
  "message_thread_participants", "messages", "stored_files",
  "documents", "document_versions", "shifts", "assignments",
  "assignment_history", "verification_events", "verification_overrides",
] as const;

async function main() {
  await client.connect();
  try {
    const admin = await client.query(
      "SELECT user_id FROM platform_admins WHERE revoked_at IS NULL LIMIT 1"
    );
    if (!admin.rows[0]) throw new Error("Fixture missing: active platform_admin");
    const baseline = await client.query("SELECT count(*)::int AS n FROM care_recipients");
    if (baseline.rows[0].n === 0) throw new Error("Fixture missing: care recipient");

    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_runtime");
    await client.query("SELECT set_config('app.current_user_id',$1,true)", [admin.rows[0].user_id]);
    await client.query("SELECT set_config('app.current_org_id','',true)");
    await client.query("SELECT set_config('app.is_superadmin','true',true)");
    const check = await client.query("SELECT app_is_superadmin() AS authorized");
    if (!check.rows[0]?.authorized) throw new Error("Fixture invalid: superadmin not recognized");

    for (const table of protectedTables) {
      // Identifiers are hardcoded, never user input.
      const result = await client.query(`SELECT 1 FROM "${table}" LIMIT 1`);
      if (result.rowCount !== 0) throw new Error(`PHI exposure: ${table}`);
    }
    console.log("Platform PHI deny: all protected tables invisible to platform session");
  } finally {
    try { await client.query("ROLLBACK"); } finally { await client.end(); }
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
