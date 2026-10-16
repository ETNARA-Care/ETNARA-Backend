import { sql } from 'kysely';
import { withPlatformContext } from '../../context/tenantContext.js';

export interface TaskAuditRow {
  id: string;
  task_id: string;
  from_status: string;
  to_status: string;
  actor_id: string;
  occurred_at: Date | string;
  reason: string | null;
}

/** Read audit history using the authenticated platform-admin context and database RLS. */
export async function listTaskAuditForAdmin(userId: string, taskId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) return null;
  return withPlatformContext(userId, async trx => {
    const task = await sql<{id: string}>`SELECT id FROM tower_corporate_tasks WHERE id = ${taskId}`.execute(trx);
    if (!task.rows[0]) return null;
    const events = await sql<TaskAuditRow>`SELECT id, task_id, from_status, to_status, actor_id, occurred_at, reason FROM tower_corporate_task_audit WHERE task_id = ${taskId} ORDER BY occurred_at ASC, id ASC LIMIT 100`.execute(trx);
    return events.rows.map(event => ({ id: event.id, taskId: event.task_id, fromStatus: event.from_status, toStatus: event.to_status, actorId: event.actor_id, occurredAt: new Date(event.occurred_at).toISOString(), reason: event.reason }));
  });
}
