import type { AiCompletionResult, AiProvider, AiStructuredRequest } from './ai.types';
import { AiOutputValidationError, AiProviderError } from './ai.errors';

export type FakeAiHandler = (req: AiStructuredRequest<unknown>) => Promise<AiCompletionResult<unknown>> | AiCompletionResult<unknown>;

/** Deterministic provider for unit/e2e tests. Never talks to the network. */
export class FakeAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  private handler: FakeAiHandler | null = null;
  private queue: unknown[] = [];

  setHandler(handler: FakeAiHandler): void {
    this.handler = handler;
  }

  /** Push pre-built structured objects; each completeStructured call shifts one. */
  enqueue(...outputs: unknown[]): void {
    this.queue.push(...outputs);
  }

  clear(): void {
    this.handler = null;
    this.queue = [];
  }

  async completeStructured<T>(req: AiStructuredRequest<T>): Promise<AiCompletionResult<T>> {
    if (req.signal?.aborted) {
      const { AiCancelledError } = await import('./ai.errors');
      throw new AiCancelledError();
    }
    if (this.handler) {
      const result = await this.handler(req as AiStructuredRequest<unknown>);
      return result as AiCompletionResult<T>;
    }

    const next = this.queue.shift();
    if (next === undefined) {
      throw new AiProviderError('Fake AI provider queue is empty.', false);
    }
    if (next instanceof Error) throw next;

    const parsed = req.schema.safeParse(next);
    if (!parsed.success) {
      throw new AiOutputValidationError('Fake AI output failed schema validation.', parsed.error.flatten());
    }
    return {
      data: parsed.data,
      model: req.model,
      provider: 'openai',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      rawText: JSON.stringify(next),
    };
  }
}
