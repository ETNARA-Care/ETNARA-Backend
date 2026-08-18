/**
 * Crea datos mínimos demo para probar el área de cuidador (María y Doña Carmen).
 *
 * Reglas estrictas:
 * - Usa MIGRATIONS_DATABASE_URL (conexión administrativa)
 * - No crea verification_events, check_in/out, care_events, mensajes extra, ni ejecuta seedDemo/bootstrapStaging
 * - Idempotente: reutiliza registros existentes cuando corresponde
 * - Usa una transacción para evitar escrituras parciales
 *
 * Uso (NO ejecutar desde aquí):
 *   MIGRATIONS_DATABASE_URL=... npx tsx scripts/createMinimalCaregiverDemo.ts
 */
import { Client } from "pg";
import { hashPassword } from "../src/security/password.js";

const DEMO_PASSWORD = "Demo1234!"; // compatible con el seed real

async function main(): Promise<void> {
  const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
  if (!adminUrl) throw new Error("MIGRATIONS_DATABASE_URL is required for createMinimalCaregiverDemo.");

  const client = new Client({ connectionString: adminUrl });
  await client.connect();

  // Will perform checks and writes inside a transaction to avoid partial state.
  await client.query("BEGIN");
  try {
    // 1) Organization
    const orgRes = await client.query(`SELECT id FROM organizations WHERE name = $1 LIMIT 1`, ["Cuidado en Casa Demo"]);
    let orgId: string;
    if (orgRes.rows.length > 0) {
      orgId = orgRes.rows[0].id;
      // reuse
    } else {
      const ins = await client.query(
        `INSERT INTO organizations (name, organization_type, status) VALUES ($1, $2, 'active') RETURNING id`,
        ["Cuidado en Casa Demo", "HOME_CARE_AGENCY"]
      );
      orgId = ins.rows[0].id;
    }

    // 2) User Maria
    const userRes = await client.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, ["maria@demo.etnara.care"]);
    let mariaUserId: string;
    if (userRes.rows.length > 0) {
      mariaUserId = userRes.rows[0].id;
    } else {
      const pwdHash = await hashPassword(DEMO_PASSWORD);
      const u = await client.query(
        `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id`,
        ["maria@demo.etnara.care", pwdHash]
      );
      mariaUserId = u.rows[0].id;
    }

    // 3) Organization membership for Maria
    const memRes = await client.query(
      `SELECT id FROM organization_memberships WHERE user_id = $1 AND organization_id = $2 LIMIT 1`,
      [mariaUserId, orgId]
    );
    let membershipId: string;
    if (memRes.rows.length > 0) {
      membershipId = memRes.rows[0].id;
    } else {
      const m = await client.query(
        `INSERT INTO organization_memberships (user_id, organization_id, status) VALUES ($1, $2, 'active') RETURNING id`,
        [mariaUserId, orgId]
      );
      membershipId = m.rows[0].id;
    }

    // 4) Care recipient Carmen
    const recipientRes = await client.query(
      `SELECT id FROM care_recipients WHERE organization_id = $1 AND first_name = $2 AND last_name = $3 LIMIT 1`,
      [orgId, "Carmen", "Rivera"]
    );
    let recipientId: string;
    if (recipientRes.rows.length > 0) {
      recipientId = recipientRes.rows[0].id;
    } else {
      const r = await client.query(
        `INSERT INTO care_recipients (organization_id, first_name, last_name, preferred_name) VALUES ($1,$2,$3,$4) RETURNING id`,
        [orgId, "Carmen", "Rivera", "Doña Carmen"]
      );
      recipientId = r.rows[0].id;
    }

    // 5) Worker profile for Maria
    const workerRes = await client.query(`SELECT id FROM workers WHERE user_id = $1 LIMIT 1`, [mariaUserId]);
    let workerId: string;
    if (workerRes.rows.length > 0) {
      workerId = workerRes.rows[0].id;
    } else {
      const w = await client.query(`INSERT INTO workers (user_id, display_name) VALUES ($1,$2) RETURNING id`, [mariaUserId, "María Rivera"]);
      workerId = w.rows[0].id;
    }

    // 6) organization_worker_memberships
    const owmRes = await client.query(
      `SELECT id FROM organization_worker_memberships WHERE worker_id = $1 AND organization_id = $2 LIMIT 1`,
      [workerId, orgId]
    );
    let owmId: string;
    if (owmRes.rows.length > 0) {
      owmId = owmRes.rows[0].id;
      // ensure desired status/internal_role if allowed -- but do not change existing data
    } else {
      const ow = await client.query(
        `INSERT INTO organization_worker_memberships (worker_id, organization_id, status, internal_role) VALUES ($1,$2,'active','CNA') RETURNING id`,
        [workerId, orgId]
      );
      owmId = ow.rows[0].id;
    }

    // 7) Shift: check for an existing active shift assigned to this worker and recipient
    // Active = scheduled_start <= now() AND scheduled_end >= now()
    const existingShift = await client.query(
      `SELECT s.id AS shift_id
       FROM shifts s
       JOIN assignments a ON a.shift_id = s.id
       WHERE s.organization_id = $1
         AND s.care_recipient_id = $2
         AND a.organization_worker_membership_id = $3
         AND s.scheduled_start <= now()
         AND s.scheduled_end >= now()
       LIMIT 1`,
      [orgId, recipientId, owmId]
    );

    let shiftId: string;
    if (existingShift.rows.length > 0) {
      shiftId = existingShift.rows[0].shift_id;
      // do not create another
      console.log(`Found existing active shift: ${shiftId}`);
    } else {
      // create a new shift scheduled from now()-15min to now()+4h
      const s = await client.query(
        `INSERT INTO shifts (organization_id, care_recipient_id, scheduled_start, scheduled_end) VALUES ($1,$2, now() - interval '15 minutes', now() + interval '4 hours') RETURNING id`,
        [orgId, recipientId]
      );
      shiftId = s.rows[0].id;

      // create assignment
      await client.query(
        `INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, care_recipient_id) VALUES ($1,$2,$3,$4)`,
        [orgId, shiftId, owmId, recipientId]
      );
    }

    await client.query("COMMIT");

    console.log("Minimal caregiver demo created (or reused existing records).");
    console.log(`Organization id: ${orgId}`);
    console.log(`Maria user id: ${mariaUserId}`);
    console.log(`Care recipient id: ${recipientId}`);
    console.log(`Worker membership id: ${owmId}`);
    console.log(`Shift id: ${shiftId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    await client.end();
    throw err;
  }

  await client.end();
}

main().catch((err) => {
  console.error("createMinimalCaregiverDemo failed:", err);
  process.exit(1);
});
