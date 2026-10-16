import { z } from 'zod';
import type { ReplyClassification } from '../generated/prisma/client';
import type { AiProvider } from '../ai/ai.types';

export const replyClassificationSchema = z.object({
  classification: z.enum(['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'UNSUBSCRIBE', 'DEMO_REQUEST', 'NEEDS_REVIEW']),
  reason: z.string().max(500),
  /** Must stay false — classifier must not invent commitments or pricing. */
  inventsCommitmentOrPricing: z.boolean(),
});

export type ReplyClassificationResult = z.infer<typeof replyClassificationSchema>;

const KEYWORD_RULES: Array<{ re: RegExp; classification: ReplyClassification; reason: string }> = [
  { re: /\b(unsubscribe|opt[\s-]?out|remove me|stop emailing|do not contact)\b/i, classification: 'UNSUBSCRIBE', reason: 'Explicit opt-out language' },
  { re: /\b(book a (demo|call)|schedule a (demo|call)|demo please|available for a (demo|call))\b/i, classification: 'DEMO_REQUEST', reason: 'Demo/call request language' },
  { re: /\b(not interested|no thanks|pass|don't contact)\b/i, classification: 'NEGATIVE', reason: 'Negative interest language' },
  { re: /\b(interested|sounds good|let'?s talk|tell me more|pricing\?)\b/i, classification: 'POSITIVE', reason: 'Positive interest language' },
];

/** Deterministic fallback when AI is unavailable. Never invents commitments. */
export function classifyReplyHeuristic(text: string): ReplyClassificationResult {
  const body = text.trim();
  if (!body) return { classification: 'NEEDS_REVIEW', reason: 'Empty reply body', inventsCommitmentOrPricing: false };
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(body)) {
      return { classification: rule.classification, reason: rule.reason, inventsCommitmentOrPricing: false };
    }
  }
  return { classification: 'NEUTRAL', reason: 'No strong intent keywords detected', inventsCommitmentOrPricing: false };
}

export async function classifyReplyWithAi(
  ai: AiProvider | null,
  model: string | null,
  text: string,
): Promise<ReplyClassificationResult> {
  const fallback = classifyReplyHeuristic(text);
  if (!ai || !model) return fallback;

  try {
    const result = await ai.completeStructured({
      model,
      schemaName: 'reply_classification',
      schema: replyClassificationSchema,
      maxOutputTokens: 400,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: [
            'Classify an inbound sales email reply.',
            'Labels: POSITIVE, NEGATIVE, NEUTRAL, UNSUBSCRIBE, DEMO_REQUEST, NEEDS_REVIEW.',
            'Never invent pricing, contracts, or commitments. Set inventsCommitmentOrPricing=true if the reply itself makes a binding commitment claim that would require CEO review — still classify the intent, do not invent one.',
            'If unsure, use NEEDS_REVIEW.',
          ].join(' '),
        },
        { role: 'user', content: text.slice(0, 4000) },
      ],
    });
    if (result.data.inventsCommitmentOrPricing) {
      return {
        classification: 'NEEDS_REVIEW',
        reason: `${result.data.reason} (flagged for possible commitment language — CEO review required)`,
        inventsCommitmentOrPricing: true,
      };
    }
    return result.data;
  } catch {
    return fallback;
  }
}
