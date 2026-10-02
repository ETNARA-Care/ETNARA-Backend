import { Client } from "pg";
import { hashPassword } from "../src/security/password.js";

const PLATFORM_EMAIL = "etnaracare@gmail.com";
const DEMO_ADMIN_EMAIL = "admin@demo.etnara.care";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const platformPassword = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!platformPassword) throw new Error("PLATFORM_ADMIN_PASSWORD is required");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");

    const demoAdmin = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1",
      [DEMO_ADMIN_EMAIL]
    );
    if (demoAdmin.rowCount !== 1) {
      throw new Error(`${DEMO_ADMIN_EMAIL} must exist before separating platform authority`);
    }

    const passwordHash = await hashPassword(platformPassword);
    const platformUser = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (email) DO UPDATE
         SET status = 'active'
       RETURNING id`,
      [PLATFORM_EMAIL, passwordHash]
    );
    const platformUserId = platformUser.rows[0].id;
    const demoAdminId = demoAdmin.rows[0].id;

    // Platform identity must never inherit a customer tenant membership.
    const platformMembership = await client.query(
      "SELECT id FROM organization_memberships WHERE user_id = $1",
      [platformUserId]
    );
    if ((platformMembership.rowCount ?? 0) > 0) {
      throw new Error(`${PLATFORM_EMAIL} already has organization membership; refusing unsafe automatic removal`);
    }

    await client.query(
      `INSERT INTO platform_admins (user_id, granted_by_user_id, revoked_at)
       VALUES ($1, $1, NULL)
       ON CONFLICT (user_id) DO UPDATE SET revoked_at = NULL`,
      [platformUserId]
    );

    // Revoke only platform authority from the demo organization admin.
    // Its organization membership, roles and all tenant data remain untouched.
    await client.query(
      `UPDATE platform_admins
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1`,
      [demoAdminId]
    );

    await client.query("COMMIT");
    console.log(`Separated identities: ${PLATFORM_EMAIL}=platform-only; ${DEMO_ADMIN_EMAIL}=organization-only`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
