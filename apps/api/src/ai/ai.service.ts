import { Inject, Injectable } from '@nestjs/common';
import type { ModelTier } from '../generated/prisma/client';
import { AppConfigService } from '../config/app-config.service';
import { AiCredentialsError } from './ai.errors';
import { AI_PROVIDER, type AiCompletionResult, type AiMessage, type AiProvider } from './ai.types';
import type { z } from 'zod';

export interface StructuredCallOptions<T> {
  tier: ModelTier;
  modelOverride?: string | null;
  maxOutputTokens: number;
  schema: z.ZodType<T>;
  schemaName: string;
  messages: AiMessage[];
  signal?: AbortSignal;
  temperature?: number;
}

@Injectable()
export class AiService {
  constructor(
    private readonly config: AppConfigService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  /** Non-secret readiness check used by orchestration before claiming a task. */
  assertReady(): void {
    if (!this.config.aiReady) {
      throw new AiCredentialsError();
    }
  }

  get status() {
    return this.config.aiStatus;
  }

  async completeStructured<T>(opts: StructuredCallOptions<T>): Promise<AiCompletionResult<T>> {
    this.assertReady();
    const model = this.config.resolveModel(opts.tier, opts.modelOverride);
    if (!model) throw new AiCredentialsError('AI model is not configured. Set OPENAI_MODEL on the server.');

    return this.provider.completeStructured({
      model,
      messages: opts.messages,
      schema: opts.schema,
      schemaName: opts.schemaName,
      maxOutputTokens: opts.maxOutputTokens,
      signal: opts.signal,
      temperature: opts.temperature,
    });
  }
}
