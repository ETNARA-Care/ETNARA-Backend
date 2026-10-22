import pg from "pg";

const { Client } = pg;
const connectionString = process.env.MIGRATIONS_DATABASE_URL;
if (!connectionString) throw new Error("MIGRATIONS_DATABASE_URL is required");

const client = new Client({ connectionString });
const q = (text: string, params: unknown[] = []) => client.query(text, params);

async function runtimeContext(userId: string, organizationId: string, fn: () => Promise<void>) {
  await q("BEGIN");
  try {
    await q("SET LOCAL ROLE app_runtime");
    await q("SELECT set_config('app.current_user_id',$1,true)", [userId]);
    await q("SELECT set_config('app.current_org_id',$1,true)", [organizationId]);
    await q("SELECT set_config('app.is_superadmin','false',true)");
    await fn();
    await q("ROLLBACK");
  } catch (error) {
    try { await q("ROLLBACK"); } catch {}
    throw error;
  }
}

async function main() {
  await client.connect();
  try {
    const adminRole = (await q(`SELECT id FROM roles WHERE code='ORGANIZATION_ADMIN' LIMIT 1`)).rows[0]?.id as string | undefined;
    if (!adminRole) throw new Error("ORGANIZATION_ADMIN role missing");

    const orgA = (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ('Credential Boundary A','HOME_CARE_AGENCY','active') RETURNING id`)).rows[0].id as string;
    const orgB = (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ('Credential Boundary B','HOME_CARE_AGENCY','active') RETURNING id`)).rows[0].id as string;

    const managerA = (await q(`INSERT INTO users (email,status) VALUES ('cred-boundary-manager-a@example.invalid','active') RETURNING id`)).rows[0].id as string;
    const managerB = (await q(`INSERT INTO users (email,status) VALUES ('cred-boundary-manager-b@example.invalid','active') RETURNING id`)).rows[0].id as string;
    const caregiverA = (await q(`INSERT INTO users (email,status) VALUES ('cred-boundary-caregiver-a@example.invalid','active') RETURNING id`)).rows[0].id as string;
    const caregiverOther = (await q(`INSERT INTO users (email,status) VALUES ('cred-boundary-caregiver-other@example.invalid','active') RETURNING id`)).rows[0].id as string;
    const platformUser = (await q(`INSERT INTO users (email,status) VALUES ('cred-boundary-platform@example.invalid','active') RETURNING id`)).rows[0].id as string;

    const membershipA = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`,[managerA,orgA])).rows[0].id as string;
    const membershipB = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`,[managerB,orgB])).rows[0].id as string;
    await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active')`,[caregiverA,orgA]);
    await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active')`,[caregiverOther,orgA]);
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) VALUES ($1,$2,$3)`,[membershipA,orgA,adminRole]);
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) VALUES ($1,$2,$3)`,[membershipB,orgB,adminRole]);
    await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`,[platformUser]);

    const workerA = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,'Credential Caregiver A') RETURNING id`,[caregiverA])).rows[0].id as string;
    const workerOther = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,'Credential Caregiver Other') RETURNING id`,[caregiverOther])).rows[0].id as string;
    await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver')`,[workerA,orgA]);
    await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver')`,[workerOther,orgA]);

    const typeId = (await q(`INSERT INTO credential_types (code,name) VALUES ('BOUNDARY_TEST_CREDENTIAL','Boundary Test Credential') RETURNING id`)).rows[0].id as string;
    const credentialA = (await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status) VALUES ($1,$2,'external_provider','active') RETURNING id`,[workerA,typeId])).rows[0].id as string;
    const credentialOther = (await q(`INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status) VALUES ($1,$2,'external_provider','active') RETURNING id`,[workerOther,typeId])).rows[0].id as string;

    const reviewA = (await q(`
      INSERT INTO organization_credential_reviews
        (credential_id,organization_id,reviewed_by_user_id,review_status,notes,reviewed_at)
      VALUES ($1,$2,$3,'approved','initial approval',now())
      RETURNING id
    `,[credentialA,orgA,managerA])).rows[0].id as string;

    await runtimeContext(caregiverA, orgA, async () => {
      const direct = await q(`
        UPDATE organization_credential_reviews
        SET review_status='rejected',notes='caregiver should never write'
        WHERE id=$1 RETURNING id
      `,[reviewA]);
      if ((direct.rowCount ?? 0) !== 0) throw new Error("caregiver directly changed review decision");

      const reset = await q(`SELECT app_reset_credential_review_pending($1) AS count`,[credentialA]);
      if (Number(reset.rows[0]?.count ?? 0) !== 1) throw new Error("caregiver could not reset own credential to pending");

      const other = await q(`SELECT app_reset_credential_review_pending($1) AS count`,[credentialOther]);
      if (Number(other.rows[0]?.count ?? 0) !== 0) throw new Error("caregiver reset another caregiver credential");
    });

    const afterReset = (await q(`SELECT review_status,notes,reviewed_at FROM organization_credential_reviews WHERE id=$1`,[reviewA])).rows[0];
    if (afterReset.review_status !== "pending" || afterReset.notes !== null || afterReset.reviewed_at !== null) {
      throw new Error("pending reset did not clear prior decision metadata");
    }

    await runtimeContext(managerA, orgA, async () => {
      const approved = await q(`
        UPDATE organization_credential_reviews
        SET review_status='approved',notes='manager approval',reviewed_by_user_id=$1,reviewed_at=now()
        WHERE id=$2 RETURNING id
      `,[managerA,reviewA]);
      if ((approved.rowCount ?? 0) !== 1) throw new Error("organization manager could not update review");
    });

    await runtimeContext(managerB, orgB, async () => {
      const crossTenant = await q(`
        UPDATE organization_credential_reviews
        SET review_status='rejected',reviewed_by_user_id=$1,reviewed_at=now()
        WHERE id=$2 RETURNING id
      `,[managerB,reviewA]);
      if ((crossTenant.rowCount ?? 0) !== 0) throw new Error("other organization changed review");

      const reset = await q(`SELECT app_reset_credential_review_pending($1) AS count`,[credentialA]);
      if (Number(reset.rows[0]?.count ?? 0) !== 0) throw new Error("other organization reset credential review");
    });

    await q("BEGIN");
    try {
      await q("SET LOCAL ROLE app_runtime");
      await q("SELECT set_config('app.current_user_id',$1,true)",[platformUser]);
      await q("SELECT set_config('app.current_org_id',$1,true)",[orgA]);
      await q("SELECT set_config('app.is_superadmin','true',true)");
      const platformWrite = await q(`
        UPDATE organization_credential_reviews
        SET review_status='rejected',reviewed_by_user_id=$1,reviewed_at=now()
        WHERE id=$2 RETURNING id
      `,[platformUser,reviewA]);
      if ((platformWrite.rowCount ?? 0) !== 0) throw new Error("platform directly changed tenant review");
      await q("ROLLBACK");
    } catch (error) {
      try { await q("ROLLBACK"); } catch {}
      throw error;
    }

    console.log("Credential review write boundary verification passed");
  } finally {
    await client.end();
  }
}

main().catch((error)=>{ console.error(error); process.exit(1); });
