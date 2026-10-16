import type { LeadStage } from '../generated/prisma/client';

export const LEAD_STAGES: LeadStage[] = [
  'NEW',
  'QUALIFIED',
  'DRAFT_READY',
  'AWAITING_APPROVAL',
  'CONTACTED',
  'REPLIED',
  'INTERESTED',
  'DEMO_REQUESTED',
  'DEMO_COMPLETED',
  'NEGOTIATION',
  'WON',
  'LOST',
  'DO_NOT_CONTACT',
];

/** Allowed manual transitions. Terminal stages only leave via explicit reopen rules. */
const EDGES: Record<LeadStage, LeadStage[]> = {
  NEW: ['QUALIFIED', 'DRAFT_READY', 'LOST', 'DO_NOT_CONTACT'],
  QUALIFIED: ['DRAFT_READY', 'AWAITING_APPROVAL', 'CONTACTED', 'LOST', 'DO_NOT_CONTACT', 'NEW'],
  DRAFT_READY: ['AWAITING_APPROVAL', 'CONTACTED', 'QUALIFIED', 'LOST', 'DO_NOT_CONTACT'],
  AWAITING_APPROVAL: ['DRAFT_READY', 'CONTACTED', 'LOST', 'DO_NOT_CONTACT'],
  CONTACTED: ['REPLIED', 'INTERESTED', 'DEMO_REQUESTED', 'LOST', 'DO_NOT_CONTACT'],
  REPLIED: ['INTERESTED', 'DEMO_REQUESTED', 'CONTACTED', 'LOST', 'DO_NOT_CONTACT'],
  INTERESTED: ['DEMO_REQUESTED', 'DEMO_COMPLETED', 'NEGOTIATION', 'LOST', 'DO_NOT_CONTACT'],
  DEMO_REQUESTED: ['DEMO_COMPLETED', 'NEGOTIATION', 'INTERESTED', 'LOST', 'DO_NOT_CONTACT'],
  DEMO_COMPLETED: ['NEGOTIATION', 'WON', 'LOST', 'DO_NOT_CONTACT'],
  NEGOTIATION: ['WON', 'LOST', 'DEMO_COMPLETED', 'DO_NOT_CONTACT'],
  WON: [],
  LOST: ['NEW', 'QUALIFIED'],
  DO_NOT_CONTACT: [],
};

export function canTransitionStage(from: LeadStage, to: LeadStage): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: false, reason: 'Lead is already in that stage.' };
  const allowed = EDGES[from];
  if (!allowed.includes(to)) {
    return { ok: false, reason: `Cannot move from ${from.replace(/_/g, ' ').toLowerCase()} to ${to.replace(/_/g, ' ').toLowerCase()}.` };
  }
  return { ok: true };
}
