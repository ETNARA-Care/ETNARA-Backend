/**
 * Datos demo reproducibles para ETNARA Care.
 * Uso: DATABASE_URL=... npx tsx scripts/seedDemo.ts
 * Contraseña de todos los usuarios demo: Demo1234!
 *
 * Idempotente: cada paso busca primero si la fila ya existe (por su clave
 * natural) y solo la crea si falta. Esto permite volver a correr el script
 * despues de una corrida parcial (por ejemplo, una que fallo a mitad de
 * camino por una migracion pendiente) sin duplicar organizaciones/usuarios
 * ni borrar ningun dato ya creado.
 */
import { Client } from "pg";
import { hashPassword } from "../src/security/password.js";

const configuredDemoPassword = process.env.DEMO_PASSWORD;

if (!configuredDemoPassword) {
  throw new Error("DEMO_PASSWORD is required to seed demo users");
}

const DEMO_PASSWORD: string = configuredDemoPassword;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL ?? "******localhost:5432/caretest" });
  await client.connect();
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  console.log("Buscando/creando organización demo...");
  const orgId = await findOrCreateOrganization("Cuidado en Casa Demo");

  async function createUser(email: string): Promise<{ id: string; created: boolean }> {
    const existing = await client.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email]);
    if (existing.rows.length > 0) {
      return { id: existing.rows[0].id as string, created: false };
    }
    const u = await client.query(`INSERT INTO users (email, password_hash, status) VALUES ($1,$2,'active') RETURNING id`, [email, passwordHash]);
    return { id: u.rows[0].id as string, created: true };
  }

  async function addMembership(userId: string, roleCode?: string): Promise<string> {
    let membershipId: string;
    const existing = await client.query(
      `SELECT id FROM organization_memberships WHERE user_id = $1 AND organization_id = $2`,
      [userId, orgId]
    );
    if (existing.rows.length > 0) {
      membershipId = existing.rows[0].id as string;
    } else {
      const mem = await client.query(
        `INSERT INTO organization_memberships (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userId, orgId]
      );
      membershipId = mem.rows[0].id as string;
    }

    if (roleCode) {
      const existingRole = await client.query(
        `SELECT ur.id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.organization_membership_id = $1 AND r.code = $2`,
        [membershipId, roleCode]
      );
      if (existingRole.rows.length === 0) {
        await client.query(
          `INSERT INTO user_roles (organization_membership_id, organization_id, role_id) SELECT $1,$2,id FROM roles WHERE code=$3`,
          [membershipId, orgId, roleCode]
        );
      }
    }
    return membershipId;
  }

  async function findOrCreateOrganization(name: string): Promise<string> {
    const existing = await client.query(`SELECT id FROM organizations WHERE name = $1`, [name]);
    if (existing.rows.length > 0) return existing.rows[0].id as string;
    const org = await client.query(
      `INSERT INTO organizations (name, organization_type, status) VALUES ($1, 'HOME_CARE_AGENCY', 'active') RETURNING id`,
      [name]
    );
    return org.rows[0].id as string;
  }

  async function findOrCreateCareRecipient(firstName: string, lastName: string, preferredName?: string): Promise<string> {
    const existing = await client.query(
      `SELECT id FROM care_recipients WHERE organization_id = $1 AND first_name = $2 AND last_name = $3`,
      [orgId, firstName, lastName]
    );
    if (existing.rows.length > 0) return existing.rows[0].id as string;
    const recipient = await client.query(
      `INSERT INTO care_recipients (organization_id, first_name, last_name, preferred_name) VALUES ($1,$2,$3,$4) RETURNING id`,
      [orgId, firstName, lastName, preferredName ?? null]
    );
    return recipient.rows[0].id as string;
  }

  async function findOrCreateFamilyRelationship(userId: string, careRecipientId: string, relationshipType: string): Promise<void> {
    const existing = await client.query(
      `SELECT id FROM family_relationships WHERE user_id = $1 AND care_recipient_id = $2`,
      [userId, careRecipientId]
    );
    if (existing.rows.length > 0) return;
    await client.query(
      `INSERT INTO family_relationships (user_id, organization_id, care_recipient_id, relationship_type, status, can_view_photos)
       VALUES ($1,$2,$3,$4,'active',true)`,
      [userId, orgId, careRecipientId, relationshipType]
    );
  }

  async function findOrCreateWorker(userId: string, displayName: string): Promise<string> {
    const existing = await client.query(`SELECT id FROM workers WHERE user_id = $1`, [userId]);
    if (existing.rows.length > 0) return existing.rows[0].id as string;
    const worker = await client.query(`INSERT INTO workers (user_id, display_name) VALUES ($1,$2) RETURNING id`, [userId, displayName]);
    return worker.rows[0].id as string;
  }

  async function findOrCreateWorkerMembership(workerId: string, internalRole: string): Promise<string> {
    const existing = await client.query(
      `SELECT id FROM organization_worker_memberships WHERE worker_id = $1 AND organization_id = $2`,
      [workerId, orgId]
    );
    if (existing.rows.length > 0) return existing.rows[0].id as string;
    const membership = await client.query(
      `INSERT INTO organization_worker_memberships (worker_id, organization_id, status, internal_role) VALUES ($1,$2,'active',$3) RETURNING id`,
      [workerId, orgId, internalRole]
    );
    return membership.rows[0].id as string;
  }

  console.log("Creando usuarios demo faltantes...");
  const admin = await createUser("admin@demo.etnara.care");
  await addMembership(admin.id, "ORGANIZATION_ADMIN");
  const supervisor = await createUser("supervisor@demo.etnara.care");
  await addMembership(supervisor.id, "ORGANIZATION_ADMIN");
  const caregiver1 = await createUser("maria@demo.etnara.care");
  await addMembership(caregiver1.id, "WORKER");
  const caregiver2 = await createUser("carlos@demo.etnara.care");
  await addMembership(caregiver2.id, "WORKER");
  const family = await createUser("familia@demo.etnara.care");
  await addMembership(family.id, "FAMILY");
  const adminId = admin.id;
  const caregiver1Id = caregiver1.id;
  const caregiver2Id = caregiver2.id;
  const familyId = family.id;
  for (const [label, u] of [
    ["Admin", admin],
    ["Supervisor", supervisor],
    ["Cuidadora", caregiver1],
    ["Cuidador", caregiver2],
    ["Familiar", family],
  ] as const) {
    console.log(`  ${u.created ? "creado" : "ya existía"}: ${label}`);
  }

  console.log("Buscando/creando recipients...");
  const recipient1Id = await findOrCreateCareRecipient("Carmen", "Rivera", "Doña Carmen");
  await findOrCreateCareRecipient("José", "Méndez");

  console.log("Vinculando familiar autorizado...");
  await findOrCreateFamilyRelationship(familyId, recipient1Id, "daughter");

  console.log("Buscando/creando perfiles de worker...");
  const worker1Id = await findOrCreateWorker(caregiver1Id, "María Rivera");
  const worker2Id = await findOrCreateWorker(caregiver2Id, "Carlos Soto");
  const membership1Id = await findOrCreateWorkerMembership(worker1Id, "CNA");
  await findOrCreateWorkerMembership(worker2Id, "HHA");

  console.log("Habilitando tipos de evento...");
  const typeRows = await client.query(`SELECT id FROM care_event_types`);
  for (const t of typeRows.rows) {
    await client.query(
      `INSERT INTO organization_care_event_types (organization_id, care_event_type_id, is_enabled) VALUES ($1,$2,true)
       ON CONFLICT (organization_id, care_event_type_id) DO NOTHING`,
      [orgId, t.id]
    );
  }

  console.log("Verificando actividad demo (turno, eventos de cuidado, mensajería)...");
  const existingShift = await client.query(`SELECT id FROM shifts WHERE care_recipient_id = $1 LIMIT 1`, [recipient1Id]);
  if (existingShift.rows.length > 0) {
    console.log("  Actividad demo ya existe -- se omite (no se duplica ni se borra nada).");
  } else {
    console.log("Creando turno con check-in real...");
    const shift = await client.query(
      `INSERT INTO shifts (organization_id, care_recipient_id, scheduled_start, scheduled_end) VALUES ($1,$2, now() - interval '2 hours', now() + interval '2 hours') RETURNING id`,
      [orgId, recipient1Id]
    );
    await client.query(
      `INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, care_recipient_id) VALUES ($1,$2,$3,$4)`,
      [orgId, shift.rows[0].id, membership1Id, recipient1Id]
    );
    const method = (await client.query(`SELECT id FROM verification_methods WHERE code='CAREGIVER_SESSION'`)).rows[0].id;
    await client.query(
      `INSERT INTO verification_events (organization_id, shift_id, organization_worker_membership_id, verification_method_id, event_type, actor_user_id)
       VALUES ($1,$2,$3,$4,'check_in',$5)`,
      [orgId, shift.rows[0].id, membership1Id, method, caregiver1Id]
    );

    console.log("Registrando actividad de cuidado...");
    const typesByCode = new Map<string, string>();
    for (const row of (await client.query(`SELECT id, code FROM care_event_types`)).rows) typesByCode.set(row.code, row.id);
    await client.query(
      `INSERT INTO care_events (organization_id, shift_id, care_recipient_id, organization_worker_membership_id, care_event_type_id, structured_data)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [orgId, shift.rows[0].id, recipient1Id, membership1Id, typesByCode.get("MEAL"), JSON.stringify({ mealType: "Almuerzo", amountConsumed: "Casi todo" })]
    );
    await client.query(
      `INSERT INTO care_events (organization_id, shift_id, care_recipient_id, organization_worker_membership_id, care_event_type_id, structured_data)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [orgId, shift.rows[0].id, recipient1Id, membership1Id, typesByCode.get("HYDRATION"), JSON.stringify({ amount: "Vaso completo" })]
    );
    await client.query(
      `INSERT INTO care_events (organization_id, shift_id, care_recipient_id, organization_worker_membership_id, care_event_type_id, note_text)
       VALUES ($1,$2,$3,$4,$5,'Doña Carmen estuvo de buen ánimo esta tarde, conversó bastante.')`,
      [orgId, shift.rows[0].id, recipient1Id, membership1Id, typesByCode.get("NOTE")]
    );

    console.log("Creando conversación y mensaje inicial...");
    const thread = await client.query(
      `INSERT INTO message_threads (organization_id, care_recipient_id, thread_type) VALUES ($1,$2,'family_agency') RETURNING id`,
      [orgId, recipient1Id]
    );
    await client.query(`INSERT INTO message_thread_participants (organization_id, message_thread_id, user_id, can_write) VALUES ($1,$2,$3,true)`, [
      orgId,
      thread.rows[0].id,
      familyId,
    ]);
    await client.query(`INSERT INTO message_thread_participants (organization_id, message_thread_id, user_id, can_write) VALUES ($1,$2,$3,true)`, [
      orgId,
      thread.rows[0].id,
      adminId,
    ]);
    await client.query(`INSERT INTO messages (organization_id, message_thread_id, sender_user_id, body) VALUES ($1,$2,$3,$4)`, [
      orgId,
      thread.rows[0].id,
      adminId,
      "¡Hola! Queríamos contarle que Doña Carmen tuvo una tarde tranquila y comió muy bien. Cualquier pregunta, aquí estamos.",
    ]);
    await client.query(
      `INSERT INTO notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, channel, status, sent_at)
       VALUES ($1,$2,'NEW_MESSAGE','message_thread',$3,'in_app','sent', now())`,
      [familyId, orgId, thread.rows[0].id]
    );
  }

  await client.end();

  console.log("\nListo. Usuarios demo creados con la contraseña configurada en DEMO_PASSWORD:");
  console.log("  Admin:       admin@demo.etnara.care");
  console.log("  Supervisor:  supervisor@demo.etnara.care");
  console.log("  Cuidadora:   maria@demo.etnara.care");
  console.log("  Cuidador:    carlos@demo.etnara.care");
  console.log("  Familiar:    familia@demo.etnara.care");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
