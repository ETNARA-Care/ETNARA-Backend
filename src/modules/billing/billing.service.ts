import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { recordFinanceEvent, recordFinancialAudit } from "../finance/financeEvents.js";

/**
 * Facturación Premium F2.1 — access and permissions. FACTURACION is a separate
 * premium switch that requires FINANZAS (migration 123). Capabilities: view,
 * draft, issue, void, manage; only agency administrators can hold them. Every
 * rule is also enforced by the database (app_billing_can + RLS + guard).
 */

export type Trx = Parameters<Parameters<typeof withTenantContext>[1]>[0];

export class BillingError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
    this.name = "BillingError";
  }
}

export const CAPABILITIES = ["view", "draft", "issue", "void", "manage"] as const;
export type Capability = (typeof CAPABILITIES)[number];
const uuid = z.string().uuid();
export const grantSchema = z.object({ membershipId: uuid, capability: z.enum(CAPABILITIES), reason: z.string().trim().min(3).max(300) });
export const revokeSchema = z.object({ reason: z.string().trim().min(3).max(300) });

export interface BillingModuleState { finanzas: boolean; facturacion: boolean; enabled: boolean; readOnly: boolean }

async function moduleState(trx: Trx, organizationId: string): Promise<BillingModuleState> {
  const r = (await sql<{ finanzas: boolean; facturacion: boolean; admin: boolean }>`
    SELECT app_org_feature_enabled(${organizationId}::uuid, 'FINANZAS') AS finanzas,
           app_org_feature_enabled(${organizationId}::uuid, 'FACTURACION') AS facturacion,
           app_is_org_admin() AS admin`.execute(trx)).rows[0];
  const enabled = r.finanzas && r.facturacion;
  return { finanzas: r.finanzas, facturacion: r.facturacion, enabled, readOnly: !enabled };
}

/** Capabilities of the current session (the database decides; view also in read-only mode). */
export async function myCapabilities(trx: Trx, organizationId: string): Promise<Capability[]> {
  const r = (await sql<Record<Capability, boolean>>`
    SELECT app_billing_can(${organizationId}::uuid, 'view') AS view, app_billing_can(${organizationId}::uuid, 'draft') AS draft,
           app_billing_can(${organizationId}::uuid, 'issue') AS issue, app_billing_can(${organizationId}::uuid, 'void') AS void,
           app_billing_can(${organizationId}::uuid, 'manage') AS manage`.execute(trx)).rows[0];
  return CAPABILITIES.filter((c) => r[c]);
}

/** At least one of the capabilities (reads: view, or draft to work on drafts). */
export async function requireAnyCapability(trx: Trx, organizationId: string, capabilities: Capability[]): Promise<Capability> {
  for (const c of capabilities) {
    const ok = (await sql<{ ok: boolean }>`SELECT app_billing_can(${organizationId}::uuid, ${c}) AS ok`.execute(trx)).rows[0]?.ok;
    if (ok) return c;
  }
  const state = await moduleState(trx, organizationId);
  if (!state.finanzas && !state.facturacion) throw new BillingError("FEATURE_NOT_ENABLED", 404);
  throw new BillingError("BILLING_FORBIDDEN", 403);
}

export async function requireCapability(trx: Trx, organizationId: string, capability: Capability): Promise<void> {
  const state = await moduleState(trx, organizationId);
  const ok = (await sql<{ ok: boolean }>`SELECT app_billing_can(${organizationId}::uuid, ${capability}) AS ok`.execute(trx)).rows[0]?.ok;
  if (ok) return;
  if (capability !== "view" && !state.enabled) throw new BillingError(state.facturacion || state.finanzas ? "BILLING_READ_ONLY" : "FEATURE_NOT_ENABLED", state.facturacion ? 409 : 404);
  throw new BillingError("BILLING_FORBIDDEN", 403);
}

export function inBilling<T>(userId: string, organizationId: string, work: (trx: Trx) => Promise<T>): Promise<T> {
  return withTenantContext({ userId, organizationId }, work);
}

export function mapDbError(error: unknown): never {
  const e = error as { code?: string; message?: string };
  const known: Record<string, number> = {
    LAST_PERMISSION_MANAGER: 409, BILLING_PERMISSION_ADMIN_ONLY: 409, BILLING_PERMISSION_IMMUTABLE: 409,
    BILLING_PERMISSION_NO_DELETE: 409, BILLING_FORBIDDEN: 403,
  };
  const hit = Object.keys(known).find((k) => e?.message?.includes(k));
  if (hit) throw new BillingError(hit, known[hit]);
  if (e?.code === "23505") throw new BillingError("BILLING_PERMISSION_EXISTS", 409);
  if (e?.code === "23503") throw new BillingError("BILLING_MEMBER_NOT_FOUND", 404);
  if (e?.code === "42501") throw new BillingError("BILLING_FORBIDDEN", 403);
  if (e?.code === "40P01" || e?.code === "40001") throw new BillingError("BILLING_CONCURRENT_CHANGE", 409);
  throw error;
}

export async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { if (error instanceof BillingError) throw error; return mapDbError(error); }
}

/**
 * What the portal needs to decide what to show: module state and my
 * capabilities. Agency administrators only (supervisors and others: 403, the
 * module is never revealed to them). Works with the module off.
 */
export async function getAccess(userId: string, organizationId: string) {
  return inBilling(userId, organizationId, async (trx) => {
    const state = await moduleState(trx, organizationId);
    const admin = (await sql<{ a: boolean }>`SELECT app_is_org_admin() AS a`.execute(trx)).rows[0]?.a === true;
    if (!admin) throw new BillingError("BILLING_FORBIDDEN", 403);
    return { module: state, capabilities: await myCapabilities(trx, organizationId) };
  });
}

export async function listPermissions(userId: string, organizationId: string) {
  return inBilling(userId, organizationId, (trx) => guarded(async () => {
    await requireCapability(trx, organizationId, "view");
    const admins = await sql<{ membership_id: string; email: string; is_me: boolean; capabilities: Capability[] }>`
      SELECT membership_id, email, is_me, capabilities FROM app_billing_admins(${organizationId}::uuid)`.execute(trx);
    const grants = await sql<{ id: string; membership_id: string; capability: Capability; grant_source: string; grant_reason: string;
      granted_at: string; granted_by_email: string | null; revoked_at: string | null; revoke_reason: string | null; revoked_by_email: string | null }>`
      SELECT p.id, p.membership_id, p.capability, p.grant_source, p.grant_reason, p.granted_at, gu.email AS granted_by_email,
             p.revoked_at, p.revoke_reason, ru.email AS revoked_by_email
      FROM billing_permissions p
      LEFT JOIN users gu ON gu.id = p.granted_by_user_id
      LEFT JOIN users ru ON ru.id = p.revoked_by_user_id
      WHERE p.organization_id = ${organizationId}
      ORDER BY p.granted_at DESC LIMIT 300`.execute(trx);
    return {
      module: await moduleState(trx, organizationId),
      canManage: (await myCapabilities(trx, organizationId)).includes("manage"),
      admins: admins.rows.map((a) => ({ membershipId: a.membership_id, email: a.email, isMe: a.is_me, capabilities: a.capabilities })),
      history: grants.rows,
    };
  }));
}

export async function grantPermission(userId: string, organizationId: string, input: z.infer<typeof grantSchema>) {
  return inBilling(userId, organizationId, (trx) => guarded(async () => {
    await requireCapability(trx, organizationId, "manage");
    const row = (await sql<{ id: string; membership_id: string; capability: string }>`
      INSERT INTO billing_permissions (organization_id, membership_id, capability, grant_source, grant_reason, granted_by_user_id)
      VALUES (${organizationId}, ${input.membershipId}, ${input.capability}, 'manual', ${input.reason}, ${userId})
      RETURNING id, membership_id, capability`.execute(trx)).rows[0];
    await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_BILLING_PERMISSION_GRANTED", entityType: "billing_permission", entityId: row.id, newValue: { ...row, reason: input.reason } });
    await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_BILLING_PERMISSION_GRANTED", entityType: "billing_permission", entityId: row.id });
    return row;
  }));
}

export async function revokePermission(userId: string, organizationId: string, permissionId: string, input: z.infer<typeof revokeSchema>) {
  return inBilling(userId, organizationId, (trx) => guarded(async () => {
    // Revocations in one agency run one at a time (same key as the database
    // guard), and the actor's own "manage" is checked AFTER waiting: two
    // managers revoking each other at once cannot both succeed.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'billing-manage', ${organizationId}::text), 123))`.execute(trx);
    await requireCapability(trx, organizationId, "manage");
    const before = (await sql<{ id: string; membership_id: string; capability: string; revoked_at: string | null }>`
      SELECT id, membership_id, capability, revoked_at FROM billing_permissions
      WHERE id = ${permissionId} AND organization_id = ${organizationId} FOR UPDATE`.execute(trx)).rows[0];
    if (!before) throw new BillingError("BILLING_PERMISSION_NOT_FOUND", 404);
    if (before.revoked_at) throw new BillingError("BILLING_PERMISSION_ALREADY_REVOKED", 409);
    const after = (await sql<{ id: string; revoked_at: string }>`
      UPDATE billing_permissions SET revoked_at = now(), revoked_by_user_id = ${userId}, revoke_reason = ${input.reason}
      WHERE id = ${permissionId} AND organization_id = ${organizationId} RETURNING id, revoked_at`.execute(trx)).rows[0];
    if (!after) throw new BillingError("BILLING_FORBIDDEN", 403); // row policy refused it: never report a revocation that did not happen
    await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action: "FINANCE_BILLING_PERMISSION_REVOKED", entityType: "billing_permission", entityId: permissionId, previousValue: before, newValue: { ...after, reason: input.reason } });
    await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action: "FINANCE_BILLING_PERMISSION_REVOKED", entityType: "billing_permission", entityId: permissionId });
    return after;
  }));
}
