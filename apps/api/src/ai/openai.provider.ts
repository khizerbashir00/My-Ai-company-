import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { AppConfigService } from '../config/app-config.service';
import { AiCancelledError, AiCredentialsError, AiOutputValidationError, AiProviderError } from './ai.errors';
import type { AiCompletionResult, AiProvider, AiStructuredRequest } from './ai.types';

@Injectable()
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  private readonly logger = new Logger(OpenAiProvider.name);

  constructor(private readonly config: AppConfigService) {}

  async completeStructured<T>(req: AiStructuredRequest<T>): Promise<AiCompletionResult<T>> {
    const apiKey = this.config.openaiApiKey;
    if (!apiKey) throw new AiCredentialsError();
    if (!req.model?.trim()) throw new AiCredentialsError('AI model is not configured. Set OPENAI_MODEL on the server.');

    if (req.signal?.aborted) throw new AiCancelledError();

    const client = new OpenAI({ apiKey, timeout: 55_000, maxRetries: 1 });

    try {
      const response = await client.responses.parse(
        {
          model: req.model,
          temperature: req.temperature ?? 0.2,
          max_output_tokens: req.maxOutputTokens,
          input: req.messages.map((m) => ({ role: m.role, content: m.content })),
          text: { format: zodTextFormat(req.schema, req.schemaName) },
        },
        { signal: req.signal },
      );

      const parsed = response.output_parsed;
      if (parsed == null) {
        throw new AiOutputValidationError('Model returned no structured output.');
      }

      // Re-validate with our Zod schema in case the helper's parse is loose.
      const checked = req.schema.safeParse(parsed);
      if (!checked.success) {
        throw new AiOutputValidationError('Model output failed schema validation.', checked.error.flatten());
      }

      const usage = response.usage;
      return {
        data: checked.data,
        model: response.model || req.model,
        provider: 'openai',
        usage: {
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          totalTokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        },
        rawText: response.output_text ?? '',
      };
    } catch (err) {
      throw mapProviderError(err, this.logger);
    }
  }
}

function mapProviderError(err: unknown, logger: Logger): Error {
  if (
    err instanceof AiCredentialsError ||
    err instanceof AiOutputValidationError ||
    err instanceof AiCancelledError ||
    err instanceof AiProviderError
  ) {
    return err;
  }

  if (err instanceof OpenAI.APIUserAbortError) {
    return new AiCancelledError('AI request was aborted.');
  }

  if (isAbortError(err)) {
    return new AiCancelledError('AI request timed out or was cancelled.');
  }

  if (err instanceof OpenAI.AuthenticationError) {
    // Do not echo provider body — it can mention keys.
    return new AiCredentialsError('AI provider rejected the server credentials. Check OPENAI_API_KEY.');
  }

  if (err instanceof OpenAI.RateLimitError) {
    return new AiProviderError('AI provider rate limit reached. Try again shortly.', true);
  }

  if (err instanceof OpenAI.APIConnectionError) {
    return new AiProviderError('Could not reach the AI provider. Check network connectivity.', true);
  }

  if (err instanceof OpenAI.APIError) {
    const retryable = err.status === 408 || err.status === 409 || err.status === 429 || (err.status !== undefined && err.status >= 500);
    logger.warn(`OpenAI API error status=${err.status ?? 'n/a'} type=${err.name}`);
    return new AiProviderError(safeProviderMessage(err.message, err.status), retryable);
  }

  logger.warn(`Unexpected AI provider failure: ${err instanceof Error ? err.name : typeof err}`);
  return new AiProviderError('AI provider failed unexpectedly.', true);
}

function safeProviderMessage(message: string | undefined, status: number | undefined): string {
  const base = status ? `AI provider returned HTTP ${status}.` : 'AI provider returned an error.';
  if (!message) return base;
  // Strip anything that looks like a secret fragment.
  if (/sk-[a-zA-Z0-9_-]{10,}|api[_-]?key|bearer\s+/i.test(message)) return base;
  const trimmed = message.replace(/\s+/g, ' ').trim().slice(0, 240);
  return trimmed ? `${base} ${trimmed}` : base;
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && (err.name === 'AbortError' || err.message.toLowerCase().includes('aborted'))) ||
    (typeof err === 'object' && err !== null && 'name' in err && (err as { name: string }).name === 'AbortError')
  );
}
