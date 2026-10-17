import { estimateUsd } from './ai-usage';

describe('estimateUsd', () => {
  it('returns ESTIMATE for known models', () => {
    const r = estimateUsd('gpt-4o-mini', 1_000_000, 1_000_000);
    expect(r.kind).toBe('ESTIMATE');
    expect(r.estimatedUsd).toBeCloseTo(0.75, 5);
    expect(r.rateSource).toBeTruthy();
  });

  it('returns UNAVAILABLE without inventing a price', () => {
    const r = estimateUsd('mystery-model-xyz', 1000, 1000);
    expect(r.kind).toBe('UNAVAILABLE');
    expect(r.estimatedUsd).toBeNull();
  });
});
