/**
 * Reparación segura y específica de acceso para las cuentas demo de ETNARA.
 * Uso: DATABASE_URL=... npx tsx scripts/repairDemoAccess.ts
 *
 * NO es un re-seed. NO crea otra organización. NO toca datos operacionales
 * (shifts, care_events, messages, etc.). Es idempotente: correrlo dos veces
 * seguidas produce cero escrituras en la segunda corrida si la primera
 * tuvo éxito.
 *
 * Alcance exacto:
 *   - admin@demo.etnara.care  -> activo, password Demo1234!, ORGANIZATION_ADMIN
 *   - familia@demo.etnara.care -> activo, password Demo1234!, FAMILY,
 *     family_relationships activa con Carmen Rivera
 *   - maria@demo.etnara.care  -> SOLO VERIFICACIÓN. Cero INSERT/UPDATE.
 *     Si algo no está como se espera, el script aborta y reporta -- nunca
 *     intenta "arreglarla", para no arriesgar una cuenta que ya funciona.
 *
 * La organización demo se localiza anclando en la membership activa de
 * María (la única cuenta ya confirmada funcionando end-to-end), no por
 * nombre -- `organizations.name` no es único, así que buscar por nombre
 * podría encontrar más de una fila si el seed llegó a correr más de una
 * vez. Si esa búsqueda no da exactamente una organización, el script se
 * detiene sin escribir nada.
 */
import { Client } from "pg";
import { hashPassword, verifyPassword } from "../src/security/password.js";

const DEMO_PASSWORD = "Demo1234!";

function fail(message: string): never {
  throw new Error(`ABORTADO: ${message}`);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL no está definida.");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    // ============================================================
    // 1. Localizar la organización demo de forma segura (anclado en María)
    // ============================================================
    const orgRows = await client.query(
      `SELECT DISTINCT om.organization_id
       FROM users u
       JOIN organization_memberships om ON om.user_id = u.id
       WHERE lower(u.email) = 'maria@demo.etnara.care' AND om.status = 'active'`
    );
    if (orgRows.rows.length === 0) {
      fail("maria@demo.etnara.care no tiene ninguna organization_membership activa. No se puede localizar la organización demo con seguridad -- no se escribió nada.");
    }
    if (orgRows.rows.length > 1) {
      fail(
        `maria@demo.etnara.care tiene membership activa en ${orgRows.rows.length} organizaciones distintas (${orgRows.rows
          .map((r) => r.organization_id)
          .join(", ")}). No se puede determinar cuál es la organización demo -- no se escribió nada.`
      );
    }
    const orgId: string = orgRows.rows[0].organization_id;
    console.log(`Organización demo localizada: ${orgId}`);

    // ============================================================
    // 2. Verificar a María -- SOLO LECTURA. Cero escrituras. Si algo
    //    falla, abortamos ANTES de tocar nada de admin/familia también,
    //    porque una María rota es señal de que algo más profundo está
    //    mal y no queremos escribir sobre un estado que no entendemos.
    // ============================================================
    console.log("\nVerificando maria@demo.etnara.care (solo lectura)...");
    const mariaUser = await client.query(
      `SELECT id, status, password_hash FROM users WHERE lower(email) = 'maria@demo.etnara.care'`
    );
    if (mariaUser.rows.length !== 1) fail("maria@demo.etnara.care no existe en users. No se toca nada.");
    const maria = mariaUser.rows[0];
    if (maria.status !== "active") fail(`maria@demo.etnara.care tiene status='${maria.status}', se esperaba 'active'. No se toca nada.`);
    if (!maria.password_hash || !(await verifyPassword(DEMO_PASSWORD, maria.password_hash))) {
      fail("El password_hash de maria@demo.etnara.care no verifica contra Demo1234!. No se toca nada -- repórtalo aparte.");
    }

    const mariaMembership = await client.query(
      `SELECT id FROM organization_memberships WHERE user_id = $1 AND organization_id = $2 AND status = 'active'`,
      [maria.id, orgId]
    );
    if (mariaMembership.rows.length !== 1) fail("maria@demo.etnara.care no tiene organization_membership activa en la organización demo. No se toca nada.");

    const mariaRole = await client.query(
      `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.organization_membership_id = $1 AND r.code = 'WORKER'`,
      [mariaMembership.rows[0].id]
    );
    if (mariaRole.rows.length !== 1) fail("maria@demo.etnara.care no tiene role WORKER en user_roles. No se toca nada.");

    const mariaWorker = await client.query(`SELECT id FROM workers WHERE user_id = $1`, [maria.id]);
    if (mariaWorker.rows.length !== 1) fail("No se encontró exactamente un worker con user_id = maria. No se toca nada.");

    const mariaWorkerMembership = await client.query(
      `SELECT 1 FROM organization_worker_memberships WHERE worker_id = $1 AND organization_id = $2 AND status = 'active'`,
      [mariaWorker.rows[0].id, orgId]
    );
    if (mariaWorkerMembership.rows.length !== 1) fail("María no tiene organization_worker_membership activa en la organización demo. No se toca nada.");

    console.log("María: OK en las 5 condiciones -- cero escrituras, como corresponde.");

    // ============================================================
    // 3. Reparar admin y familia -- todo dentro de una transacción
    // ============================================================
    await client.query("BEGIN");

    async function ensureUserActiveWithPassword(email: string): Promise<{ id: string; created: boolean; passwordFixed: boolean; statusFixed: boolean }> {
      const existing = await client.query(`SELECT id, password_hash, status FROM users WHERE lower(email) = lower($1)`, [email]);

      if (existing.rows.length === 0) {
        const hash = await hashPassword(DEMO_PASSWORD);
        const inserted = await client.query(
          `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id`,
          [email, hash]
        );
        return { id: inserted.rows[0].id, created: true, passwordFixed: false, statusFixed: false };
      }

      if (existing.rows.length > 1) {
        throw new Error(`Se encontraron ${existing.rows.length} usuarios para ${email}; estado ambiguo.`);
      }

      const row = existing.rows[0];
      const passwordOk = !!row.password_hash && (await verifyPassword(DEMO_PASSWORD, row.password_hash));
      const statusOk = row.status === "active";

      if (passwordOk && statusOk) {
        return { id: row.id, created: false, passwordFixed: false, statusFixed: false };
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
      await client.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
      return { id: row.id, created: false, passwordFixed: !passwordOk, statusFixed: !statusOk };
    }

    async function ensureActiveMembershipWithRole(userId: string, roleCode: string): Promise<{ membershipCreated: boolean; membershipReactivated: boolean; roleGranted: boolean }> {
      const existingMembership = await client.query(
        `SELECT id, status FROM organization_memberships WHERE user_id = $1 AND organization_id = $2`,
        [userId, orgId]
      );

      let membershipId: string;
      let membershipCreated = false;
      let membershipReactivated = false;

      if (existingMembership.rows.length === 0) {
        const inserted = await client.query(
          `INSERT INTO organization_memberships (user_id, organization_id, status) VALUES ($1, $2, 'active') RETURNING id`,
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
          await client.query(`UPDATE organization_memberships SET status = 'active' WHERE id = $1`, [membershipId]);
          membershipReactivated = true;
        }
      }

      const roleRow = await client.query(`SELECT id FROM roles WHERE code = $1`, [roleCode]);
      if (roleRow.rows.length !== 1) throw new Error(`Role code '${roleCode}' no existe en la tabla roles.`);
      const roleId = roleRow.rows[0].id;

      const hasRole = await client.query(
        `SELECT 1 FROM user_roles WHERE organization_membership_id = $1 AND role_id = $2`,
        [membershipId, roleId]
      );
      let roleGranted = false;
      if (hasRole.rows.length === 0) {
        await client.query(
          `INSERT INTO user_roles (organization_membership_id, organization_id, role_id) VALUES ($1, $2, $3)`,
          [membershipId, orgId, roleId]
        );
        roleGranted = true;
      }

      return { membershipCreated, membershipReactivated, roleGranted };
    }

    console.log("\nReparando admin@demo.etnara.care...");
    const adminUser = await ensureUserActiveWithPassword("admin@demo.etnara.care");
    const adminMembership = await ensureActiveMembershipWithRole(adminUser.id, "ORGANIZATION_ADMIN");
    console.log("  ", JSON.stringify({ ...adminUser, ...adminMembership }));

    console.log("\nReparando familia@demo.etnara.care...");
    const familyUser = await ensureUserActiveWithPassword("familia@demo.etnara.care");
    const familyMembership = await ensureActiveMembershipWithRole(familyUser.id, "FAMILY");
    console.log("  ", JSON.stringify({ ...familyUser, ...familyMembership }));

    // ------------------------------------------------------------
    // 4. Vincular a Familia con Carmen Rivera (family_relationships)
    // ------------------------------------------------------------
    const carmenRows = await client.query(
      `SELECT id FROM care_recipients WHERE organization_id = $1 AND first_name = 'Carmen' AND last_name = 'Rivera'`,
      [orgId]
    );
    if (carmenRows.rows.length !== 1) {
      throw new Error(`Se esperaba exactamente un care_recipient 'Carmen Rivera' en la organización demo, se encontraron ${carmenRows.rows.length}.`);
    }
    const carmenId = carmenRows.rows[0].id;

    const existingRelationship = await client.query(
      `SELECT id, status FROM family_relationships WHERE user_id = $1 AND care_recipient_id = $2`,
      [familyUser.id, carmenId]
    );

    let relationshipAction = "sin_cambios";
    if (existingRelationship.rows.length === 0) {
      await client.query(
        `INSERT INTO family_relationships (user_id, organization_id, care_recipient_id, relationship_type, status, can_view_photos)
         VALUES ($1, $2, $3, 'daughter', 'active', true)`,
        [familyUser.id, orgId, carmenId]
      );
      relationshipAction = "creada";
    } else if (existingRelationship.rows[0].status !== "active") {
      await client.query(
        `UPDATE family_relationships SET status = 'active', revoked_at = NULL WHERE id = $1`,
        [existingRelationship.rows[0].id]
      );
      relationshipAction = "reactivada";
    }
    console.log(`\nfamily_relationships (familia -> Carmen Rivera): ${relationshipAction}`);

    await client.query("COMMIT");
    console.log("\nCOMMIT exitoso. Reparación completa.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\nError durante la reparación -- ROLLBACK aplicado, ningún cambio quedó guardado.");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
