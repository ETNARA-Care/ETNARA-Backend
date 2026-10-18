import { describe, expect, it } from 'vitest';
import { parseTowerAiRequest, runTowerAiPilot } from '../src/modules/etnaraTower/towerAiPilot.js';

describe('Tower AI advisory pilot', () => {
  it('accepts only LEO, ORION and AXEL', () => {
    for (const agentId of ['technology-2','technology-3','technology-4']) {
      expect(parseTowerAiRequest({agentId,question:'What should we investigate next?'})).not.toBeNull();
    }
    expect(parseTowerAiRequest({agentId:'executive-1',question:'What should we investigate next?'})).toBeNull();
  });
  it('rejects invalid input, oversized questions and unexpected keys', () => {
    expect(parseTowerAiRequest({agentId:'technology-2',question:'short'})).toBeNull();
    expect(parseTowerAiRequest({agentId:'technology-2',question:'x'.repeat(1501)})).toBeNull();
    expect(parseTowerAiRequest({agentId:'technology-2',question:'Investigate backend errors',execute:true})).toBeNull();
    expect(parseTowerAiRequest([])).toBeNull();
  });
  it('is disabled without explicit configuration', async () => {
    const before = process.env.TOWER_AI_ENABLED;
    process.env.TOWER_AI_ENABLED = 'false';
    try { expect(await runTowerAiPilot({agentId:'technology-2',question:'Investigate backend errors'})).toBeNull(); }
    finally { if (before === undefined) delete process.env.TOWER_AI_ENABLED; else process.env.TOWER_AI_ENABLED = before; }
  });
});
