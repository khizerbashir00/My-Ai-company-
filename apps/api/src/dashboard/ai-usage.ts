/**
 * Estimated USD rates per 1M tokens from publicly listed OpenAI prices (approx., Oct 2026).
 * These are ESTIMATES for HQ planning only — not provider invoices or actual billing.
 */
export const ESTIMATED_USD_PER_MILLION: Record<string, { input: number; output: number; source: string }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6, source: 'openai-list-price-estimate' },
  'gpt-4o': { input: 2.5, output: 10, source: 'openai-list-price-estimate' },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, source: 'openai-list-price-estimate' },
  'gpt-4.1': { input: 2, output: 8, source: 'openai-list-price-estimate' },
  'gpt-5-mini': { input: 0.25, output: 2, source: 'openai-list-price-estimate' },
  'gpt-5': { input: 1.25, output: 10, source: 'openai-list-price-estimate' },
  'gpt-test-routine': { input: 0, output: 0, source: 'test-fixture-zero' },
  'gpt-test-advanced': { input: 0, output: 0, source: 'test-fixture-zero' },
};

export function estimateUsd(model: string, inputTokens: number, outputTokens: number): {
  estimatedUsd: number | null;
  kind: 'ESTIMATE' | 'UNAVAILABLE';
  rateSource: string | null;
} {
  const key = Object.keys(ESTIMATED_USD_PER_MILLION).find((k) => model.toLowerCase().includes(k.toLowerCase()));
  if (!key) {
    return { estimatedUsd: null, kind: 'UNAVAILABLE', rateSource: null };
  }
  const rates = ESTIMATED_USD_PER_MILLION[key]!;
  const usd = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
  return { estimatedUsd: Math.round(usd * 1_000_000) / 1_000_000, kind: 'ESTIMATE', rateSource: rates.source };
}
