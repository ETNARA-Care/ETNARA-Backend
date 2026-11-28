import { sql } from "kysely";
import { db } from "../../config/db.js";
import { withTenantContext } from "../../context/tenantContext.js";
import { sha256Hex } from "./connect.signing.js";
import { newLinkCode, normalizeCode } from "./connect.codes.js";

export { newLinkCode, normalizeCode };

/**
 * 181 · Vínculo Care ↔ Connect. La base decide (funciones SECURITY DEFINER); aquí solo se genera el código, se
 * normaliza y se traducen los errores. Ninguna función devuelve personas, residentes ni montos.
 */
export class ConnectError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); this.name = "ConnectError"; }
}
const DB_ERRORS: Record<string, number> = {
  CONNECT_ORG_ADMIN_REQUIRED: 403, CONNECT_ORG_SUSPENDED: 409, CONNECT_NOT_LINKED: 404, CONNECT_CODE_INVALID: 404,
  CONNECT_PROVIDER_ALREADY_LINKED: 409, CONNECT_ORG_ALREADY_LINKED: 409, CONNECT_MEMBERSHIP_REQUIRED: 403, CONNECT_ORG_TYPE_NOT_ALLOWED: 409,
};
function translate(err: unknown): never {
  const message = err instanceof Error ? err.message : "";
  const code = Object.keys(DB_ERRORS).find((c) => message.includes(c));
  if (code) throw new ConnectError(code, DB_ERRORS[code]);
  throw err;
}

export async function createLinkCode(userId: string, organizationId: string): Promise<{ code: string; expiresAt: string }> {
  const code = newLinkCode();
  try {
    const exp = await withTenantContext({ userId, organizationId }, async (trx) =>
      (await sql<{ e: Date }>`SELECT public.app_connect_create_link_code(${sha256Hex(normalizeCode(code))}) AS e`.execute(trx)).rows[0].e);
    return { code, expiresAt: new Date(exp).toISOString() };
  } catch (e) { return translate(e); }
}

export async function linkStatus(userId: string, organizationId: string): Promise<{ linked: boolean; linkedAt: string | null }> {
  try {
    return await withTenantContext({ userId, organizationId }, async (trx) =>
      (await sql<{ s: { linked: boolean; linkedAt: string | null } }>`SELECT public.app_connect_link_status() AS s`.execute(trx)).rows[0].s);
  } catch (e) { return translate(e); }
}

export async function unlink(userId: string, organizationId: string): Promise<void> {
  try {
    await withTenantContext({ userId, organizationId }, async (trx) => { await sql`SELECT public.app_connect_unlink()`.execute(trx); });
  } catch (e) { translate(e); }
}

export type OrgFacts = { organizationId: string; type: "agencia" | "independiente" | "hogar"; active: boolean; suspended: boolean;
  contractSatisfied: boolean; subscriptionOrder: boolean; connectProviderRef: string | null };

/** Servidor a servidor (Connect ya autenticado por el token de servicio). */
export async function redeemLinkCode(code: string, connectProviderRef: string): Promise<OrgFacts> {
  try {
    return (await sql<{ f: OrgFacts }>`SELECT public.app_connect_redeem_link_code(${sha256Hex(normalizeCode(code))}, ${connectProviderRef}) AS f`.execute(db)).rows[0].f;
  } catch (e) { return translate(e); }
}

export async function statusByRef(connectProviderRef: string): Promise<OrgFacts | null> {
  return (await sql<{ f: OrgFacts | null }>`SELECT public.app_connect_status_by_ref(${connectProviderRef}) AS f`.execute(db)).rows[0]?.f ?? null;
}

export type LoginFacts = { careUserId: string; email: string; organizationId: string; connectProviderRef: string };
/** C-1 · Hechos para entrar en Connect con la cuenta de Care (persona de la sesión, organización activa vinculada). */
export async function loginFacts(userId: string, organizationId: string): Promise<LoginFacts> {
  try {
    return await withTenantContext({ userId, organizationId }, async (trx) =>
      (await sql<{ f: LoginFacts }>`SELECT public.app_connect_login_facts() AS f`.execute(trx)).rows[0].f);
  } catch (e) { return translate(e); }
}
