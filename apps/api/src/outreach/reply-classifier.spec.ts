import { classifyReplyHeuristic } from './reply-classifier';

describe('classifyReplyHeuristic', () => {
  it('detects unsubscribe', () => {
    expect(classifyReplyHeuristic('Please unsubscribe me from this list').classification).toBe('UNSUBSCRIBE');
  });

  it('detects demo request', () => {
    expect(classifyReplyHeuristic('Can we book a demo next week?').classification).toBe('DEMO_REQUEST');
  });

  it('detects positive interest', () => {
    expect(classifyReplyHeuristic('Sounds good — tell me more').classification).toBe('POSITIVE');
  });

  it('detects negative', () => {
    expect(classifyReplyHeuristic('Not interested, thanks').classification).toBe('NEGATIVE');
  });

  it('defaults to neutral without inventing commitments', () => {
    const r = classifyReplyHeuristic('Received, will look later.');
    expect(r.classification).toBe('NEUTRAL');
    expect(r.inventsCommitmentOrPricing).toBe(false);
  });
});
