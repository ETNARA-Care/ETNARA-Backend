import { TOWER_CORPORATE_AGENTS } from './corporateRoster.js';

export interface CorporateTaskTransferInput { expectedAgentId: string; nextAgentId: string; reason: string }
export function parseCorporateTaskTransfer(input: unknown): CorporateTaskTransferInput | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['expectedAgentId','nextAgentId','reason'].includes(key)) ||
    typeof value.expectedAgentId !== 'string' || typeof value.nextAgentId !== 'string' ||
    typeof value.reason !== 'string') return null;
  const reason = value.reason.trim();
  if (reason.length < 5 || reason.length > 500 ||
    value.expectedAgentId === value.nextAgentId ||
    !TOWER_CORPORATE_AGENTS.some(agent => agent.id === value.expectedAgentId) ||
    !TOWER_CORPORATE_AGENTS.some(agent => agent.id === value.nextAgentId)) return null;
  return { expectedAgentId: value.expectedAgentId, nextAgentId: value.nextAgentId, reason };
}
export function isCorporateTaskTransferable(status: string): boolean {
  return status === 'draft' || status === 'submitted' || status === 'in_review';
}
