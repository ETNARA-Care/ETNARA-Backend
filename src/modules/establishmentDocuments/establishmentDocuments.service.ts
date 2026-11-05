import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { withTenantContext } from "../../context/tenantContext.js";
import { logInternalError } from "../../observability/internalError.js";
import { copyPrivateObject, createPrivateDownloadUrl, deletePrivateObject, uploadPrivateObject } from "../storage/objectStorage.js";
import { assertDocumentDatesCoherent, dateText, normalizeDocumentDates } from "./establishmentDocumentDates.js";
export class EstablishmentDocumentForbiddenError extends Error{constructor(){super("ESTABLISHMENT_DOCUMENT_FORBIDDEN");}}
export class EstablishmentDocumentNotFoundError extends Error{constructor(){super("ESTABLISHMENT_DOCUMENT_NOT_FOUND");}}
export class EstablishmentDocumentNotCurrentError extends Error{constructor(){super("ESTABLISHMENT_DOCUMENT_NOT_CURRENT");}}
async function allowed(trx:any,o:string,e:string){const r=await sql<{allowed:boolean}>`SELECT EXISTS(SELECT 1 FROM locations l WHERE l.id=${e} AND l.organization_id=${o} AND (app_is_org_manager() OR app_is_establishment_admin(${e}))) allowed`.execute(trx);if(!r.rows[0]?.allowed)throw new EstablishmentDocumentForbiddenError();}
// 150: expiry_status hace explícitos los tres estados (fecha real · sin vencimiento aplicable · no informado).
const fields=sql.raw("id,document_type,title,file_name,content_type,size_bytes,issued_on,expires_on,expiry_not_applicable,CASE WHEN expiry_not_applicable THEN 'not_applicable' WHEN expires_on IS NULL THEN 'not_informed' ELSE 'date' END AS expiry_status,notes,review_status,reviewed_by_user_id,reviewed_at,review_reason,created_at");
export async function listEstablishmentDocuments(u:string,o:string,e:string){return withTenantContext({userId:u,organizationId:o},async trx=>{await allowed(trx,o,e);const r=await sql<any>`SELECT ${fields} FROM establishment_documents WHERE organization_id=${o} AND establishment_id=${e} AND archived_at IS NULL ORDER BY created_at DESC`.execute(trx);return r.rows;});}
export async function listEstablishmentDocumentHistory(u:string,o:string,e:string,documentType?:string){return withTenantContext({userId:u,organizationId:o},async trx=>{await allowed(trx,o,e);const r=await sql<any>`SELECT ${fields},archived_at,CASE WHEN archived_at IS NULL THEN true ELSE false END AS is_current,EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=${o} AND a.action='ESTABLISHMENT_DOCUMENT_DATES_CORRECTED' AND a.entity_type='establishment_document' AND a.entity_id=establishment_documents.id) AS dates_corrected FROM establishment_documents WHERE organization_id=${o} AND establishment_id=${e} AND (${documentType??null}::text IS NULL OR document_type=${documentType??null}) ORDER BY document_type,created_at DESC`.execute(trx);return r.rows;});}
// Best-effort undo of an upload whose row was never committed, so no orphan
// file is left in the bucket. The log line carries no key, file name or id.
async function removeUploadedObject(key:string){try{await deletePrivateObject(key);}catch(err){logInternalError("establishment-document-upload-cleanup",{name:err instanceof Error?err.name:typeof err});}}
export async function uploadEstablishmentDocument(u:string,o:string,e:string,input:{documentType:string;title:string;fileName:string;contentType:string;issuedOn?:string;expiresOn?:string;notes?:string},body:Buffer){const dates=normalizeDocumentDates({issuedOn:input.issuedOn,expiresOn:input.expiresOn});const expiry=dates.expiry??{expiresOn:null,notApplicable:false};assertDocumentDatesCoherent(dates.issuedOn??null,expiry.expiresOn);input={...input,issuedOn:dates.issuedOn??undefined,expiresOn:expiry.expiresOn??undefined};let uploadedKey:string|null=null;try{return await withTenantContext({userId:u,organizationId:o},async trx=>{await allowed(trx,o,e);const id=randomUUID();const key=`establishment-documents/${o}/${e}/${id}/${input.fileName.replace(/[^a-zA-Z0-9._-]/g,"_")}`;await uploadPrivateObject(key,input.contentType,body);uploadedKey=key;await sql`UPDATE establishment_documents SET archived_at=now(),updated_at=now() WHERE organization_id=${o} AND establishment_id=${e} AND document_type=${input.documentType} AND archived_at IS NULL`.execute(trx);const r=await sql<any>`INSERT INTO establishment_documents(id,organization_id,establishment_id,document_type,title,file_name,content_type,size_bytes,storage_key,issued_on,expires_on,expiry_not_applicable,notes,uploaded_by_user_id,review_status) VALUES(${id},${o},${e},${input.documentType},${input.title},${input.fileName},${input.contentType},${body.byteLength},${key},${input.issuedOn??null},${input.expiresOn??null},${expiry.notApplicable},${input.notes??null},${u},'pending') RETURNING ${fields}`.execute(trx);return r.rows[0];});}catch(err){if(uploadedKey)await removeUploadedObject(uploadedKey);throw err;}}
export async function getEstablishmentDocumentDownload(u:string,o:string,e:string,d:string){return withTenantContext({userId:u,organizationId:o},async trx=>{await allowed(trx,o,e);const r=await sql<any>`SELECT storage_key,file_name,content_type FROM establishment_documents WHERE id=${d} AND organization_id=${o} AND establishment_id=${e} LIMIT 1`.execute(trx);if(!r.rows[0])throw new EstablishmentDocumentNotFoundError();return createPrivateDownloadUrl(r.rows[0].storage_key,r.rows[0].file_name,r.rows[0].content_type);});}
export async function archiveEstablishmentDocument(u:string,o:string,e:string,d:string){return withTenantContext({userId:u,organizationId:o},async trx=>{await allowed(trx,o,e);const r=await sql<any>`UPDATE establishment_documents SET archived_at=now(),updated_at=now() WHERE id=${d} AND organization_id=${o} AND establishment_id=${e} AND archived_at IS NULL RETURNING id`.execute(trx);if(!r.rows[0])throw new EstablishmentDocumentNotFoundError();});}

/**
 * D4: corregir las fechas de un documento institucional sin volver a cargar el archivo.
 *
 * Respeta la 149 (la aplicación no modifica filas: solo archiva). Crea una versión nueva con las
 * fechas corregidas y el MISMO archivo, copiado dentro del bucket privado en el servidor (cada fila
 * tiene su propia clave porque storage_key es único); el objeto original no se toca. La versión
 * anterior queda archivada en el historial. Audita quién, cuándo y qué cambió.
 * Solo gerencia de la agencia o administradora del establecimiento (misma regla que cargar).
 */
export async function correctEstablishmentDocumentDates(u:string,o:string,e:string,d:string,input:{issuedOn?:string|null;expiresOn?:string|null}){
  const requested=normalizeDocumentDates(input);
  let copiedKey:string|null=null;
  try{
    return await withTenantContext({userId:u,organizationId:o},async trx=>{
      await allowed(trx,o,e);
      const found=await sql<any>`SELECT id,document_type,title,file_name,content_type,size_bytes,storage_key,issued_on,expires_on,expiry_not_applicable,notes,archived_at FROM establishment_documents WHERE id=${d} AND organization_id=${o} AND establishment_id=${e} FOR UPDATE`.execute(trx);
      const current=found.rows[0];
      if(!current)throw new EstablishmentDocumentNotFoundError();
      if(current.archived_at)throw new EstablishmentDocumentNotCurrentError();
      const before={issuedOn:dateText(current.issued_on),expiresOn:dateText(current.expires_on),notApplicable:current.expiry_not_applicable===true};
      const after={issuedOn:requested.issuedOn===undefined?before.issuedOn:requested.issuedOn,expiresOn:requested.expiry===undefined?before.expiresOn:requested.expiry.expiresOn,notApplicable:requested.expiry===undefined?before.notApplicable:requested.expiry.notApplicable};
      assertDocumentDatesCoherent(after.issuedOn,after.expiresOn);
      if(after.issuedOn===before.issuedOn&&after.expiresOn===before.expiresOn&&after.notApplicable===before.notApplicable){
        const same=await sql<any>`SELECT ${fields} FROM establishment_documents WHERE id=${d}`.execute(trx);
        return{document:same.rows[0],changed:false};
      }
      const id=randomUUID();
      const key=`establishment-documents/${o}/${e}/${id}/${String(current.file_name).replace(/[^a-zA-Z0-9._-]/g,"_")}`;
      await copyPrivateObject(current.storage_key,key);
      copiedKey=key;
      await sql`UPDATE establishment_documents SET archived_at=now(),updated_at=now() WHERE id=${d} AND organization_id=${o} AND establishment_id=${e} AND archived_at IS NULL`.execute(trx);
      const r=await sql<any>`INSERT INTO establishment_documents(id,organization_id,establishment_id,document_type,title,file_name,content_type,size_bytes,storage_key,issued_on,expires_on,expiry_not_applicable,notes,uploaded_by_user_id,review_status) VALUES(${id},${o},${e},${current.document_type},${current.title},${current.file_name},${current.content_type},${current.size_bytes},${key},${after.issuedOn},${after.expiresOn},${after.notApplicable},${current.notes},${u},'pending') RETURNING ${fields}`.execute(trx);
      await sql`INSERT INTO audit_log(actor_user_id,organization_id,target_organization_id,action,entity_type,entity_id,previous_value,new_value) VALUES(${u},${o},${o},'ESTABLISHMENT_DOCUMENT_DATES_CORRECTED','establishment_document',${id},jsonb_build_object('document_id',${d}::uuid,'issued_on',${before.issuedOn}::date,'expires_on',${before.expiresOn}::date,'expiry_not_applicable',${before.notApplicable}::boolean),jsonb_build_object('document_id',${id}::uuid,'issued_on',${after.issuedOn}::date,'expires_on',${after.expiresOn}::date,'expiry_not_applicable',${after.notApplicable}::boolean,'file','same_file_server_copy'))`.execute(trx);
      return{document:r.rows[0],changed:true};
    });
  }catch(err){if(copiedKey)await removeUploadedObject(copiedKey);throw err;}
}
