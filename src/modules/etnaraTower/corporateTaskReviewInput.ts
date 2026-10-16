import { mayTransitionCorporateTask, type CorporateTaskStatus } from './corporateTaskPolicy.js';

export function parseTaskReview(value: unknown): { expectedStatus: CorporateTaskStatus; nextStatus: CorporateTaskStatus; reason?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(k => !['expectedStatus', 'nextStatus', 'reason'].includes(k))) return null;
  if (typeof data.expectedStatus !== 'string' || typeof data.nextStatus !== 'string') return null;
  if (!['draft', 'submitted', 'in_review', 'approved', 'rejected', 'completed'].includes(data.expectedStatus)) return null;
  if (!['submitted', 'in_review', 'approved', 'rejected'].includes(data.nextStatus)) return null;
  if (data.reason !== undefined && (typeof data.reason !== 'string' || data.reason.length > 1000)) return null;
  const expectedStatus = data.expectedStatus as CorporateTaskStatus;
  const nextStatus = data.nextStatus as CorporateTaskStatus;
  if (!mayTransitionCorporateTask({ from: expectedStatus, to: nextStatus, approvedByPlatformAdmin: true })) return null;
  return { expectedStatus, nextStatus, ...(data.reason === undefined ? {} : { reason: data.reason as string }) };
}
