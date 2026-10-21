import { describe, expect, it } from 'vitest';
import { smartMatchPublishSchema } from '../src/modules/smartmatch/smartmatch.schemas.js';

describe('SmartMatch publication', () => {
  it('accepts valid service hours', () => {
    const result = smartMatchPublishSchema.safeParse({
      visibility: 'INTERNAL',
      startsAt: '2026-11-01T12:00:00Z',
      endsAt: '2026-11-01T20:00:00Z',
      roleLabel: 'Caregiver',
      regionLabel: 'Carolina',
    });
    expect(result.success).toBe(true);
  });
});
