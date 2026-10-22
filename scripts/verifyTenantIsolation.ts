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
    // Build BOTH tenants inside this disposable verification database. E.4
    // must never depend on production/demo bootstrap data.
    const orgA = (await q(`INSERT INTO organizations (name, organization_type, status) VALUES ('E4 Isolation Org A','HOME_CARE_AGENCY','active') RETURNING id`)).rows[0].id as string;
    const userA = (await q(`INSERT INTO users (email, status) VALUES ('e4-isolation-a@example.invalid','active') RETURNING id`)).rows[0].id as string;
    await q(`INSERT INTO organization_memberships (user_id, organization_id, status) VALUES ($1,$2,'active')`, [userA, orgA]);

    // Build an isolated Organization B fixture specifically for E.4. This is
    // intentionally not part of seedDemo/bootstrap and exists only in CI's
    // disposable PostgreSQL database.
    const orgB = (await q(`INSERT INTO organizations (name, organization_type, status) VALUES ('E4 Isolation Org B','HOME_CARE_AGENCY','active') RETURNING id`)).rows[0].id as string;
    const residentB = (await q(`INSERT INTO care_recipients (organization_id, first_name, last_name) VALUES ($1,'TenantB','Resident') RETURNING id, first_name`, [orgB])).rows[0];
    const userB = (await q(`INSERT INTO users (email, status) VALUES ('e4-isolation-b@example.invalid','active') RETURNING id`)).rows[0].id as string;
    await q(`INSERT INTO organization_memberships (user_id, organization_id, status) VALUES ($1,$2,'active')`, [userB, orgB]);
    const workerB = (await q(`INSERT INTO workers (user_id, display_name) VALUES ($1,'Tenant B Caregiver') RETURNING id`, [userB])).rows[0];
    const workerMembershipB = (await q(`INSERT INTO organization_worker_memberships (worker_id, organization_id, status, internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id, worker_id, status`, [workerB.id, orgB])).rows[0];
    const shiftB = (await q(`INSERT INTO shifts (organization_id, care_recipient_id, scheduled_start, scheduled_end, status) VALUES ($1,$2,now()+interval '1 day',now()+interval '1 day 8 hours','confirmed') RETURNING id,status`, [orgB, residentB.id])).rows[0];
    const assignmentB = (await q(`INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, care_recipient_id, role_in_shift) VALUES ($1,$2,$3,$4,'caregiver') RETURNING id`, [orgB, shiftB.id, workerMembershipB.id, residentB.id])).rows[0];

    // Private workforce credential fixture owned by Organization B's caregiver.
    const credentialTypeB = (await q(
      `INSERT INTO credential_types (code, name) VALUES ('E4_TENANT_PRIVATE_DOC','E4 Tenant Private Document') RETURNING id`
    )).rows[0];
    const fileB = (await q(
      `INSERT INTO stored_files (
         scope_type, owner_worker_id, storage_key, content_type, original_filename,
         size_bytes, uploaded_by_user_id, visibility, status
       ) VALUES (
         'PLATFORM_PROFESSIONAL',$1,'e4-isolation/b/private-credential.pdf',
         'application/pdf','tenant-b-private.pdf',128,$2,'private','active'
       ) RETURNING id, original_filename`,
      [workerB.id, userB]
    )).rows[0];
    const documentB = (await q(
      `INSERT INTO documents (worker_id, credential_type_id, file_id, status)
       VALUES ($1,$2,$3,'presented') RETURNING id`,
      [workerB.id, credentialTypeB.id, fileB.id]
    )).rows[0];
    const versionB = (await q(
      `INSERT INTO document_versions (document_id, file_id, version)
       VALUES ($1,$2,1) RETURNING id`,
      [documentB.id, fileB.id]
    )).rows[0];
    const credentialB = (await q(
      `INSERT INTO credentials (
         worker_id, credential_type_id, document_id, issuing_entity_type, status
       ) VALUES ($1,$2,$3,'external_provider','active') RETURNING id, status`,
      [workerB.id, credentialTypeB.id, documentB.id]
    )).rows[0];
    const reviewB = (await q(
      `INSERT INTO organization_credential_reviews (
         credential_id, organization_id, reviewed_by_user_id, review_status, notes, reviewed_at
       ) VALUES ($1,$2,$3,'approved','Tenant B private review',now())
       RETURNING id, review_status`,
      [credentialB.id, orgB, userB]
    )).rows[0];
    const versionReviewB = (await q(
      `INSERT INTO organization_document_version_reviews (
         organization_id, credential_id, document_id, file_id,
         review_status, notes, reviewed_by_user_id
       ) VALUES ($1,$2,$3,$4,'approved','Tenant B version review',$5)
       RETURNING id`,
      [orgB, credentialB.id, documentB.id, fileB.id, userB]
    )).rows[0];

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
    await expectHidden("credentials", `SELECT id FROM credentials WHERE id=$1`, [credentialB.id]);
    await expectHidden("credential documents", `SELECT id FROM documents WHERE id=$1`, [documentB.id]);
    await expectHidden("credential document versions", `SELECT id FROM document_versions WHERE id=$1`, [versionB.id]);
    await expectHidden("credential stored files", `SELECT id FROM stored_files WHERE id=$1`, [fileB.id]);
    await expectHidden("credential version reviews", `SELECT id FROM organization_document_version_reviews WHERE id=$1`, [versionReviewB.id]);

    await expectHidden("resident by valid ID", `SELECT id FROM care_recipients WHERE id=$1`, [residentB.id]);
    await expectHidden("worker membership by valid ID", `SELECT id FROM organization_worker_memberships WHERE id=$1`, [workerMembershipB.id]);
    await expectHidden("shift by valid ID", `SELECT id FROM shifts WHERE id=$1`, [shiftB.id]);
    await expectHidden("assignment by valid ID", `SELECT id FROM assignments WHERE id=$1`, [assignmentB.id]);
    await expectHidden("compliance review by valid ID", `SELECT id FROM organization_credential_reviews WHERE id=$1`, [reviewB.id]);
    await expectHidden("credential by valid ID", `SELECT id FROM credentials WHERE id=$1`, [credentialB.id]);
    await expectHidden("document by valid ID", `SELECT id FROM documents WHERE id=$1`, [documentB.id]);
    await expectHidden("stored file by valid ID", `SELECT id FROM stored_files WHERE id=$1`, [fileB.id]);

    await expectHidden("resident mutation", `UPDATE care_recipients SET first_name=first_name WHERE id=$1 RETURNING id`, [residentB.id]);
    await expectHidden("personnel mutation", `UPDATE organization_worker_memberships SET status=status WHERE id=$1 RETURNING id`, [workerMembershipB.id]);
    await expectHidden("shift mutation", `UPDATE shifts SET status=status WHERE id=$1 RETURNING id`, [shiftB.id]);
    await expectHidden("compliance approval/review mutation", `UPDATE organization_credential_reviews SET review_status=review_status WHERE id=$1 RETURNING id`, [reviewB.id]);
    await expectHidden("credential mutation", `UPDATE credentials SET status=status WHERE id=$1 RETURNING id`, [credentialB.id]);
    await expectHidden("document mutation", `UPDATE documents SET status=status WHERE id=$1 RETURNING id`, [documentB.id]);
    await expectHidden("stored file mutation", `UPDATE stored_files SET status=status WHERE id=$1 RETURNING id`, [fileB.id]);

    // assignments has no updated_at/status field in the base schema; a direct
    // delete is a stronger mutation attempt and remains rolled back either way.
    await expectHidden("assignment mutation", `DELETE FROM assignments WHERE id=$1 RETURNING id`, [assignmentB.id]);

    // Forging only organizationId/current org must not confer membership.
    await q("SELECT set_config('app.current_org_id',$1,true)", [orgB]);
    await expectHidden("resident after forged organizationId", `SELECT id FROM care_recipients WHERE id=$1`, [residentB.id]);
    await expectHidden("personnel after forged organizationId", `SELECT id FROM organization_worker_memberships WHERE id=$1`, [workerMembershipB.id]);
    await expectHidden("shift after forged organizationId", `SELECT id FROM shifts WHERE id=$1`, [shiftB.id]);
    await expectHidden("assignment after forged organizationId", `SELECT id FROM assignments WHERE id=$1`, [assignmentB.id]);
    await expectHidden("credential after forged organizationId", `SELECT id FROM credentials WHERE id=$1`, [credentialB.id]);
    await expectHidden("document after forged organizationId", `SELECT id FROM documents WHERE id=$1`, [documentB.id]);
    await expectHidden("stored file after forged organizationId", `SELECT id FROM stored_files WHERE id=$1`, [fileB.id]);
    await expectHidden("credential review after forged organizationId", `SELECT id FROM organization_credential_reviews WHERE id=$1`, [reviewB.id]);
    await expectHidden("credential version review after forged organizationId", `SELECT id FROM organization_document_version_reviews WHERE id=$1`, [versionReviewB.id]);

    await q("ROLLBACK");

    const residentAfter = (await q(`SELECT first_name FROM care_recipients WHERE id=$1`, [residentB.id])).rows[0];
    const workerAfter = (await q(`SELECT status FROM organization_worker_memberships WHERE id=$1`, [workerMembershipB.id])).rows[0];
    const shiftAfter = (await q(`SELECT status FROM shifts WHERE id=$1`, [shiftB.id])).rows[0];
    const assignmentAfter = (await q(`SELECT id FROM assignments WHERE id=$1`, [assignmentB.id])).rows[0];
    const credentialAfter = (await q(`SELECT status FROM credentials WHERE id=$1`, [credentialB.id])).rows[0];
    const documentAfter = (await q(`SELECT status FROM documents WHERE id=$1`, [documentB.id])).rows[0];
    const fileAfter = (await q(`SELECT status, original_filename FROM stored_files WHERE id=$1`, [fileB.id])).rows[0];
    const reviewAfter = (await q(`SELECT review_status FROM organization_credential_reviews WHERE id=$1`, [reviewB.id])).rows[0];
    if (
      residentAfter?.first_name !== residentB.first_name
      || workerAfter?.status !== workerMembershipB.status
      || shiftAfter?.status !== shiftB.status
      || !assignmentAfter
      || credentialAfter?.status !== credentialB.status
      || documentAfter?.status !== "presented"
      || fileAfter?.status !== "active"
      || fileAfter?.original_filename !== fileB.original_filename
      || reviewAfter?.review_status !== reviewB.review_status
    ) {
      throw new Error("TENANT ISOLATION FAILURE: B resource changed after cross-tenant attack");
    }
    console.log("E.4 tenant isolation verification passed, including private credential/document/file boundaries");
  } catch (error) {
    try { await q("ROLLBACK"); } catch {}
    throw error;
  } finally { await client.end(); }
}

main().catch((error) => { console.error(error); process.exit(1); });
