import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { zodResponseFormat, zodTextFormat } from 'openai/helpers/zod';
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

    const baseURL = this.config.openaiBaseUrl ?? undefined;
    const useOpenRouter = Boolean(baseURL?.includes('openrouter.ai'));
    const client = new OpenAI({
      apiKey,
      baseURL,
      timeout: 55_000,
      maxRetries: 1,
      ...(useOpenRouter
        ? {
            defaultHeaders: {
              'HTTP-Referer': 'http://localhost:5173',
              'X-Title': 'AI Company HQ',
            },
          }
        : {}),
    });

    try {
      if (useOpenRouter) {
        // Paid OpenRouter models (gpt-4o-mini etc.) support chat structured outputs.
        // Free :free slugs usually do not — use loose JSON / plain-text coerce for those.
        if (isFreeOpenRouterModel(req.model)) {
          return await this.completeViaChatJsonWithFallback(client, req);
        }
        try {
          return await this.completeViaChatParse(client, req);
        } catch (err) {
          this.logger.warn(
            `OpenRouter structured parse failed for ${req.model}; falling back to JSON coerce: ${err instanceof Error ? err.message.slice(0, 160) : err}`,
          );
          return await this.completeViaChatJson(client, req);
        }
      }
      return await this.completeViaResponses(client, req);
    } catch (err) {
      throw mapProviderError(err, this.logger);
    }
  }

  /** Official JSON-schema parse path (works well on gpt-4o-mini via OpenRouter). */
  private async completeViaChatParse<T>(client: OpenAI, req: AiStructuredRequest<T>): Promise<AiCompletionResult<T>> {
    const response = await client.chat.completions.parse(
      {
        model: req.model,
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxOutputTokens,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        response_format: zodResponseFormat(req.schema, req.schemaName),
      },
      { signal: req.signal },
    );

    const message = response.choices[0]?.message;
    const parsed = message?.parsed;
    if (parsed == null) {
      const raw = message?.content?.trim() ?? '';
      const coerced = coerceToSchema(req.schema, raw);
      if (coerced != null) {
        return {
          data: coerced,
          model: response.model || req.model,
          provider: 'openai',
          usage: {
            inputTokens: response.usage?.prompt_tokens ?? 0,
            outputTokens: response.usage?.completion_tokens ?? 0,
            totalTokens: response.usage?.total_tokens ?? 0,
          },
          rawText: raw,
        };
      }
      throw new AiOutputValidationError('Model returned no structured output.');
    }

    const checked = req.schema.safeParse(parsed);
    if (!checked.success) {
      throw new AiOutputValidationError('Model output failed schema validation.', checked.error.flatten());
    }

    return {
      data: checked.data,
      model: response.model || req.model,
      provider: 'openai',
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
      rawText: message?.content ?? '',
    };
  }

  /** Try primary model, then other free OpenRouter slugs on 404 / rate-limit. */
  private async completeViaChatJsonWithFallback<T>(
    client: OpenAI,
    req: AiStructuredRequest<T>,
  ): Promise<AiCompletionResult<T>> {
    const advanced = this.config.aiStatus.advancedModel;
    const candidates = uniqueModels([
      req.model,
      advanced,
      'liquid/lfm-2.5-2.6b:free',
      'google/gemma-4-26b-a4b-it:free',
      'google/gemma-4-31b-it:free',
      'poolside/laguna-xs-2.1:free',
      'openrouter/free',
    ]);

    let lastErr: unknown;
    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i]!;
      try {
        return await this.completeViaChatJson(client, { ...req, model });
      } catch (err) {
        lastErr = err;
        if (err instanceof OpenAI.RateLimitError && i < candidates.length - 1) {
          this.logger.warn(`OpenRouter rate-limited on ${model}; trying next free model…`);
          await sleep(1200);
          continue;
        }
        if (err instanceof OpenAI.APIError && err.status === 404 && i < candidates.length - 1) {
          this.logger.warn(`OpenRouter model unavailable ${model}; trying next free model…`);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  private async completeViaResponses<T>(client: OpenAI, req: AiStructuredRequest<T>): Promise<AiCompletionResult<T>> {
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
  }

  /**
   * Plain Chat Completions + best-effort JSON extraction.
   * Avoids openai SDK `.parse()` / json_schema (many free OpenRouter models return invalid structured JSON).
   */
  private async completeViaChatJson<T>(client: OpenAI, req: AiStructuredRequest<T>): Promise<AiCompletionResult<T>> {
    const plainReply = req.schemaName === 'team_message_reply';
    const messages = [
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      plainReply
        ? {
            role: 'user' as const,
            content: 'Write only your reply message to the CEO as plain text. No JSON, no markdown fences.',
          }
        : {
            role: 'user' as const,
            content:
              `Respond with ONLY a single JSON object for schema "${req.schemaName}". ` +
              `No markdown fences, no commentary. ` +
              `If the schema is a message reply, use exactly: {"reply":"<your reply text>"}`,
          },
    ];

    const response = await client.chat.completions.create(
      {
        model: req.model,
        temperature: req.temperature ?? 0.2,
        max_tokens: Math.min(req.maxOutputTokens, plainReply ? 800 : req.maxOutputTokens),
        messages,
      },
      { signal: req.signal },
    );

    const raw = response.choices[0]?.message?.content?.trim() ?? '';
    if (!raw) {
      throw new AiOutputValidationError('Model returned empty content.');
    }

    const data = coerceToSchema(req.schema, raw);
    if (data == null) {
      this.logger.warn(`OpenRouter JSON coerce failed schema=${req.schemaName} preview=${raw.slice(0, 120)}`);
      throw new AiOutputValidationError('Model returned no structured output.');
    }

    return {
      data,
      model: response.model || req.model,
      provider: 'openai',
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
      rawText: raw,
    };
  }
}

function isFreeOpenRouterModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m === 'openrouter/free' || m.endsWith(':free');
}

function uniqueModels(models: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    const v = m?.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse JSON, or treat free-form text as { reply: text } when the schema allows it. */
function coerceToSchema<T>(schema: AiStructuredRequest<T>['schema'], raw: string): T | null {
  const cleaned = stripCodeFences(raw);
  const parsed = tryParseJson(cleaned);
  if (parsed != null) {
    const checked = schema.safeParse(parsed);
    if (checked.success) return checked.data;
    // Common shape: model returned a bare string field under another key
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['reply', 'message', 'content', 'text', 'response']) {
        if (typeof obj[key] === 'string') {
          const asReply = schema.safeParse({ reply: obj[key] });
          if (asReply.success) return asReply.data;
        }
      }
    }
  }

  // Plain prose fallback for { reply: string } schemas (team chat).
  const asReply = schema.safeParse({ reply: cleaned });
  if (asReply.success) return asReply.data;

  return null;
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : trimmed;
}

function tryParseJson(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
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

  // SDK sometimes throws SyntaxError when structured-output parsing fails
  if (err instanceof SyntaxError || (err instanceof Error && /structured output|JSON/i.test(err.message))) {
    logger.warn(`Structured-output parse failure: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
    return new AiProviderError(
      'AI model returned invalid JSON. Try again, or switch OPENAI_MODEL to a free model that supports chat (e.g. meta-llama/llama-3.2-3b-instruct:free).',
      true,
    );
  }

  const detail = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : typeof err;
  logger.warn(`Unexpected AI provider failure: ${detail}`);
  return new AiProviderError('AI provider failed unexpectedly.', true);
}

function safeProviderMessage(message: string | undefined, status: number | undefined): string {
  const base = status ? `AI provider returned HTTP ${status}.` : 'AI provider returned an error.';
  if (!message) return base;
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
