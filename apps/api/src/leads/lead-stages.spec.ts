import { canTransitionStage } from './lead-stages';

describe('lead stage transitions', () => {
  it('allows NEW → QUALIFIED', () => {
    expect(canTransitionStage('NEW', 'QUALIFIED')).toEqual({ ok: true });
  });

  it('blocks WON → anything', () => {
    expect(canTransitionStage('WON', 'NEGOTIATION').ok).toBe(false);
  });

  it('blocks DO_NOT_CONTACT reopen via arbitrary stages', () => {
    expect(canTransitionStage('DO_NOT_CONTACT', 'NEW').ok).toBe(false);
  });

  it('allows LOST → NEW reopen', () => {
    expect(canTransitionStage('LOST', 'NEW')).toEqual({ ok: true });
  });
});
