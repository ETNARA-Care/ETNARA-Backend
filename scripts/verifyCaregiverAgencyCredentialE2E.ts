import pg from "pg";

const { Client } = pg;
const migrationsUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!migrationsUrl) throw new Error("MIGRATIONS_DATABASE_URL is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const admin = new Client({ connectionString: migrationsUrl });
const q = (text: string, params: unknown[] = []) => admin.query(text, params);

async function runtime(userId: string, organizationId: string, work: (client: pg.Client) => Promise<void>, commit = true) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id',$1,true)", [userId]);
    await client.query("SELECT set_config('app.current_org_id',$1,true)", [organizationId]);
    await client.query("SELECT set_config('app.is_superadmin','false',true)");
    await work(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  await admin.connect();
  const { createOrUpdateOrganizationReview, WorkerNotLinkedError } = await import("../src/modules/credentialing/credentialing.service.js");
  const { evaluateWorkerEligibility } = await import("../src/modules/eligibility/eligibility.service.js");
  const { closeDb } = await import("../src/config/db.js");

  try {
    const adminRole = (await q(`SELECT id FROM roles WHERE code='ORGANIZATION_ADMIN' LIMIT 1`)).rows[0]?.id as string | undefined;
    if (!adminRole) throw new Error("ORGANIZATION_ADMIN role missing");

    const orgA = (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ('Credential E2E Agency A','HOME_CARE_AGENCY','active') RETURNING id`)).rows[0].id as string;
    const orgB = (await q(`INSERT INTO organizations (name,organization_type,status) VALUES ('Credential E2E Agency B','HOME_CARE_AGENCY','active') RETURNING id`)).rows[0].id as string;

    const managerA = (await q(`INSERT INTO users (email,status) VALUES ('cred-e2e-manager-a@example.invalid','active') RETURNING id`)).rows[0].id as string;
    const managerB = (await q(`INSERT INTO users (email,status) VALUES ('cred-e2e-manager-b@example.invalid','active') RETURNING id`)).rows[0].id as string;
    const caregiver = (await q(`INSERT INTO users (email,status) VALUES ('cred-e2e-caregiver@example.invalid','active') RETURNING id`)).rows[0].id as string;

    const omA = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`,[managerA,orgA])).rows[0].id as string;
    const omB = (await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`,[managerB,orgB])).rows[0].id as string;
    await q(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active')`,[caregiver,orgA]);
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) VALUES ($1,$2,$3)`,[omA,orgA,adminRole]);
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) VALUES ($1,$2,$3)`,[omB,orgB,adminRole]);

    const worker = (await q(`INSERT INTO workers (user_id,display_name) VALUES ($1,'Credential E2E Caregiver') RETURNING id`,[caregiver])).rows[0].id as string;
    const workerMembership = (await q(`
      INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role)
      VALUES ($1,$2,'active','caregiver') RETURNING id
    `,[worker,orgA])).rows[0].id as string;

    const typeId = (await q(`
      INSERT INTO credential_types (code,name)
      VALUES ('E2E_AGENCY_REVIEW','E2E Agency Review Credential') RETURNING id
    `)).rows[0].id as string;
    const requirementSet = (await q(`
      INSERT INTO requirement_sets (organization_id,worker_role,name)
      VALUES ($1,'caregiver','E2E caregiver requirements') RETURNING id
    `,[orgA])).rows[0].id as string;
    await q(`
      INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review)
      VALUES ($1,$2,true,true)
    `,[requirementSet,typeId]);

    const file1 = (await q(`
      INSERT INTO stored_files (
        scope_type,owner_worker_id,storage_key,content_type,original_filename,size_bytes,
        uploaded_by_user_id,visibility,status
      ) VALUES (
        'PLATFORM_PROFESSIONAL',$1,'credentials/e2e/v1','application/pdf','credential-v1.pdf',100,
        $2,'private','active'
      ) RETURNING id
    `,[worker,caregiver])).rows[0].id as string;
    const documentId = (await q(`
      INSERT INTO documents (worker_id,credential_type_id,file_id,status)
      VALUES ($1,$2,$3,'presented') RETURNING id
    `,[worker,typeId,file1])).rows[0].id as string;
    await q(`INSERT INTO document_versions (document_id,file_id,version) VALUES ($1,$2,1)`,[documentId,file1]);
    const credential = (await q(`
      INSERT INTO credentials (
        worker_id,credential_type_id,document_id,issuing_entity_type,status,expires_at
      ) VALUES ($1,$2,$3,'external_provider','active',current_date + 365)
      RETURNING id
    `,[worker,typeId,documentId])).rows[0].id as string;

    const initial = await evaluateWorkerEligibility(managerA, orgA, workerMembership);
    if (initial.eligibilityStatus !== "not_eligible" || initial.requirements[0]?.reason !== "ORGANIZATION_REVIEW_MISSING") {
      throw new Error(`expected initial organization review blocker, got ${JSON.stringify(initial)}`);
    }

    const rejected = await createOrUpdateOrganizationReview(
      managerA, orgA, workerMembership, credential,
      { reviewStatus: "rejected", notes: "Documento ilegible; reemplazar." }
    );
    if (rejected.review_status !== "rejected") throw new Error("agency rejection did not persist");

    const rejectedNotice = await q(`
      SELECT count(*)::int AS count FROM notifications
      WHERE user_id=$1 AND organization_id=$2
        AND notification_type='CREDENTIAL_REVIEW_REJECTED'
        AND related_entity_id=$3
    `,[caregiver,orgA,credential]);
    if (Number(rejectedNotice.rows[0]?.count ?? 0) < 1) throw new Error("caregiver rejection notification missing");

    const afterReject = await evaluateWorkerEligibility(managerA, orgA, workerMembership);
    if (afterReject.eligibilityStatus !== "not_eligible") throw new Error("rejected credential became eligible");

    const file2 = (await q(`
      INSERT INTO stored_files (
        scope_type,owner_worker_id,storage_key,content_type,original_filename,size_bytes,
        uploaded_by_user_id,visibility,status
      ) VALUES (
        'PLATFORM_PROFESSIONAL',$1,'credentials/e2e/v2','application/pdf','credential-v2.pdf',120,
        $2,'private','active'
      ) RETURNING id
    `,[worker,caregiver])).rows[0].id as string;
    await q(`UPDATE documents SET file_id=$1,status='presented',updated_at=now() WHERE id=$2`,[file2,documentId]);
    await q(`INSERT INTO document_versions (document_id,file_id,version) VALUES ($1,$2,2)`,[documentId,file2]);

    await runtime(caregiver, orgA, async (client) => {
      const reset = await client.query(`SELECT app_reset_credential_review_pending($1) AS count`,[credential]);
      if (Number(reset.rows[0]?.count ?? 0) !== 1) throw new Error("caregiver replacement did not reset review to pending");
      const notified = await client.query(`SELECT app_notify_credential_review_managers($1) AS count`,[credential]);
      if (Number(notified.rows[0]?.count ?? 0) < 1) throw new Error("manager pending-review notification missing");
    });

    const pending = (await q(`
      SELECT review_status,notes,reviewed_at FROM organization_credential_reviews
      WHERE credential_id=$1 AND organization_id=$2
    `,[credential,orgA])).rows[0];
    if (pending?.review_status !== "pending" || pending.notes !== null || pending.reviewed_at !== null) {
      throw new Error("replacement did not clear decision and return review to pending");
    }

    const pendingManagerNotice = await q(`
      SELECT count(*)::int AS count FROM notifications
      WHERE user_id=$1 AND organization_id=$2
        AND notification_type='CREDENTIAL_REVIEW_PENDING'
        AND related_entity_id=$3
    `,[managerA,orgA,credential]);
    if (Number(pendingManagerNotice.rows[0]?.count ?? 0) < 1) throw new Error("manager pending notification not found");

    const afterReplacement = await evaluateWorkerEligibility(managerA, orgA, workerMembership);
    if (afterReplacement.eligibilityStatus !== "not_eligible" || afterReplacement.requirements[0]?.reason !== "ORGANIZATION_REVIEW_MISSING") {
      throw new Error("replacement should remain blocked until agency approval");
    }

    let crossTenantBlocked = false;
    try {
      await createOrUpdateOrganizationReview(
        managerB, orgB, workerMembership, credential,
        { reviewStatus: "approved" }
      );
    } catch (error) {
      crossTenantBlocked = error instanceof WorkerNotLinkedError || (error instanceof Error && error.message.includes("WORKER"));
    }
    if (!crossTenantBlocked) throw new Error("Agency B was able to review Agency A credential");

    const approved = await createOrUpdateOrganizationReview(
      managerA, orgA, workerMembership, credential,
      { reviewStatus: "approved" }
    );
    if (approved.review_status !== "approved") throw new Error("agency approval did not persist");

    const approvedNotice = await q(`
      SELECT count(*)::int AS count FROM notifications
      WHERE user_id=$1 AND organization_id=$2
        AND notification_type='CREDENTIAL_REVIEW_APPROVED'
        AND related_entity_id=$3
    `,[caregiver,orgA,credential]);
    if (Number(approvedNotice.rows[0]?.count ?? 0) < 1) throw new Error("caregiver approval notification missing");

    const finalEligibility = await evaluateWorkerEligibility(managerA, orgA, workerMembership);
    if (finalEligibility.eligibilityStatus !== "eligible" || finalEligibility.requirements[0]?.reason !== "OK") {
      throw new Error(`approved credential did not become eligible: ${JSON.stringify(finalEligibility)}`);
    }

    console.log("PASS: caregiver-agency credential E2E pending -> rejected -> replacement -> pending -> approved -> eligible; cross-tenant blocked; notifications verified");
  } finally {
    await closeDb();
    await admin.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
