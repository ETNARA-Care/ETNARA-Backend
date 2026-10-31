/**
 * Mensajería directa agencia ↔ cuidadora (migración 136).
 *
 * Una conversación por agencia y cuidadora (thread_type 'caregiver_agency', sin residente ni
 * turno). La abre solo una ORGANIZATION_ADMIN desde el perfil de la cuidadora; participan la
 * cuidadora y las administradoras activas. Leer y responder usa las rutas de siempre
 * (/conversations/:id/messages), protegidas por roleGuards.threadAccessSql: además de ser
 * participante, hay que ser administradora de la agencia o la cuidadora con su membresía activa.
 * Ninguna respuesta de este módulo incluye datos de residentes, direcciones ni planes.
 */
import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { threadAccessSql } from "../../security/roleGuards.js";

export class CaregiverConversationError extends Error {
  constructor(public readonly code: "CAREGIVER_THREAD_FORBIDDEN" | "CAREGIVER_NOT_FOUND" | "CAREGIVER_NO_ACCOUNT" | "CAREGIVER_THREAD_SELF") {
    super(code);
    this.name = "CaregiverConversationError";
  }
}

const KNOWN = ["CAREGIVER_THREAD_FORBIDDEN", "CAREGIVER_NOT_FOUND", "CAREGIVER_NO_ACCOUNT", "CAREGIVER_THREAD_SELF"] as const;
const uuidSchema = z.string().uuid();

export interface CaregiverConversation {
  conversationId: string;
  organizationWorkerMembershipId: string;
  caregiverName: string;
  organizationName: string;
}

export async function openCaregiverConversation(userId: string, organizationId: string, workerMembershipId: string) {
  if (!uuidSchema.safeParse(workerMembershipId).success) throw new CaregiverConversationError("CAREGIVER_NOT_FOUND");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    try {
      const r = await sql<{ thread_id: string; created: boolean }>`
        SELECT thread_id, created FROM app_open_caregiver_thread(${workerMembershipId}::uuid)
      `.execute(trx);
      const row = r.rows[0];
      return { conversationId: row.thread_id, created: row.created };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = KNOWN.find((c) => message.includes(c));
      if (code) throw new CaregiverConversationError(code);
      throw error;
    }
  });
}

/** Las conversaciones directas que la persona puede usar en esta agencia, con el nombre que se muestra. */
export async function listCaregiverConversations(userId: string, organizationId: string): Promise<CaregiverConversation[]> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const r = await sql<{ id: string; organization_worker_membership_id: string; caregiver_name: string | null; organization_name: string }>`
      SELECT mt.id, mt.organization_worker_membership_id, w.display_name AS caregiver_name, o.name AS organization_name
      FROM message_threads mt
      JOIN message_thread_participants mtp ON mtp.message_thread_id = mt.id AND mtp.organization_id = mt.organization_id
      JOIN organization_worker_memberships owm ON owm.id = mt.organization_worker_membership_id AND owm.organization_id = mt.organization_id
      JOIN workers w ON w.id = owm.worker_id
      JOIN organizations o ON o.id = mt.organization_id
      WHERE mt.organization_id = ${organizationId}
        AND mt.thread_type = 'caregiver_agency'
        AND mtp.user_id = ${userId}
        AND ${threadAccessSql(sql`mt.id`)}
      ORDER BY mt.created_at DESC
    `.execute(trx);
    return r.rows.map((row) => ({
      conversationId: row.id,
      organizationWorkerMembershipId: row.organization_worker_membership_id,
      caregiverName: row.caregiver_name ?? "Cuidador/a",
      organizationName: row.organization_name,
    }));
  });
}
