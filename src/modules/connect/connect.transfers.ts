import { sql } from "kysely";
import { z } from "zod";
import { db } from "../../config/db.js";
import { withTenantContext } from "../../context/tenantContext.js";
import { assertOrgManager } from "../../security/roleGuards.js";
import { ConnectError } from "./connect.service.js";
import { kickConnectOutbox } from "./connect.worker.js";

/**
 * 182 · C-4: servicios de Connect que la familia autorizó pasar a Care. Connect los envía (token de servicio); la
 * administración o supervisión los acepta (creando la persona atendida por la vía normal con RLS, o usando la ya
 * enlazada a esa familia) o los rechaza. Sin duplicados: lo garantiza la base.
 */
const ERR: Record<string, number> = {
  CONNECT_MANAGER_REQUIRED: 403, CONNECT_TRANSFER_NOT_FOUND: 404, CONNECT_TRANSFER_NOT_PENDING: 409, CONNECT_REASON_REQUIRED: 400,
  CONNECT_RECIPIENT_INVALID: 400, CONNECT_RECIPIENT_ALREADY_LINKED: 409, CONNECT_DECISION_INVALID: 400,
};
function translate(err: unknown): never {
  const m = err instanceof Error ? err.message : "";
  const code = Object.keys(ERR).find((c) => m.includes(c));
  if (code) throw new ConnectError(code, ERR[code]);
  throw err;
}

export const InboundTransfer = z.object({
  id: z.string().uuid(), connectProviderRef: z.string().uuid(), acuerdoId: z.string().uuid(), familyRef: z.string().uuid(),
  payload: z.record(z.string(), z.unknown()),
}).strict();
export const Withdraw = z.object({ id: z.string().uuid(), connectProviderRef: z.string().uuid() }).strict();
export const Decide = z.union([
  z.object({ decision: z.literal("reject"), reason: z.string().trim().min(3).max(300) }).strict(),
  z.object({ decision: z.literal("accept"), recipientId: z.string().uuid() }).strict(),
  z.object({ decision: z.literal("accept"), newRecipient: z.object({ firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80) }).strict() }).strict(),
]);

export async function receiveTransfer(t: z.infer<typeof InboundTransfer>): Promise<string> {
  return (await sql<{ r: string }>`SELECT public.app_connect_transfer_receive(${t.id}::uuid, ${t.connectProviderRef}::uuid, ${t.acuerdoId}::uuid, ${t.familyRef}::uuid, ${JSON.stringify(t.payload)}::jsonb) AS r`.execute(db)).rows[0].r;
}
export async function withdrawTransfer(t: z.infer<typeof Withdraw>): Promise<string> {
  return (await sql<{ r: string }>`SELECT public.app_connect_transfer_withdraw(${t.id}::uuid, ${t.connectProviderRef}::uuid) AS r`.execute(db)).rows[0].r;
}
export async function listTransfers(userId: string, organizationId: string): Promise<unknown[]> {
  try {
    return await withTenantContext({ userId, organizationId }, async (trx) => (await sql<{ l: unknown[] }>`SELECT public.app_connect_transfers_list() AS l`.execute(trx)).rows[0].l);
  } catch (e) { return translate(e); }
}
export async function decideTransfer(userId: string, organizationId: string, transferId: string, d: z.infer<typeof Decide>) {
  try {
    const r = await withTenantContext({ userId, organizationId }, async (trx) => {
      if (d.decision === "reject") return (await sql<{ r: unknown }>`SELECT public.app_connect_transfer_decide(${transferId}::uuid, 'reject', NULL, ${d.reason}) AS r`.execute(trx)).rows[0].r;
      let recipient = "recipientId" in d ? d.recipientId : null;
      if (!recipient && "newRecipient" in d) {
        await assertOrgManager(trx);
        // Misma vía (y mismas políticas) que crear una persona atendida a mano; en la MISMA transacción que la decisión.
        recipient = (await sql<{ id: string }>`INSERT INTO care_recipients (organization_id, first_name, last_name)
          VALUES (${organizationId}, ${d.newRecipient.firstName}, ${d.newRecipient.lastName}) RETURNING id`.execute(trx)).rows[0].id;
      }
      return (await sql<{ r: unknown }>`SELECT public.app_connect_transfer_decide(${transferId}::uuid, 'accept', ${recipient}::uuid, NULL) AS r`.execute(trx)).rows[0].r;
    });
    kickConnectOutbox();
    return r;
  } catch (e) { return translate(e); }
}
