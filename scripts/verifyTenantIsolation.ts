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
    const orgs = await q(`SELECT id FROM organizations ORDER BY created_at NULLS LAST, id LIMIT 2`);
    if (orgs.rowCount !== 2) throw new Error("E.4 requires two seeded organizations");
    const [orgA, orgB] = orgs.rows.map((r) => r.id as string);
    const membership = await q(`SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND status='active' LIMIT 1`, [orgA]);
    if (!membership.rowCount) throw new Error("E.4 requires an active user in organization A");
    const userA = membership.rows[0].user_id as string;

    // Capture valid B resource IDs as database owner before switching to app_runtime.
    const residentB = (await q(`SELECT id, first_name FROM care_recipients WHERE organization_id=$1 LIMIT 1`, [orgB])).rows[0];
    const workerMembershipB = (await q(`SELECT id, worker_id, status FROM organization_worker_memberships WHERE organization_id=$1 LIMIT 1`, [orgB])).rows[0];
    const reviewB = (await q(`SELECT id, review_status FROM organization_credential_reviews WHERE organization_id=$1 LIMIT 1`, [orgB])).rows[0];
    const shiftB = (await q(`SELECT id, status FROM shifts WHERE organization_id=$1 LIMIT 1`, [orgB])).rows[0];
    const assignmentB = (await q(`SELECT id FROM assignments WHERE organization_id=$1 LIMIT 1`, [orgB])).rows[0];
    if (!residentB || !workerMembershipB || !shiftB) throw new Error("E.4 fixtures need B resident, worker and shift");

    await q("BEGIN");
    await q("SET LOCAL ROLE app_runtime");
    await q("SELECT set_config('app.current_user_id',$1,true)", [userA]);
    await q("SELECT set_config('app.current_org_id',$1,true)", [orgA]);
    await q("SELECT set_config('app.is_superadmin','false',true)");

    // 1-4: tenant-filtered reads across workforce, residents, compliance and scheduling.
    await expectHidden("personnel", `SELECT id FROM organization_worker_memberships WHERE organization_id=$1`, [orgB]);
    await expectHidden("residents", `SELECT id FROM care_recipients WHERE organization_id=$1`, [orgB]);
    await expectHidden("compliance reviews", `SELECT id FROM organization_credential_reviews WHERE organization_id=$1`, [orgB]);
    await expectHidden("shifts", `SELECT id FROM shifts WHERE organization_id=$1`, [orgB]);
    await expectHidden("assignments", `SELECT id FROM assignments WHERE organization_id=$1`, [orgB]);

    // 5: direct-object attacks with known-valid B IDs must also disappear under RLS.
    await expectHidden("resident by valid ID", `SELECT id FROM care_recipients WHERE id=$1`, [residentB.id]);
    await expectHidden("worker membership by valid ID", `SELECT id FROM organization_worker_memberships WHERE id=$1`, [workerMembershipB.id]);
    await expectHidden("shift by valid ID", `SELECT id FROM shifts WHERE id=$1`, [shiftB.id]);
    if (reviewB) await expectHidden("compliance review by valid ID", `SELECT id FROM organization_credential_reviews WHERE id=$1`, [reviewB.id]);
    if (assignmentB) await expectHidden("assignment by valid ID", `SELECT id FROM assignments WHERE id=$1`, [assignmentB.id]);

    // Attempts to mutate B by known-valid IDs must affect zero rows.
    await expectHidden("resident mutation", `UPDATE care_recipients SET first_name=first_name WHERE id=$1 RETURNING id`, [residentB.id]);
    await expectHidden("personnel mutation", `UPDATE organization_worker_memberships SET status=status WHERE id=$1 RETURNING id`, [workerMembershipB.id]);
    await expectHidden("shift mutation", `UPDATE shifts SET status=status WHERE id=$1 RETURNING id`, [shiftB.id]);
    if (reviewB) await expectHidden("compliance approval/review mutation", `UPDATE organization_credential_reviews SET review_status=review_status WHERE id=$1 RETURNING id`, [reviewB.id]);
    if (assignmentB) await expectHidden("assignment mutation", `UPDATE assignments SET updated_at=updated_at WHERE id=$1 RETURNING id`, [assignmentB.id]);

    // 6: changing only organizationId/context to B must fail because user A has no active membership there.
    await q("SELECT set_config('app.current_org_id',$1,true)", [orgB]);
    await expectHidden("resident after forged organizationId", `SELECT id FROM care_recipients WHERE id=$1`, [residentB.id]);
    await expectHidden("personnel after forged organizationId", `SELECT id FROM organization_worker_memberships WHERE id=$1`, [workerMembershipB.id]);
    await expectHidden("shift after forged organizationId", `SELECT id FROM shifts WHERE id=$1`, [shiftB.id]);

    await q("ROLLBACK");

    // Owner-level postcondition: attempted writes did not change B resources.
    const residentAfter = (await q(`SELECT first_name FROM care_recipients WHERE id=$1`, [residentB.id])).rows[0];
    const workerAfter = (await q(`SELECT status FROM organization_worker_memberships WHERE id=$1`, [workerMembershipB.id])).rows[0];
    const shiftAfter = (await q(`SELECT status FROM shifts WHERE id=$1`, [shiftB.id])).rows[0];
    if (residentAfter?.first_name !== residentB.first_name || workerAfter?.status !== workerMembershipB.status || shiftAfter?.status !== shiftB.status) {
      throw new Error("TENANT ISOLATION FAILURE: B resource changed after cross-tenant attack");
    }
    console.log("E.4 tenant isolation verification passed all six negative criteria");
  } catch (error) {
    try { await q("ROLLBACK"); } catch {}
    throw error;
  } finally { await client.end(); }
}

main().catch((error) => { console.error(error); process.exit(1); });
