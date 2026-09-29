import { sql } from "kysely";
import { z } from "zod";
import { withPlatformContext } from "../../context/tenantContext.js";

export const createPlatformOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(160),
  organizationType: z.enum(["HOME_CARE_AGENCY", "RESIDENTIAL_CARE_HOME"]),
  status: z.enum(["trial", "active"]).default("trial"),
});

export type CreatePlatformOrganizationInput = z.infer<typeof createPlatformOrganizationSchema>;

export async function listPlatformOrganizations(userId: string) {
  return withPlatformContext(userId, async (trx) => {
    const result = await sql<{
      id: string; name: string; organization_type: string; status: string; created_at: Date;
    }>`SELECT id,name,organization_type,status,created_at FROM organizations WHERE archived_at IS NULL ORDER BY created_at DESC`.execute(trx);
    return result.rows;
  });
}

export async function createPlatformOrganization(userId: string, input: CreatePlatformOrganizationInput) {
  return withPlatformContext(userId, async (trx) => {
    const created = await sql<{
      id: string; name: string; organization_type: string; status: string; created_at: Date;
    }>`
      INSERT INTO organizations (name, organization_type, status)
      VALUES (${input.name}, ${input.organizationType}::organization_type_enum, ${input.status}::organization_status_enum)
      RETURNING id,name,organization_type,status,created_at
    `.execute(trx);
    const organization = created.rows[0];
    await sql`INSERT INTO organization_settings (organization_id) VALUES (${organization.id})`.execute(trx);
    return organization;
  });
}
