import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withPlatformContext } from '../../context/tenantContext.js';
import { parseTaskReview } from './corporateTaskReviewInput.js';
import type { CorporateTaskStatus } from './corporateTaskPolicy.js';

export async function reviewCorporateTask(userId: string, taskId: string, input: unknown): Promise<'updated' | 'not_found' | 'conflict' | 'invalid'> {
  const change = parseTaskReview(input);
  if (!change || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) return 'invalid';
  return withPlatformContext(userId, async trx => {
    const found = await sql<{status: CorporateTaskStatus}>`SELECT status FROM tower_corporate_tasks WHERE id = ${taskId} FOR UPDATE`.execute(trx);
    if (!found.rows[0]) return 'not_found';
    if (found.rows[0].status !== change.expectedStatus) return 'conflict';
    await sql`UPDATE tower_corporate_tasks SET status = ${change.nextStatus}, updated_at = now() WHERE id = ${taskId}`.execute(trx);
    await sql`INSERT INTO tower_corporate_task_audit (id, task_id, from_status, to_status, actor_id, reason) VALUES (${randomUUID()}, ${taskId}, ${change.expectedStatus}, ${change.nextStatus}, ${userId}, ${change.reason ?? null})`.execute(trx);
    return 'updated';
  });
}
