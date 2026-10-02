import { Client } from "pg";
import { hashPassword } from "../src/security/password.js";

const PLATFORM_ADMIN_EMAIL = (process.env.PLATFORM_ADMIN_EMAIL ?? "etnaracare@gmail.com").trim().toLowerCase();
const configuredPassword = process.env.PLATFORM_ADMIN_PASSWORD ?? process.env.DEMO_PASSWORD;

if (!configuredPassword) {
  throw new Error("PLATFORM_ADMIN_PASSWORD (or DEMO_PASSWORD for staging) is required");
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    const passwordHash = await hashPassword(configuredPassword);

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1`,
      [PLATFORM_ADMIN_EMAIL]
    );
    let platformUserId = existing.rows[0]?.id;
    if (!platformUserId) {
      const created = await client.query<{ id: string }>(
        `INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`,
        [PLATFORM_ADMIN_EMAIL,passwordHash]
      );
      platformUserId = created.rows[0].id;
    } else {
      await client.query(
        `UPDATE users SET password_hash=$2,status='active' WHERE id=$1`,
        [platformUserId,passwordHash]
      );
    }

    // Platform authority is intentionally independent from every tenant.
    await client.query(
      `INSERT INTO platform_admins (user_id,granted_by_user_id,revoked_at)
       VALUES ($1,$1,NULL)
       ON CONFLICT (user_id) DO UPDATE SET revoked_at=NULL`,
      [platformUserId]
    );

    // The dedicated platform identity must never inherit an organization membership.
    const membership = await client.query(
      `SELECT 1 FROM organization_memberships WHERE user_id=$1 LIMIT 1`,
      [platformUserId]
    );
    if (membership.rows.length > 0) {
      throw new Error(`Dedicated platform admin ${PLATFORM_ADMIN_EMAIL} unexpectedly has an organization membership`);
    }

    // Legacy demo admin remains the administrator of Cuidado en Casa Demo,
    // but no longer has ETNARA-wide platform authority.
    await client.query(
      `UPDATE platform_admins pa
       SET revoked_at=COALESCE(pa.revoked_at,now())
       FROM users u
       WHERE pa.user_id=u.id
         AND lower(u.email)=lower('admin@demo.etnara.care')
         AND pa.user_id<>$1`,
      [platformUserId]
    );

    await client.query("COMMIT");
    console.log(`ETNARA Plataforma desligada de Casa Demo: ${PLATFORM_ADMIN_EMAIL}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error=>{console.error("Platform admin decoupling failed:",error);process.exit(1);});
