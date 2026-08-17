/**
 * Datos demo reproducibles para ETNARA Care.
 * Uso: DATABASE_URL=... npx tsx scripts/seedDemo.ts
 * Contraseña de todos los usuarios demo: Demo1234!
 */
import { Client } from "pg";
import { hashPassword } from "../src/security/password.js";

const DEMO_PASSWORD = "Demo1234!";

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL ?? "postgres://app_test:test@localhost:5432/caretest" });
  await client.connect();
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  console.log("Creando organización demo...");
  const org = await client.query(
    `INSERT INTO organizations (name, organization_type, status) VALUES ('Cuidado en Casa Demo', 'HOME_CARE_AGENCY', 'active') RETURNING id`
  );
  const orgId = org.rows[0].id;

  async function createUser(email: string) {
    const u = await client.query(`INSERT INTO users (email, password_hash, status) VALUES ($1,$2,'active') RETURNING id`, [email, passwordHash]);
    return u.rows[0].id as string;
  }
  async function addMembership(userId: string, roleCode?: string) {
    const mem = await client.query(`INSERT INTO organization_memberships (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId]);
    if (roleCode) {
      await client.query(`INSERT INTO user_roles (organization_membership_id, organization_id, role_id) SELECT $1,$2,id FROM roles WHERE code=$3`, [
        mem.rows[0].id,
        orgId,
        roleCode,
      ]);
    }
    return mem.rows[0].id as string;
  }

  console.log("Creando usuarios demo...");
  const adminId = await createUser("admin@demo.etnara.care");
  await addMembership(adminId, "ORGANIZATION_ADMIN");
  const supervisorId = await createUser("supervisor@demo.etnara.care");
  await addMembership(supervisorId, "ORGANIZATION_ADMIN");
  const caregiver1Id = await createUser("maria@demo.etnara.care");
  await addMembership(caregiver1Id);
  const caregiver2Id = await createUser("carlos@demo.etnara.care");
  await addMembership(caregiver2Id);
  const familyId = await createUser("familia@demo.etnara.care");
  await addMembership(familyId, "FAMILY");

  console.log("Creando recipients...");
  const recipient1 = await client.query(
    `INSERT INTO care_recipients (organization_id, first_name, last_name, preferred_name) VALUES ($1,'Carmen','Rivera','Doña Carmen') RETURNING id`,
    [orgId]
  );
  await client.query(`INSERT INTO care_recipients (organization_id, first_name, last_name) VALUES ($1,'José','Méndez')`, [orgId]);
  const recipient1Id = recipient1.rows[0].id;

  console.log("Vinculando familiar autorizado...");
  await client.query(
    `INSERT INTO family_relationships (user_id, organization_id, care_recipient_id, relationship_type, status, can_view_photos)
     VALUES ($1,$2,$3,'daughter','active',true)`,
    [familyId, orgId, recipient1Id]
  );

  console.log("Creando perfiles de worker...");
  const worker1 = await client.query(`INSERT INTO workers (user_id, display_name) VALUES ($1,'María Rivera') RETURNING id`, [caregiver1Id]);
  const worker2 = await client.query(`INSERT INTO workers (user_id, display_name) VALUES ($1,'Carlos Soto') RETURNING id`, [caregiver2Id]);
  const membership1 = await client.query(
    `INSERT INTO organization_worker_memberships (worker_id, organization_id, status, internal_role) VALUES ($1,$2,'active','CNA') RETURNING id`,
    [worker1.rows[0].id, orgId]
  );
  await client.query(
    `INSERT INTO organization_worker_memberships (worker_id, organization_id, status, internal_role) VALUES ($1,$2,'active','HHA')`,
    [worker2.rows[0].id, orgId]
  );

  console.log("Habilitando tipos de evento...");
  const typeRows = await client.query(`SELECT id FROM care_event_types`);
  for (const t of typeRows.rows) {
    await client.query(`INSERT INTO organization_care_event_types (organization_id, care_event_type_id, is_enabled) VALUES ($1,$2,true)`, [orgId, t.id]);
  }

  console.log("Creando turno con check-in real...");
  const shift = await client.query(
    `INSERT INTO shifts (organization_id, care_recipient_id, scheduled_start, scheduled_end) VALUES ($1,$2, now() - interval '2 hours', now() + interval '2 hours') RETURNING id`,
    [orgId, recipient1Id]
  );
  await client.query(
    `INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, care_recipient_id) VALUES ($1,$2,$3,$4)`,
    [orgId, shift.rows[0].id, membership1.rows[0].id, recipient1Id]
  );
  const method = (await client.query(`SELECT id FROM verification_methods WHERE code='CAREGIVER_SESSION'`)).rows[0].id;
  await client.query(
    `INSERT INTO verification_events (organization_id, shift_id, organization_worker_membership_id, verification_method_id, event_type, actor_user_id)
     VALUES ($1,$2,$3,$4,'check_in',$5)`,
    [orgId, shift.rows[0].id, membership1.rows[0].id, method, caregiver1Id]
  );

  console.log("Registrando actividad de cuidado...");
  const typesByCode = new Map<string, string>();
  for (const row of (await client.query(`SELECT id, code FROM care_event_types`)).rows) typesByCode.set(row.code, row.id);
  await client.query(
    `INSERT INTO care_events (organization_id, shift_id, care_recipient_id, organization_worker_membership_id, care_event_type_id, structured_data)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [orgId, shift.rows[0].id, recipient1Id, membership1.rows[0].id, typesByCode.get("MEAL"), JSON.stringify({ mealType: "Almuerzo", amountConsumed: "Casi todo" })]
  );
  await client.query(
    `INSERT INTO care_events (organization_id, shift_id, care_recipient_id, organization_worker_membership_id, care_event_type_id, structured_data)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [orgId, shift.rows[0].id, recipient1Id, membership1.rows[0].id, typesByCode.get("HYDRATION"), JSON.stringify({ amount: "Vaso completo" })]
  );
  await client.query(
    `INSERT INTO care_events (organization_id, shift_id, care_recipient_id, organization_worker_membership_id, care_event_type_id, note_text)
     VALUES ($1,$2,$3,$4,$5,'Doña Carmen estuvo de buen ánimo esta tarde, conversó bastante.')`,
    [orgId, shift.rows[0].id, recipient1Id, membership1.rows[0].id, typesByCode.get("NOTE")]
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

  await client.end();

  console.log("\nListo. Usuarios demo (contraseña: " + DEMO_PASSWORD + "):");
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
