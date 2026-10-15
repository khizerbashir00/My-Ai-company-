import { TaskStatus } from '../generated/prisma/enums';
import { ACTIVE_STATUSES, TASK_TRANSITIONS, canTransition, checkTransition, isTerminal } from './task-state-machine';

const ctx = { attempts: 0, maxAttempts: 3, unmetDependencies: 0 };
const ALL = Object.values(TaskStatus);

describe('task state machine', () => {
  it('defines transitions for every status', () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it('allows the normal happy path', () => {
    expect(checkTransition('QUEUED', 'RUNNING', ctx).ok).toBe(true);
    expect(checkTransition('RUNNING', 'AWAITING_APPROVAL', ctx).ok).toBe(true);
    expect(checkTransition('AWAITING_APPROVAL', 'RUNNING', ctx).ok).toBe(true);
    expect(checkTransition('RUNNING', 'COMPLETED', ctx).ok).toBe(true);
  });

  it('treats COMPLETED and CANCELLED as terminal', () => {
    for (const to of ALL) {
      expect(canTransition('COMPLETED', to)).toBe(false);
      expect(canTransition('CANCELLED', to)).toBe(false);
    }
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(false);
  });

  it('allows cancelling from every active state and from FAILED', () => {
    for (const from of [...ACTIVE_STATUSES, 'FAILED' as const]) {
      expect(canTransition(from, 'CANCELLED')).toBe(true);
    }
  });

  it('rejects skipping straight from QUEUED to COMPLETED', () => {
    const res = checkTransition('QUEUED', 'COMPLETED', ctx);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/Cannot move/);
  });

  it('rejects a no-op transition', () => {
    expect(checkTransition('RUNNING', 'RUNNING', ctx).ok).toBe(false);
  });

  it('enforces the retry limit', () => {
    expect(checkTransition('FAILED', 'QUEUED', { ...ctx, attempts: 2 }).ok).toBe(true);
    const blocked = checkTransition('FAILED', 'QUEUED', { ...ctx, attempts: 3 });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/Retry limit/);
  });

  it('blocks starting a task with unfinished dependencies', () => {
    const res = checkTransition('QUEUED', 'RUNNING', { ...ctx, unmetDependencies: 2 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/2 unfinished dependencies/);
  });

  it('requires a reason when failing a task', () => {
    expect(checkTransition('RUNNING', 'FAILED', ctx).ok).toBe(false);
    expect(checkTransition('RUNNING', 'FAILED', { ...ctx, message: '  ' }).ok).toBe(false);
    expect(checkTransition('RUNNING', 'FAILED', { ...ctx, message: 'Source API returned 503' }).ok).toBe(true);
  });
});
