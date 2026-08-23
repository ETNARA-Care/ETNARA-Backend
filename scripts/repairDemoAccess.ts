import { Client } from "pg";
import { hashPassword, verifyPassword } from "../src/security/password.js";

const DEMO_PASSWORD = "Demo1234!";

function fail(message: string): never {
  throw new Error(`ABORTADO: ${message}`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL no está definida.");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    // 1. Localizar organización demo usando a María como ancla.
    const orgRows = await client.query(
      `SELECT DISTINCT om.organization_id
       FROM users u
       JOIN organization_memberships om ON om.user_id = u.id
       WHERE lower(u.email) = 'maria@demo.etnara.care'
         AND om.status = 'active'`
    );

    if (orgRows.rows.length === 0) {
      fail("María no tiene ninguna organization_membership activa.");
    }

    if (orgRows.rows.length > 1) {
      fail(
        `María tiene membership activa en ${orgRows.rows.length} organizaciones; estado ambiguo.`
      );
    }

    const orgId: string = orgRows.rows[0].organization_id;
    console.log(`Organización demo localizada: ${orgId}`);

    // 2. Verificar María. SOLO LECTURA.
    console.log("\nVerificando maria@demo.etnara.care...");

    const mariaUser = await client.query(
      `SELECT id, status, password_hash
       FROM users
       WHERE lower(email) = 'maria@demo.etnara.care'`
    );

    if (mariaUser.rows.length !== 1) {
      fail("No se encontró exactamente una cuenta de María.");
    }

    const maria = mariaUser.rows[0];

    if (maria.status !== "active") {
      fail(`María tiene status='${maria.status}', se esperaba 'active'.`);
    }

    if (
      !maria.password_hash ||
      !(await verifyPassword(DEMO_PASSWORD, maria.password_hash))
    ) {
      fail("El password de María no verifica contra Demo1234!.");
    }

    const mariaMembership = await client.query(
      `SELECT id
       FROM organization_memberships
       WHERE user_id = $1
         AND organization_id = $2
         AND status = 'active'`,
      [maria.id, orgId]
    );

    if (mariaMembership.rows.length !== 1) {
      fail("María no tiene exactamente una membership activa en la organización demo.");
    }

    const mariaRole = await client.query(
      `SELECT 1
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.organization_membership_id = $1
         AND r.code = 'WORKER'`,
      [mariaMembership.rows[0].id]
    );

    if (mariaRole.rows.length !== 1) {
      fail("María no tiene role WORKER.");
    }

    const mariaWorker = await client.query(
      `SELECT id FROM workers WHERE user_id = $1`,
      [maria.id]
    );

    if (mariaWorker.rows.length !== 1) {
      fail("No se encontró exactamente un worker vinculado a María.");
    }

    const mariaWorkerMembership = await client.query(
      `SELECT 1
       FROM organization_worker_memberships
       WHERE worker_id = $1
         AND organization_id = $2
         AND status = 'active'`,
      [mariaWorker.rows[0].id, orgId]
    );

    if (mariaWorkerMembership.rows.length !== 1) {
      fail("María no tiene organization_worker_membership activa.");
    }

    console.log("María: OK. Cero escrituras.");

    // 3. Reparar Admin + Familia dentro de una sola transacción.
    await client.query("BEGIN");

    async function ensureUserActiveWithPassword(
      email: string
    ): Promise<{
      id: string;
      created: boolean;
      passwordFixed: boolean;
      statusFixed: boolean;
    }> {
      const existing = await client.query(
        `SELECT id, password_hash, status
         FROM users
         WHERE lower(email) = lower($1)`,
        [email]
      );

      if (existing.rows.length === 0) {
        const hash = await hashPassword(DEMO_PASSWORD);

        const inserted = await client.query(
          `INSERT INTO users (email, password_hash, status)
           VALUES ($1, $2, 'active')
           RETURNING id`,
          [email, hash]
        );

        return {
          id: inserted.rows[0].id,
          created: true,
          passwordFixed: false,
          statusFixed: false,
        };
      }

      if (existing.rows.length > 1) {
        throw new Error(
          `Se encontraron ${existing.rows.length} usuarios para ${email}; estado ambiguo.`
        );
      }

      const row = existing.rows[0];

      const passwordOk =
        !!row.password_hash &&
        (await verifyPassword(DEMO_PASSWORD, row.password_hash));

      const statusOk = row.status === "active";

      if (passwordOk && statusOk) {
        return {
          id: row.id,
          created: false,
          passwordFixed: false,
          statusFixed: false,
        };
      }

      const sets: string[] = [];
      const params: unknown[] = [];

      if (!passwordOk) {
        params.push(await hashPassword(DEMO_PASSWORD));
        sets.push(`password_hash = $${params.length}`);
      }

      if (!statusOk) {
        sets.push(`status = 'active'`);
      }

      params.push(row.id);

      await client.query(
        `UPDATE users
         SET ${sets.join(", ")}
         WHERE id = $${params.length}`,
        params
      );

      return {
        id: row.id,
        created: false,
        passwordFixed: !passwordOk,
        statusFixed: !statusOk,
      };
    }

    async function ensureActiveMembershipWithRole(
      userId: string,
      roleCode: string
    ): Promise<{
      membershipCreated: boolean;
      membershipReactivated: boolean;
      roleGranted: boolean;
    }> {
      const existingMembership = await client.query(
        `SELECT id, status
         FROM organization_memberships
         WHERE user_id = $1
           AND organization_id = $2`,
        [userId, orgId]
      );

      let membershipId: string;
      let membershipCreated = false;
      let membershipReactivated = false;

      if (existingMembership.rows.length === 0) {
        const inserted = await client.query(
          `INSERT INTO organization_memberships
             (user_id, organization_id, status)
           VALUES ($1, $2, 'active')
           RETURNING id`,
          [userId, orgId]
        );

        membershipId = inserted.rows[0].id;
        membershipCreated = true;
      } else if (existingMembership.rows.length > 1) {
        throw new Error(
          `Se encontraron ${existingMembership.rows.length} organization_memberships para user_id=${userId} y organization_id=${orgId}; estado ambiguo.`
        );
      } else {
        membershipId = existingMembership.rows[0].id;

        if (existingMembership.rows[0].status !== "active") {
          await client.query(
            `UPDATE organization_memberships
             SET status = 'active'
             WHERE id = $1`,
            [membershipId]
          );

          membershipReactivated = true;
        }
      }

      const roleRow = await client.query(
        `SELECT id FROM roles WHERE code = $1`,
        [roleCode]
      );

      if (roleRow.rows.length !== 1) {
        throw new Error(
          `Role code '${roleCode}' no existe de forma única en roles.`
        );
      }

      const roleId = roleRow.rows[0].id;

      const hasRole = await client.query(
        `SELECT 1
         FROM user_roles
         WHERE organization_membership_id = $1
           AND role_id = $2`,
        [membershipId, roleId]
      );

      let roleGranted = false;

      if (hasRole.rows.length === 0) {
        await client.query(
          `INSERT INTO user_roles
             (organization_membership_id, organization_id, role_id)
           VALUES ($1, $2, $3)`,
          [membershipId, orgId, roleId]
        );

        roleGranted = true;
      }

      return {
        membershipCreated,
        membershipReactivated,
        roleGranted,
      };
    }

    console.log("\nReparando admin@demo.etnara.care...");

    const adminUser =
      await ensureUserActiveWithPassword("admin@demo.etnara.care");

    const adminMembership = await ensureActiveMembershipWithRole(
      adminUser.id,
      "ORGANIZATION_ADMIN"
    );

    console.log(
      "Admin:",
      JSON.stringify({ ...adminUser, ...adminMembership })
    );

    console.log("\nReparando familia@demo.etnara.care...");

    const familyUser =
      await ensureUserActiveWithPassword("familia@demo.etnara.care");

    const familyMembership = await ensureActiveMembershipWithRole(
      familyUser.id,
      "FAMILY"
    );

    console.log(
      "Familia:",
      JSON.stringify({ ...familyUser, ...familyMembership })
    );

    // 4. Garantizar vínculo Familia ↔ Carmen Rivera.
    const carmenRows = await client.query(
      `SELECT id
       FROM care_recipients
       WHERE organization_id = $1
         AND first_name = 'Carmen'
         AND last_name = 'Rivera'`,
      [orgId]
    );

    if (carmenRows.rows.length !== 1) {
      throw new Error(
        `Se esperaba exactamente una Carmen Rivera en la organización demo; se encontraron ${carmenRows.rows.length}.`
      );
    }

    const carmenId = carmenRows.rows[0].id;

    const existingRelationship = await client.query(
      `SELECT id, status
       FROM family_relationships
       WHERE user_id = $1
         AND care_recipient_id = $2`,
      [familyUser.id, carmenId]
    );

    let relationshipAction = "sin_cambios";

    if (existingRelationship.rows.length === 0) {
      await client.query(
        `INSERT INTO family_relationships
           (
             user_id,
             organization_id,
             care_recipient_id,
             relationship_type,
             status,
             can_view_photos
           )
         VALUES ($1, $2, $3, 'daughter', 'active', true)`,
        [familyUser.id, orgId, carmenId]
      );

      relationshipAction = "creada";
    } else if (existingRelationship.rows.length > 1) {
      throw new Error(
        `Se encontraron ${existingRelationship.rows.length} relaciones Familia↔Carmen; estado ambiguo.`
      );
    } else if (existingRelationship.rows[0].status !== "active") {
      await client.query(
        `UPDATE family_relationships
         SET status = 'active',
             revoked_at = NULL
         WHERE id = $1`,
        [existingRelationship.rows[0].id]
      );

      relationshipAction = "reactivada";
    }

    console.log(
      `family_relationships (familia -> Carmen Rivera): ${relationshipAction}`
    );

    await client.query("COMMIT");

    console.log("\nCOMMIT exitoso. Reparación completa.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(
      "\nError durante la reparación. ROLLBACK aplicado cuando correspondía."
    );
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
