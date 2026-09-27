import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { EstablishmentManagementForbiddenError, EstablishmentNotFoundError } from "./establishments.service.js";

export const assignmentSchema = z.object({ membershipId: z.string().uuid() });
export const recipientAssignmentSchema = z.object({ recipientId: z.string().uuid() });

async function assertEstablishmentAccess(trx: any, organizationId: string, establishmentId: string) {
  const location = await sql<{ allowed: boolean }>`SELECT EXISTS (SELECT 1 FROM locations WHERE id=${establishmentId} AND organization_id=${organizationId} AND archived_at IS NULL) AND app_is_establishment_admin(${establishmentId}::uuid) AS allowed`.execute(trx);
  if (!location.rows[0]?.allowed) {
    const exists = await sql<{ present: boolean }>`SELECT EXISTS(SELECT 1 FROM locations WHERE id=${establishmentId} AND organization_id=${organizationId}) AS present`.execute(trx);
    if (!exists.rows[0]?.present) throw new EstablishmentNotFoundError();
    throw new EstablishmentManagementForbiddenError();
  }
}

export function listMyAdminEstablishments(userId:string, organizationId:string) {
  return withTenantContext({userId,organizationId}, async (trx) => {
    const rows = await sql`
      SELECT l.id, l.name, l.address
      FROM establishment_admin_assignments eaa
      JOIN organization_memberships om ON om.id=eaa.organization_membership_id AND om.organization_id=eaa.organization_id
      JOIN locations l ON l.id=eaa.location_id AND l.organization_id=eaa.organization_id
      WHERE eaa.organization_id=${organizationId} AND om.user_id=${userId}
        AND om.status='active' AND eaa.archived_at IS NULL AND l.archived_at IS NULL
      ORDER BY l.name
    `.execute(trx);
    return rows.rows;
  });
}

export function getEstablishmentWorkspace(userId: string, organizationId: string, establishmentId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertEstablishmentAccess(trx, organizationId, establishmentId);
    const establishment = await sql`SELECT id, name, address FROM locations WHERE id=${establishmentId} AND organization_id=${organizationId}`.execute(trx);
    const personnel = await sql`SELECT owm.id AS membership_id,w.id AS worker_id,w.display_name,owm.status FROM establishment_worker_assignments ewa JOIN organization_worker_memberships owm ON owm.id=ewa.organization_worker_membership_id AND owm.organization_id=ewa.organization_id JOIN workers w ON w.id=owm.worker_id WHERE ewa.organization_id=${organizationId} AND ewa.location_id=${establishmentId} AND ewa.archived_at IS NULL ORDER BY w.display_name`.execute(trx);
    const residents = await sql`SELECT id,first_name,last_name,preferred_name,status,room_id FROM care_recipients WHERE organization_id=${organizationId} AND location_id=${establishmentId} AND status='active' ORDER BY last_name,first_name`.execute(trx);
    const administrators = await sql`SELECT eaa.organization_membership_id AS membership_id,u.email,COALESCE(MAX(w.display_name),u.email,'Administrador') AS display_name,COALESCE(MAX(INITCAP(REPLACE(owm.internal_role,'_',' '))),string_agg(DISTINCT r.name,', ' ORDER BY r.name),'Administrador') AS role,om.status FROM establishment_admin_assignments eaa JOIN organization_memberships om ON om.id=eaa.organization_membership_id AND om.organization_id=eaa.organization_id JOIN users u ON u.id=om.user_id LEFT JOIN workers w ON w.user_id=om.user_id LEFT JOIN organization_worker_memberships owm ON owm.worker_id=w.id AND owm.organization_id=om.organization_id AND owm.status='active' LEFT JOIN user_roles ur ON ur.organization_membership_id=om.id AND ur.organization_id=om.organization_id LEFT JOIN roles r ON r.id=ur.role_id WHERE eaa.organization_id=${organizationId} AND eaa.location_id=${establishmentId} AND eaa.archived_at IS NULL GROUP BY eaa.organization_membership_id,u.email,om.status ORDER BY display_name`.execute(trx);
    const administratorCandidates = await sql`SELECT om.id AS membership_id,u.email,COALESCE(MAX(w.display_name),u.email,'Usuario') AS display_name,COALESCE(MAX(INITCAP(REPLACE(owm.internal_role,'_',' '))),string_agg(DISTINCT r.name,', ' ORDER BY r.name)) AS role,om.status FROM organization_memberships om JOIN users u ON u.id=om.user_id LEFT JOIN user_roles ur ON ur.organization_membership_id=om.id AND ur.organization_id=om.organization_id LEFT JOIN roles r ON r.id=ur.role_id LEFT JOIN workers w ON w.user_id=om.user_id LEFT JOIN organization_worker_memberships owm ON owm.worker_id=w.id AND owm.organization_id=om.organization_id AND owm.status='active' WHERE om.organization_id=${organizationId} AND om.status='active' AND (r.code IN ('ORGANIZATION_ADMIN','SUPERVISOR') OR UPPER(COALESCE(owm.internal_role,'')) IN ('SUPERVISOR','ADMIN','ADMINISTRATOR')) GROUP BY om.id,u.email,om.status ORDER BY display_name`.execute(trx);
    return { establishment: establishment.rows[0], personnel: personnel.rows, residents: residents.rows, administrators: administrators.rows, administratorCandidates: administratorCandidates.rows };
  });
}

export function assignWorkerToEstablishment(userId:string,organizationId:string,establishmentId:string,membershipId:string){return withTenantContext({userId,organizationId},async(trx)=>{await assertEstablishmentAccess(trx,organizationId,establishmentId);const result=await sql`INSERT INTO establishment_worker_assignments (organization_id,location_id,organization_worker_membership_id,created_by_user_id) SELECT ${organizationId},${establishmentId},owm.id,${userId} FROM organization_worker_memberships owm WHERE owm.id=${membershipId} AND owm.organization_id=${organizationId} AND owm.status='active' ON CONFLICT (organization_worker_membership_id,location_id) DO UPDATE SET archived_at=NULL RETURNING id,organization_id,location_id,organization_worker_membership_id`.execute(trx);if(!result.rows[0])throw new EstablishmentNotFoundError();return result.rows[0];});}
export function assignRecipientToEstablishment(userId:string,organizationId:string,establishmentId:string,recipientId:string){return withTenantContext({userId,organizationId},async(trx)=>{await assertEstablishmentAccess(trx,organizationId,establishmentId);const result=await sql`UPDATE care_recipients SET location_id=${establishmentId},updated_at=now() WHERE id=${recipientId} AND organization_id=${organizationId} AND status='active' RETURNING id,organization_id,location_id,first_name,last_name`.execute(trx);if(!result.rows[0])throw new EstablishmentNotFoundError();return result.rows[0];});}
export function assignAdminToEstablishment(userId:string,organizationId:string,establishmentId:string,membershipId:string){return withTenantContext({userId,organizationId},async(trx)=>{const manager=await sql<{allowed:boolean}>`SELECT app_is_org_manager() AS allowed`.execute(trx);if(!manager.rows[0]?.allowed)throw new EstablishmentManagementForbiddenError();const candidate=await sql<{membership_id:string}>`SELECT om.id AS membership_id FROM organization_memberships om WHERE om.id=${membershipId} AND om.organization_id=${organizationId} AND om.status='active' AND (EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.organization_membership_id=om.id AND ur.organization_id=om.organization_id AND r.code IN ('ORGANIZATION_ADMIN','SUPERVISOR')) OR EXISTS(SELECT 1 FROM workers w JOIN organization_worker_memberships owm ON owm.worker_id=w.id WHERE w.user_id=om.user_id AND owm.organization_id=om.organization_id AND owm.status='active' AND UPPER(COALESCE(owm.internal_role,'')) IN ('SUPERVISOR','ADMIN','ADMINISTRATOR'))) LIMIT 1`.execute(trx);if(!candidate.rows[0])throw new EstablishmentNotFoundError();const location=await sql<{id:string}>`SELECT id FROM locations WHERE id=${establishmentId} AND organization_id=${organizationId} AND archived_at IS NULL LIMIT 1`.execute(trx);if(!location.rows[0])throw new EstablishmentNotFoundError();const result=await sql`INSERT INTO establishment_admin_assignments (organization_id,location_id,organization_membership_id,created_by_user_id) VALUES (${organizationId},${establishmentId},${candidate.rows[0].membership_id},${userId}) ON CONFLICT (organization_membership_id,location_id) DO UPDATE SET archived_at=NULL RETURNING id,organization_id,location_id,organization_membership_id`.execute(trx);if(!result.rows[0])throw new EstablishmentNotFoundError();return result.rows[0];});}
