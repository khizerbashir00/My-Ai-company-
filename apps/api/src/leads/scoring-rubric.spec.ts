import { labelForScore, RUBRIC_MAX_SCORE, SCORING_CRITERIA, validateCriterionScores } from './scoring-rubric';

describe('scoring rubric', () => {
  it('sums to 100', () => {
    expect(RUBRIC_MAX_SCORE).toBe(100);
    expect(SCORING_CRITERIA.reduce((s, c) => s + c.max, 0)).toBe(100);
  });

  it('labels scores', () => {
    expect(labelForScore(80)).toBe('HIGH');
    expect(labelForScore(60)).toBe('MEDIUM');
    expect(labelForScore(30)).toBe('LOW');
    expect(labelForScore(10)).toBe('NEEDS_REVIEW');
  });

  it('accepts a full criterion set', () => {
    const result = validateCriterionScores(
      SCORING_CRITERIA.map((c) => ({ key: c.key, score: Math.min(5, c.max), reason: 'ok' })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.total).toBeGreaterThan(0);
  });

  it('rejects scores above the criterion max', () => {
    const result = validateCriterionScores(
      SCORING_CRITERIA.map((c) => ({ key: c.key, score: c.max + 1, reason: 'too high' })),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects missing criteria', () => {
    const result = validateCriterionScores([
      { key: 'buying_intent', score: 10, reason: 'explicit ask' },
    ]);
    expect(result.ok).toBe(false);
  });
});
