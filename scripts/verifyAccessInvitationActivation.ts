import { randomBytes, createHash } from "node:crypto";
import { Client } from "pg";

async function main() {
  const connectionString = process.env.MIGRATIONS_DATABASE_URL;
  if (!connectionString) throw new Error("MIGRATIONS_DATABASE_URL is required.");

  const client = new Client({ connectionString });
  await client.connect();
  await client.query("BEGIN");
  try {
    const seed = await client.query<{ organization_id: string; invited_by_user_id: string }>(`
      SELECT om.organization_id, om.user_id AS invited_by_user_id
      FROM organization_memberships om
      JOIN user_roles ur ON ur.organization_membership_id = om.id
      JOIN roles r ON r.id = ur.role_id
      WHERE om.status = 'active' AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
      LIMIT 1
    `);
    if (!seed.rows[0]) throw new Error("No manager seed is available for the activation verification.");

    const worker = await client.query<{ membership_id: string; worker_id: string }>(`
      WITH new_worker AS (
        INSERT INTO workers (display_name) VALUES ('CI Invitation Worker') RETURNING id
      )
      INSERT INTO organization_worker_memberships (worker_id, organization_id, internal_role)
      SELECT id, $1, 'CI verification' FROM new_worker
      RETURNING id AS membership_id, worker_id
    `, [seed.rows[0].organization_id]);

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const email = `ci-invitation-${randomBytes(8).toString("hex")}@example.test`;
    await client.query(`
      INSERT INTO access_invitations (
        organization_id, invited_by_user_id, invitation_type, email,
        worker_membership_id, token_hash, expires_at
      ) VALUES ($1, $2, 'worker', $3, $4, $5, now() + interval '1 hour')
    `, [seed.rows[0].organization_id, seed.rows[0].invited_by_user_id, email, worker.rows[0].membership_id, tokenHash]);

    const activation = await client.query<{ user_id: string; organization_id: string; invitation_type: string }>(
      "SELECT * FROM app_activate_access_invitation($1, $2, NULL)",
      [tokenHash, "scrypt$N=16384,r=8,p=1$00112233445566778899aabbccddeeff$testhashfortheciinvitationactivationverification"]
    );
    if (activation.rows[0]?.organization_id !== seed.rows[0].organization_id || activation.rows[0]?.invitation_type !== "worker") {
      throw new Error("Activation returned the wrong organization or invitation type.");
    }

    const linked = await client.query<{ user_id: string | null }>(
      "SELECT user_id FROM workers WHERE id = $1",
      [worker.rows[0].worker_id]
    );
    if (!linked.rows[0]?.user_id || linked.rows[0].user_id !== activation.rows[0]?.user_id) {
      throw new Error("Activation did not link the worker to the new account.");
    }

    console.log("Worker invitation activation verified against PostgreSQL.");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

main().catch((error) => {
  console.error("Access invitation activation verification failed:", error);
  process.exit(1);
});
