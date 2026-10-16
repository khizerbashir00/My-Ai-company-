import type { IntentLabel } from '../generated/prisma/client';

/** Documented, versioned rubric for lead qualification (0–100). */
export const SCORING_RUBRIC_VERSION = '1.0';

export interface RubricCriterion {
  key: string;
  label: string;
  max: number;
  description: string;
}

export const SCORING_CRITERIA: RubricCriterion[] = [
  {
    key: 'buying_intent',
    label: 'Explicit buying intent',
    max: 25,
    description: 'Prospect explicitly asks for a website, web app, React, e-commerce, MVP or similar development work.',
  },
  {
    key: 'relevance',
    label: 'Relevance to our services',
    max: 20,
    description: 'Fit with website development, React, full-stack, e-commerce or custom software services.',
  },
  {
    key: 'specificity',
    label: 'Project specificity',
    max: 20,
    description: 'Clear requirements, scope hints, or concrete deliverables (not a vague “need a developer”).',
  },
  {
    key: 'recency',
    label: 'Recency',
    max: 15,
    description: 'How recent the original post/listing is. Newer requests score higher.',
  },
  {
    key: 'budget',
    label: 'Stated budget',
    max: 10,
    description: 'Budget only when the prospect stated it explicitly — never estimated.',
  },
  {
    key: 'evidence',
    label: 'Evidence of real need',
    max: 10,
    description: 'Credible business context, company presence, or detailed problem description with a source URL.',
  },
];

export const RUBRIC_MAX_SCORE = SCORING_CRITERIA.reduce((sum, c) => sum + c.max, 0);

export type CriterionScore = { key: string; score: number; reason: string };

export function labelForScore(score: number): IntentLabel {
  if (score >= 75) return 'HIGH';
  if (score >= 50) return 'MEDIUM';
  if (score >= 25) return 'LOW';
  return 'NEEDS_REVIEW';
}

export function validateCriterionScores(input: CriterionScore[]): { ok: true; total: number; reasons: CriterionScore[] } | { ok: false; error: string } {
  const byKey = new Map(SCORING_CRITERIA.map((c) => [c.key, c]));
  const seen = new Set<string>();
  let total = 0;
  const reasons: CriterionScore[] = [];

  for (const row of input) {
    const def = byKey.get(row.key);
    if (!def) return { ok: false, error: `Unknown rubric criterion "${row.key}".` };
    if (seen.has(row.key)) return { ok: false, error: `Duplicate criterion "${row.key}".` };
    if (!Number.isInteger(row.score) || row.score < 0 || row.score > def.max) {
      return { ok: false, error: `Criterion "${row.key}" score must be an integer from 0 to ${def.max}.` };
    }
    if (!row.reason?.trim()) return { ok: false, error: `Criterion "${row.key}" needs a reason.` };
    seen.add(row.key);
    total += row.score;
    reasons.push({ key: row.key, score: row.score, reason: row.reason.trim().slice(0, 500) });
  }

  for (const c of SCORING_CRITERIA) {
    if (!seen.has(c.key)) return { ok: false, error: `Missing criterion "${c.key}".` };
  }

  return { ok: true, total, reasons };
}

export function rubricPublicView() {
  return {
    version: SCORING_RUBRIC_VERSION,
    maxScore: RUBRIC_MAX_SCORE,
    criteria: SCORING_CRITERIA,
    labels: {
      HIGH: '75–100 — prioritize; not a purchase prediction',
      MEDIUM: '50–74 — worth a personalized draft',
      LOW: '25–49 — low priority',
      NEEDS_REVIEW: '0–24 — needs human review',
    },
  };
}
