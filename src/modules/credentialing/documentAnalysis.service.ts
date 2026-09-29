import { sql } from "kysely";
import { withTenantContext } from "../../context/tenantContext.js";
import { analyzeInitialCredentialDocument } from "./documentAnalysis.js";

export async function analyzeCompletedCredentialDocument(
  userId: string,
  organizationId: string,
  workerId: string,
  credentialId: string,
  documentId: string,
  fileId: string,
  documentVersion: number
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const authority = await sql<{ allowed: boolean }>`
      SELECT (app_is_org_manager() OR app_is_superadmin()) AS allowed
    `.execute(trx);
    if (!authority.rows[0]?.allowed) throw new Error("CREDENTIAL_MANAGEMENT_FORBIDDEN");

    const source = await sql<{
      type_code: string;
      original_filename: string;
      content_type: string;
      size_bytes: string;
    }>`
      SELECT ct.code AS type_code, sf.original_filename, sf.content_type, sf.size_bytes
      FROM credentials c
      JOIN credential_types ct ON ct.id = c.credential_type_id
      JOIN documents d ON d.id = c.document_id
      JOIN document_versions dv ON dv.document_id = d.id
      JOIN stored_files sf ON sf.id = dv.file_id
      WHERE c.id = ${credentialId}
        AND c.worker_id = ${workerId}
        AND d.id = ${documentId}
        AND dv.file_id = ${fileId}
        AND dv.version = ${documentVersion}
        AND sf.status = 'active'
      LIMIT 1
    `.execute(trx);
    if (!source.rows[0]) throw new Error("DOCUMENT_ANALYSIS_SOURCE_NOT_FOUND");

    const analysis = analyzeInitialCredentialDocument({
      selectedCredentialTypeCode: source.rows[0].type_code,
      originalFilename: source.rows[0].original_filename,
      contentType: source.rows[0].content_type,
      sizeBytes: Number(source.rows[0].size_bytes),
      documentId,
      fileId,
      documentVersion,
    });

    await sql`
      INSERT INTO document_analysis_results (
        organization_id, credential_id, document_id, file_id, document_version,
        analysis_status, assessment, selected_credential_type_code,
        detected_document_type, confidence, flags, summary, analysis_method,
        analyzed_by_user_id
      ) VALUES (
        ${organizationId}, ${credentialId}, ${documentId}, ${fileId}, ${documentVersion},
        ${analysis.analysisStatus}, ${analysis.assessment}, ${analysis.selectedCredentialTypeCode},
        ${analysis.detectedDocumentType}, ${analysis.confidence}, ${JSON.stringify(analysis.flags)}::jsonb,
        ${analysis.summary}, ${analysis.analysisMethod}, ${userId}
      )
      ON CONFLICT (organization_id, credential_id, file_id) DO NOTHING
    `.execute(trx);

    await sql`
      INSERT INTO audit_log (
        actor_user_id, organization_id, target_organization_id, action,
        entity_type, entity_id, new_value
      ) VALUES (
        ${userId}, ${organizationId}, ${organizationId}, 'credential_document_analyzed',
        'document', ${documentId},
        ${JSON.stringify({ fileId, documentVersion, assessment: analysis.assessment, flags: analysis.flags, analysisMethod: analysis.analysisMethod })}::jsonb
      )
    `.execute(trx);

    return analysis;
  });
}
