import { describe, expect, it } from 'vitest';
import { reserveTowerAiRequest } from '../src/modules/etnaraTower/towerAiQuota.js';

describe('Tower AI per-admin quota', () => {
  it('allows ten requests per hour, then returns a retry time', () => {
    const id = 'quota-test-a';
    for (let n=0;n<10;n++) expect(reserveTowerAiRequest(id,1000000).allowed).toBe(true);
    const denied=reserveTowerAiRequest(id,1000000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(3600);
    expect(reserveTowerAiRequest(id,4600000).allowed).toBe(true);
  });
  it('isolates independent administrator quotas', () => {
    for (let n=0;n<10;n++) reserveTowerAiRequest('quota-test-b',1000000);
    expect(reserveTowerAiRequest('quota-test-c',1000000).allowed).toBe(true);
    expect(reserveTowerAiRequest('quota-test-b',1000001).allowed).toBe(false);
  });
});
