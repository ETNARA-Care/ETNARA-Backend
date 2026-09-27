import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";

export class EstablishmentManagementForbiddenError extends Error {
  constructor() {
    super("ESTABLISHMENT_MANAGEMENT_FORBIDDEN");
    this.name = "EstablishmentManagementForbiddenError";
  }
}

export class EstablishmentNotFoundError extends Error {
  constructor() {
    super("ESTABLISHMENT_NOT_FOUND");
    this.name = "EstablishmentNotFoundError";
  }
}

export const createEstablishmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(500).optional(),
});

export const updateEstablishmentSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    address: z.string().trim().max(500).nullable().optional(),
    status: z.enum(["active", "archived"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "At least one field required" });

type CreateEstablishmentInput = z.infer<typeof createEstablishmentSchema>;
type UpdateEstablishmentInput = z.infer<typeof updateEstablishmentSchema>;

interface EstablishmentRow {
  id: string;
  organization_id: string;
  name: string;
  address: string | null;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
}

async function assertManager(trx: Parameters<Parameters<typeof withTenantContext>[1]>[0]) {
  const result = await sql<{ is_manager: boolean }>`SELECT app_is_org_manager() AS is_manager`.execute(trx);
  if (!result.rows[0]?.is_manager) throw new EstablishmentManagementForbiddenError();
}

export function listEstablishments(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const result = await sql<EstablishmentRow>`
      SELECT id, organization_id, name, address,
             CASE WHEN archived_at IS NULL THEN 'active' ELSE 'archived' END AS status,
             created_at, updated_at
      FROM locations
      WHERE organization_id = ${organizationId}
      ORDER BY archived_at NULLS FIRST, name
    `.execute(trx);
    return result.rows;
  });
}

export function createEstablishment(
  userId: string,
  organizationId: string,
  input: CreateEstablishmentInput
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const result = await sql<EstablishmentRow>`
      INSERT INTO locations (organization_id, name, address)
      VALUES (${organizationId}, ${input.name}, ${input.address || null})
      RETURNING id, organization_id, name, address, 'active'::text AS status, created_at, updated_at
    `.execute(trx);
    const establishment = result.rows[0];
    await sql`
      INSERT INTO audit_log (
        actor_user_id, organization_id, target_organization_id, action,
        entity_type, entity_id, new_value
      ) VALUES (
        ${userId}, ${organizationId}, ${organizationId}, 'ESTABLISHMENT_CREATED',
        'location', ${establishment.id},
        jsonb_build_object(
          'name', ${establishment.name}::text,
          'address', ${establishment.address}::text
        )
      )
    `.execute(trx);
    return establishment;
  });
}

export function updateEstablishment(
  userId: string,
  organizationId: string,
  establishmentId: string,
  input: UpdateEstablishmentInput
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const currentResult = await sql<EstablishmentRow>`
      SELECT id, organization_id, name, address,
             CASE WHEN archived_at IS NULL THEN 'active' ELSE 'archived' END AS status,
             created_at, updated_at
      FROM locations
      WHERE id = ${establishmentId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    const current = currentResult.rows[0];
    if (!current) throw new EstablishmentNotFoundError();

    const fragments = [];
    if (input.name !== undefined) fragments.push(sql`name = ${input.name}`);
    if (input.address !== undefined) fragments.push(sql`address = ${input.address || null}`);
    if (input.status !== undefined) {
      fragments.push(input.status === "archived" ? sql`archived_at = now()` : sql`archived_at = NULL`);
    }
    fragments.push(sql`updated_at = now()`);

    const result = await sql<EstablishmentRow>`
      UPDATE locations
      SET ${sql.join(fragments, sql`, `)}
      WHERE id = ${establishmentId} AND organization_id = ${organizationId}
      RETURNING id, organization_id, name, address,
                CASE WHEN archived_at IS NULL THEN 'active' ELSE 'archived' END AS status,
                created_at, updated_at
    `.execute(trx);
    const establishment = result.rows[0];
    if (!establishment) throw new EstablishmentNotFoundError();

    await sql`
      INSERT INTO audit_log (
        actor_user_id, organization_id, target_organization_id, action,
        entity_type, entity_id, previous_value, new_value
      ) VALUES (
        ${userId}, ${organizationId}, ${organizationId}, 'ESTABLISHMENT_UPDATED',
        'location', ${establishmentId},
        ${JSON.stringify(current)}::jsonb, ${JSON.stringify(establishment)}::jsonb
      )
    `.execute(trx);
    return establishment;
  });
}
