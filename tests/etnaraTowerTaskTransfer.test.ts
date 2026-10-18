import { describe, expect, it } from 'vitest';
import { isCorporateTaskTransferable, parseCorporateTaskTransfer } from '../src/modules/etnaraTower/corporateTaskTransferPolicy.js';

const valid = { expectedAgentId: 'technology-2', nextAgentId: 'technology-3', reason: 'Redistribuir carga de trabajo' };
describe('ETNARA Tower reassignment policy', () => {
  it('accepts two roster agents and a meaningful reason', () => {
    expect(parseCorporateTaskTransfer(valid)).toEqual(valid);
    expect(parseCorporateTaskTransfer({...valid, reason: '  Redistribuir carga de trabajo  '})?.reason).toBe(valid.reason);
  });
  it('rejects unknown agents, same-agent transfers and extra fields', () => {
    expect(parseCorporateTaskTransfer({...valid, nextAgentId: 'unknown'})).toBeNull();
    expect(parseCorporateTaskTransfer({...valid, expectedAgentId: 'unknown'})).toBeNull();
    expect(parseCorporateTaskTransfer({...valid, nextAgentId: valid.expectedAgentId})).toBeNull();
    expect(parseCorporateTaskTransfer({...valid, actorId: 'spoof'})).toBeNull();
  });
  it('rejects invalid payload shapes and reasons', () => {
    for (const input of [null, [], 'invalid', {...valid, reason: 'x'}, {...valid, reason: 'x'.repeat(501)}, {...valid, reason: 7}]) {
      expect(parseCorporateTaskTransfer(input)).toBeNull();
    }
  });
  it('permits only pre-approval task statuses', () => {
    for (const status of ['draft','submitted','in_review']) expect(isCorporateTaskTransferable(status)).toBe(true);
    for (const status of ['approved','rejected','completed','unknown']) expect(isCorporateTaskTransferable(status)).toBe(false);
  });
});
