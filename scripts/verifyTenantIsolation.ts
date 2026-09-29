import pg from "pg";

const { Client } = pg;
const connectionString = process.env.MIGRATIONS_DATABASE_URL;
if (!connectionString) throw new Error("MIGRATIONS_DATABASE_URL is required");
const client = new Client({ connectionString });
const q = (text: string, params: unknown[] = []) => client.query(text, params);

async function expectHidden(name: string, sql: string, params: unknown[]) {
  const result = await q(sql, params);
  if ((result.rowCount ?? 0) !== 0) throw new Error(`TENANT ISOLATION FAILURE: A can access B ${name}`);
}

async function main() {
  await client.connect();
  try {
    const orgAResult = await q(`SELECT id FROM organizations ORDER BY created_at, id LIMIT 1`);
    if (!orgAResult.rowCount) throw new Error("E.4 requires seeded organization A");
    const orgA = orgAResult.rows[0].id as string;
    const membership = await q(`SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND status='active' LIMIT 1`, [orgA]);
    if (!membership.rowCount) throw new Error("E.4 requires an active user in organization A");
    const userA = membership.rows[0].user_id as string;

    // Build an isolated Organization B fixture specifically for E.4. This is
    // intentionally not part of seedDemo/bootstrap and exists only in CI's
    // disposable PostgreSQL database.
    const orgB = (await q(`INSERT INTO organizations (name, organization_type, status) VALUES ('E4 Isolation Org B','HOME_CARE_AGENCY','active') RETURNING id`)).rows[0].id as string;
    const residentB = (await q(`INSERT INTO care_recipients (organization_id, first_name, last_name) VALUES ($1,'TenantB','Resident') RETURNING id, first_name`, [orgB])).rows[0];
    const workerB = (await q(`INSERT INTO workers DEFAULT VALUES RETURNING id`)).rows[0];
    const workerMembershipB = (await q(`INSERT INTO organization_worker_memberships (worker_id, organization_id, status, internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id, worker_id, status`, [workerB.id, orgB])).rows[0];
    const shiftB = (await q(`INSERT INTO shifts (organization_id, care_recipient_id, scheduled_start, scheduled_end, status) VALUES ($1,$2,now()+interval '1 day',now()+interval '1 day 8 hours','confirmed') RETURNING id,status`, [orgB, residentB.id])).rows[0];
    const assignmentB = (await q(`INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, care_recipient_id, role_in_shift) VALUES ($1,$2,$3,$4,'caregiver') RETURNING id`, [orgB, shiftB.id, workerMembershipB.id, residentB.id])).rows[0];
    const reviewB = (await q(`SELECT id, review_status FROM organization_credential_reviews WHERE organization_id=$1 LIMIT 1`, [orgB])).rows[0];

    await q("BEGIN");
    await q("SET LOCAL ROLE app_runtime");
    await q("SELECT set_config('app.current_user_id',$1,true)", [userA]);
    await q("SELECT set_config('app.current_org_id',$1,true)", [orgA]);
    await q("SELECT set_config('app.is_superadmin','false',true)");

    await expectHidden("personnel", `SELECT id FROM organization_worker_memberships WHERE organization_id=$1`, [orgB]);
    await expectHidden("residents", `SELECT id FROM care_recipients WHERE organization_id=$1`, [orgB]);
    await expectHidden("compliance reviews", `SELECT id FROM organization_credential_reviews WHERE organization_id=$1`, [orgB]);
    await expectHidden("shifts", `SELECT id FROM shifts WHERE organization_id=$1`, [orgB]);
    await expectHidden("assignments", `SELECT id FROM assignments WHERE organization_id=$1`, [orgB]);

    await expectHidden("resident by valid ID", `SELECT id FROM care_recipients WHERE id=$1`, [residentB.id]);
    await expectHidden("worker membership by valid ID", `SELECT id FROM organization_worker_memberships WHERE id=$1`, [workerMembershipB.id]);
    await expectHidden("shift by valid ID", `SELECT id FROM shifts WHERE id=$1`, [shiftB.id]);
    await expectHidden("assignment by valid ID", `SELECT id FROM assignments WHERE id=$1`, [assignmentB.id]);
    if (reviewB) await expectHidden("compliance review by valid ID", `SELECT id FROM organization_credential_reviews WHERE id=$1`, [reviewB.id]);

    await expectHidden("resident mutation", `UPDATE care_recipients SET first_name=first_name WHERE id=$1 RETURNING id`, [residentB.id]);
    await expectHidden("personnel mutation", `UPDATE organization_worker_memberships SET status=status WHERE id=$1 RETURNING id`, [workerMembershipB.id]);
    await expectHidden("shift mutation", `UPDATE shifts SET status=status WHERE id=$1 RETURNING id`, [shiftB.id]);
    if (reviewB) await expectHidden("compliance approval/review mutation", `UPDATE organization_credential_reviews SET review_status=review_status WHERE id=$1 RETURNING id`, [reviewB.id]);

    // assignments has no updated_at/status field in the base schema; a direct
    // delete is a stronger mutation attempt and remains rolled back either way.
    await expectHidden("assignment mutation", `DELETE FROM assignments WHERE id=$1 RETURNING id`, [assignmentB.id]);

    // Forging only organizationId/current org must not confer membership.
    await q("SELECT set_config('app.current_org_id',$1,true)", [orgB]);
    await expectHidden("resident after forged organizationId", `SELECT id FROM care_recipients WHERE id=$1`, [residentB.id]);
    await expectHidden("personnel after forged organizationId", `SELECT id FROM organization_worker_memberships WHERE id=$1`, [workerMembershipB.id]);
    await expectHidden("shift after forged organizationId", `SELECT id FROM shifts WHERE id=$1`, [shiftB.id]);
    await expectHidden("assignment after forged organizationId", `SELECT id FROM assignments WHERE id=$1`, [assignmentB.id]);

    await q("ROLLBACK");

    const residentAfter = (await q(`SELECT first_name FROM care_recipients WHERE id=$1`, [residentB.id])).rows[0];
    const workerAfter = (await q(`SELECT status FROM organization_worker_memberships WHERE id=$1`, [workerMembershipB.id])).rows[0];
    const shiftAfter = (await q(`SELECT status FROM shifts WHERE id=$1`, [shiftB.id])).rows[0];
    const assignmentAfter = (await q(`SELECT id FROM assignments WHERE id=$1`, [assignmentB.id])).rows[0];
    if (residentAfter?.first_name !== residentB.first_name || workerAfter?.status !== workerMembershipB.status || shiftAfter?.status !== shiftB.status || !assignmentAfter) {
      throw new Error("TENANT ISOLATION FAILURE: B resource changed after cross-tenant attack");
    }
    console.log("E.4 tenant isolation verification passed all six negative criteria");
  } catch (error) {
    try { await q("ROLLBACK"); } catch {}
    throw error;
  } finally { await client.end(); }
}

main().catch((error) => { console.error(error); process.exit(1); });
