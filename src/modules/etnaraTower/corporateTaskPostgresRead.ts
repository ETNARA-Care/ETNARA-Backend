import { sql } from "kysely";
import { withPlatformContext } from "../../context/tenantContext.js";
import { normalizeCorporateTaskLimit, type CorporateTaskRecord } from "./corporateTaskRepository.js";
import { TOWER_CORPORATE_AGENTS } from "./corporateRoster.js";

type TaskRow = {
  id: string; agent_id: string; title: string; instructions: string;
  priority: CorporateTaskRecord["priority"]; status: CorporateTaskRecord["status"];
  created_by_platform_admin_id: string; created_at: Date | string; updated_at: Date | string;
};

function toRecord(row: TaskRow): CorporateTaskRecord {
  return {
    id: row.id, agentId: row.agent_id, title: row.title, instructions: row.instructions,
    priority: row.priority, status: row.status,
    createdByPlatformAdminId: row.created_by_platform_admin_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Real PostgreSQL read adapter, never a mock.
 * All reads occur inside a verified platform-admin transaction with database RLS.
 * No tenant/agency context or client-supplied actor identity is accepted.
 */
export async function listCorporateTasksForPlatformAdmin(
  authenticatedUserId: string,
  options: { agentId?: string; limit: number },
): Promise<readonly CorporateTaskRecord[]> {
  const limit = normalizeCorporateTaskLimit(options.limit);
  if (limit === null) throw new RangeError("Invalid task limit");
  if (options.agentId !== undefined &&
      !TOWER_CORPORATE_AGENTS.some(agent => agent.id === options.agentId)) {
    throw new RangeError("Unknown corporate agent");
  }
  return withPlatformContext(authenticatedUserId, async trx => {
    const result = options.agentId === undefined
      ? await sql<TaskRow>`
          SELECT id, agent_id, title, instructions, priority, status,
                 created_by_platform_admin_id, created_at, updated_at
          FROM tower_corporate_tasks
          ORDER BY created_at DESC, id DESC LIMIT ${limit}
        `.execute(trx)
      : await sql<TaskRow>`
          SELECT id, agent_id, title, instructions, priority, status,
                 created_by_platform_admin_id, created_at, updated_at
          FROM tower_corporate_tasks
          WHERE agent_id = ${options.agentId}
          ORDER BY created_at DESC, id DESC LIMIT ${limit}
        `.execute(trx);
    return result.rows.map(toRecord);
  });
}
