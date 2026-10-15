import type { TaskStatus } from '../generated/prisma/client';

/**
 * The only legal task status changes.
 *
 *   QUEUED ──► RUNNING ──► COMPLETED
 *     │          │  ▲
 *     │          ▼  │
 *     │   AWAITING_APPROVAL
 *     │          │
 *     │          ▼
 *     │        FAILED ──► QUEUED (retry, while attempts < maxAttempts)
 *     ▼
 *  CANCELLED  (reachable from every non-terminal state)
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['RUNNING', 'FAILED', 'CANCELLED'],
  FAILED: ['QUEUED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['COMPLETED', 'CANCELLED'];
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export interface TransitionCheck {
  ok: boolean;
  reason?: string;
}

export interface TransitionContext {
  attempts: number;
  maxAttempts: number;
  /** Dependencies that are not COMPLETED yet */
  unmetDependencies: number;
  message?: string;
}

/** Full rule check: legal edge plus business guards (retry limit, dependencies, failure reason). */
export function checkTransition(from: TaskStatus, to: TaskStatus, ctx: TransitionContext): TransitionCheck {
  if (from === to) return { ok: false, reason: `Task is already ${from}` };
  if (!canTransition(from, to)) {
    return { ok: false, reason: `Cannot move a task from ${from} to ${to}` };
  }
  if (from === 'FAILED' && to === 'QUEUED' && ctx.attempts >= ctx.maxAttempts) {
    return { ok: false, reason: `Retry limit reached (${ctx.attempts}/${ctx.maxAttempts}). Raise the limit to retry again.` };
  }
  if (to === 'RUNNING' && from === 'QUEUED' && ctx.unmetDependencies > 0) {
    return { ok: false, reason: `Waiting on ${ctx.unmetDependencies} unfinished dependenc${ctx.unmetDependencies === 1 ? 'y' : 'ies'}` };
  }
  if (to === 'FAILED' && !ctx.message?.trim()) {
    return { ok: false, reason: 'A failure reason is required' };
  }
  return { ok: true };
}
