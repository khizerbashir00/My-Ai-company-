import type { AgentKind, TaskKind, TaskPriority, TaskStatus } from './types';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  AWAITING_APPROVAL: 'Awaiting approval',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

export const STATUS_ORDER: TaskStatus[] = ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'];

/** Mirrors the server's state machine (apps/api/src/tasks/task-state-machine.ts). The server stays the authority. */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['RUNNING', 'FAILED', 'CANCELLED'],
  FAILED: ['QUEUED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** Button wording for each move, phrased as what will happen. */
export function transitionLabel(from: TaskStatus, to: TaskStatus): string {
  if (from === 'FAILED' && to === 'QUEUED') return 'Retry';
  if (from === 'AWAITING_APPROVAL' && to === 'RUNNING') return 'Resume';
  return { QUEUED: 'Queue', RUNNING: 'Start', AWAITING_APPROVAL: 'Hold for approval', COMPLETED: 'Mark completed', FAILED: 'Mark failed', CANCELLED: 'Cancel task' }[to];
}

export const KIND_LABEL: Record<TaskKind, string> = { GOAL: 'Goal', DEPARTMENT_TASK: 'Department task', WORKER_TASK: 'Worker task' };
export const PRIORITY_LABEL: Record<TaskPriority, string> = { LOW: 'Low', NORMAL: 'Normal', HIGH: 'High', URGENT: 'Urgent' };
export const AGENT_KIND_LABEL: Record<AgentKind, string> = { GENERAL_MANAGER: 'General manager', MANAGER: 'Manager', WORKER: 'Worker' };

export const STAGE_LABEL: Record<string, string> = {
  NEW: 'New',
  QUALIFIED: 'Qualified',
  DRAFT_READY: 'Draft ready',
  AWAITING_APPROVAL: 'Awaiting approval',
  CONTACTED: 'Contacted',
  REPLIED: 'Replied',
  INTERESTED: 'Interested',
  DEMO_REQUESTED: 'Demo requested',
  DEMO_COMPLETED: 'Demo completed',
  NEGOTIATION: 'Negotiation',
  WON: 'Won',
  LOST: 'Lost',
  DO_NOT_CONTACT: 'Do not contact',
};

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function timeAgo(iso: string): string {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return formatDate(iso);
}

export function formatDate(iso: string, withTime = false): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime && { hour: '2-digit', minute: '2-digit' }),
  });
}

export function formatMoney(amount: string, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}

export const formatInt = (n: number) => new Intl.NumberFormat('en-US').format(n);
