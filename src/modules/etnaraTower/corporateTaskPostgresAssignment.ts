import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withPlatformContext } from '../../context/tenantContext.js';
import { TOWER_CORPORATE_AGENTS } from './corporateRoster.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function reassignCorporateTask(userId: string, taskId: string, input: unknown): Promise<'updated'|'invalid'|'not_found'|'conflict'> {
  if (!uuid.test(taskId) || !input || typeof input !== 'object' || Array.isArray(input)) return 'invalid';
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['expectedAgentId','nextAgentId','reason'].includes(key)) ||
    typeof value.expectedAgentId !== 'string' || typeof value.nextAgentId !== 'string' ||
    typeof value.reason !== 'string' || value.reason.trim().length < 5 || value.reason.trim().length > 500 ||
    !TOWER_CORPORATE_AGENTS.some(agent => agent.id === value.nextAgentId) ||
    !TOWER_CORPORATE_AGENTS.some(agent => agent.id === value.expectedAgentId) ||
    value.expectedAgentId === value.nextAgentId) return 'invalid';
  return withPlatformContext(userId, async trx => {
    const current = await sql<{agent_id:string;status:string}>`SELECT agent_id, status FROM tower_corporate_tasks WHERE id = ${taskId} FOR UPDATE`.execute(trx);
    const task = current.rows[0];
    if (!task) return 'not_found';
    if (task.agent_id !== value.expectedAgentId || !['draft','submitted','in_review'].includes(task.status)) return 'conflict';
    await sql`UPDATE tower_corporate_tasks SET agent_id = ${value.nextAgentId as string}, updated_at = now() WHERE id = ${taskId}`.execute(trx);
    await sql`INSERT INTO tower_corporate_task_assignments (id, task_id, from_agent_id, to_agent_id, actor_id, reason)
      VALUES (${randomUUID()}, ${taskId}, ${task.agent_id}, ${value.nextAgentId as string}, ${userId}, ${value.reason.trim()})`.execute(trx);
    return 'updated';
  });
}
export async function listCorporateTaskAssignments(userId: string, taskId: string) {
  if (!uuid.test(taskId)) return null;
  return withPlatformContext(userId, async trx => {
    const found = await sql<{id:string}>`SELECT id FROM tower_corporate_tasks WHERE id = ${taskId}`.execute(trx);
    if (!found.rows[0]) return null;
    const events = await sql<{id:string;from_agent_id:string;to_agent_id:string;actor_id:string;reason:string;occurred_at:Date|string}>`
      SELECT id, from_agent_id, to_agent_id, actor_id, reason, occurred_at FROM tower_corporate_task_assignments
      WHERE task_id = ${taskId} ORDER BY occurred_at DESC, id DESC LIMIT 100`.execute(trx);
    return events.rows.map(event => ({id:event.id,fromAgentId:event.from_agent_id,toAgentId:event.to_agent_id,actorId:event.actor_id,reason:event.reason,occurredAt:new Date(event.occurred_at).toISOString()}));
  });
}
