import { describe, expect, it } from 'vitest';
import { parseTaskReview } from './corporateTaskReviewInput.js';

describe('corporate task review input', () => {
  it('accepts valid human approval flow', () => {
    expect(parseTaskReview({ expectedStatus: 'draft', nextStatus: 'submitted' })?.nextStatus).toBe('submitted');
    expect(parseTaskReview({ expectedStatus: 'submitted', nextStatus: 'in_review' })?.nextStatus).toBe('in_review');
    expect(parseTaskReview({ expectedStatus: 'in_review', nextStatus: 'approved', reason: 'Revisada' })?.reason).toBe('Revisada');
    expect(parseTaskReview({ expectedStatus: 'submitted', nextStatus: 'rejected' })?.nextStatus).toBe('rejected');
  });
  it('rejects unknown statuses without throwing', () => {
    expect(parseTaskReview({ expectedStatus: 'unknown', nextStatus: 'approved' })).toBeNull();
    expect(parseTaskReview({ expectedStatus: '__proto__', nextStatus: 'approved' })).toBeNull();
    expect(parseTaskReview({ expectedStatus: 'draft', nextStatus: 'approved' })).toBeNull();
  });
  it('disallows completed and extra fields', () => {
    expect(parseTaskReview({ expectedStatus: 'approved', nextStatus: 'completed' })).toBeNull();
    expect(parseTaskReview({ expectedStatus: 'in_review', nextStatus: 'approved', extra: true })).toBeNull();
    expect(parseTaskReview({ expectedStatus: 'in_review', nextStatus: 'approved', reason: 123 })).toBeNull();
  });
});
