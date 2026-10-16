import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { withPlatformContext } from "../../context/tenantContext.js";
import { parseCorporateTaskRequest } from "./corporateTaskInput.js";
import type { CorporateTaskRecord } from "./corporateTaskRepository.js";

type CreatedRow = {
  id: string; agent_id: string; title: string; instructions: string;
  priority: CorporateTaskRecord["priority"]; status: CorporateTaskRecord["status"];
  created_by_platform_admin_id: string; created_at: Date | string; updated_at: Date | string;
};

/** Inserts only draft tasks. No agent execution or approval occurs here. */
export async function createCorporateTaskForPlatformAdmin(
  authenticatedUserId: string,
  payload: unknown,
): Promise<CorporateTaskRecord | null> {
  const input = parseCorporateTaskRequest(payload);
  if (!input) return null;
  return withPlatformContext(authenticatedUserId, async trx => {
    const id = randomUUID();
    const result = await sql<CreatedRow>`
      INSERT INTO tower_corporate_tasks
        (id, agent_id, title, instructions, priority, status, created_by_platform_admin_id)
      VALUES
        (${id}, ${input.agentId}, ${input.title}, ${input.instructions},
         ${input.priority}, 'draft', ${authenticatedUserId})
      RETURNING id, agent_id, title, instructions, priority, status,
                created_by_platform_admin_id, created_at, updated_at
    `.execute(trx);
    const row = result.rows[0];
    if (!row) throw new Error("Corporate task insertion returned no row");
    return {
      id: row.id, agentId: row.agent_id, title: row.title,
      instructions: row.instructions, priority: row.priority, status: row.status,
      createdByPlatformAdminId: row.created_by_platform_admin_id,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  });
}
