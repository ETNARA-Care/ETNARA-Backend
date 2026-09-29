import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { withPlatformContext } from "../../context/tenantContext.js";
import { hashToken } from "../../security/sessionToken.js";

export const createPlatformOrganizationSchema = z.object({name:z.string().trim().min(2).max(160),organizationType:z.enum(["HOME_CARE_AGENCY","RESIDENTIAL_CARE_HOME"]),status:z.enum(["trial","active"]).default("trial")});
export const inviteOrganizationAdminSchema=z.object({email:z.string().trim().email().max(254)});
export type CreatePlatformOrganizationInput=z.infer<typeof createPlatformOrganizationSchema>;

export async function listPlatformOrganizations(userId:string){return withPlatformContext(userId,async trx=>(await sql<{id:string;name:string;organization_type:string;status:string;created_at:Date}>`SELECT id,name,organization_type,status,created_at FROM organizations WHERE archived_at IS NULL ORDER BY created_at DESC`.execute(trx)).rows);}
export async function createPlatformOrganization(userId:string,input:CreatePlatformOrganizationInput){return withPlatformContext(userId,async trx=>{const created=await sql<{id:string;name:string;organization_type:string;status:string;created_at:Date}>`INSERT INTO organizations (name,organization_type,status) VALUES (${input.name},${input.organizationType}::organization_type_enum,${input.status}::organization_status_enum) RETURNING id,name,organization_type,status,created_at`.execute(trx);const organization=created.rows[0];await sql`INSERT INTO organization_settings (organization_id) VALUES (${organization.id})`.execute(trx);return organization;});}

export async function inviteOrganizationAdmin(userId:string,organizationId:string,emailInput:string){return withPlatformContext(userId,async trx=>{
 const org=await sql<{id:string;name:string}>`SELECT id,name FROM organizations WHERE id=${organizationId} AND archived_at IS NULL LIMIT 1`.execute(trx);if(!org.rows[0])throw new Error("ORGANIZATION_NOT_FOUND");
 const email=emailInput.trim().toLowerCase();await sql`UPDATE access_invitations SET status='expired',updated_at=now() WHERE organization_id=${organizationId} AND invitation_type='organization_admin' AND status='pending' AND expires_at<=now()`.execute(trx);
 const pending=await sql<{id:string}>`SELECT id FROM access_invitations WHERE organization_id=${organizationId} AND invitation_type='organization_admin' AND lower(email)=${email} AND status='pending' LIMIT 1`.execute(trx);if(pending.rows[0])throw new Error("INVITATION_ALREADY_PENDING");
 const rawToken=randomBytes(32).toString("hex"),tokenHash=hashToken(rawToken),expiresAt=new Date(Date.now()+7*86400000).toISOString();
 const inserted=await sql<{id:string;email:string;expires_at:string}>`INSERT INTO access_invitations(organization_id,invited_by_user_id,invitation_type,email,token_hash,expires_at) VALUES(${organizationId},${userId},'organization_admin',${email},${tokenHash},${expiresAt}) RETURNING id,email,expires_at`.execute(trx);
 return {invitation:{...inserted.rows[0],organization_id:organizationId,organization_name:org.rows[0].name},rawToken};
 });}
