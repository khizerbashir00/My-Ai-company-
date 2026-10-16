import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/** Typed accessors over validated env. Secrets are exposed only to server code, never serialized. */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get nodeEnv(): Env['NODE_ENV'] {
    return this.config.get('NODE_ENV', { infer: true });
  }
  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }
  get port(): number {
    return this.config.get('PORT', { infer: true });
  }
  get corsOrigins(): string[] {
    return this.config
      .get('CORS_ORIGINS', { infer: true })
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  get trustProxy(): number {
    return this.config.get('TRUST_PROXY', { infer: true });
  }
  get databaseUrl(): string {
    return this.config.get('DATABASE_URL', { infer: true });
  }
  get jwtSecret(): string {
    return this.config.get('JWT_SECRET', { infer: true });
  }
  get jwtExpiresIn(): string {
    return this.config.get('JWT_EXPIRES_IN', { infer: true });
  }
  /** Non-secret view of AI configuration for the UI (whether a key exists, never its value). */
  get aiStatus(): { provider: 'openai'; apiKeyConfigured: boolean; routineModel: string | null; advancedModel: string | null } {
    const routine = this.optional('OPENAI_MODEL');
    return {
      provider: 'openai',
      apiKeyConfigured: this.optional('OPENAI_API_KEY') !== null,
      routineModel: routine,
      advancedModel: this.optional('OPENAI_MODEL_ADVANCED') ?? routine,
    };
  }

  /** True when the server can call the AI provider (key + at least one model name). Never includes secrets. */
  get aiReady(): boolean {
    return this.aiStatus.apiKeyConfigured && this.aiStatus.routineModel !== null;
  }

  /** Server-only. Do not put on responses, logs, or audit payloads. */
  get openaiApiKey(): string | null {
    return this.optional('OPENAI_API_KEY');
  }

  /** Redis connection string for BullMQ. Null when background jobs are unavailable. */
  get redisUrl(): string | null {
    return this.optional('REDIS_URL');
  }

  /** Non-secret email provider status for Settings / Approvals UI. */
  get emailStatus(): {
    provider: string | null;
    configured: boolean;
    fromAddress: string | null;
    replyTo: string | null;
    inboundWebhookConfigured: boolean;
  } {
    const provider = this.optional('EMAIL_PROVIDER')?.toLowerCase() ?? null;
    const from = this.optional('EMAIL_FROM');
    const apiKey = provider === 'resend' ? this.optional('RESEND_API_KEY') : null;
    return {
      provider,
      configured: provider === 'resend' && Boolean(apiKey && from),
      fromAddress: from,
      replyTo: this.optional('EMAIL_REPLY_TO'),
      inboundWebhookConfigured: Boolean(this.optional('RESEND_WEBHOOK_SECRET')),
    };
  }

  get resendApiKey(): string | null {
    return this.optional('RESEND_API_KEY');
  }
  get emailFrom(): string | null {
    return this.optional('EMAIL_FROM');
  }
  get emailReplyTo(): string | null {
    return this.optional('EMAIL_REPLY_TO');
  }
  get emailProviderKey(): string | null {
    return this.optional('EMAIL_PROVIDER')?.toLowerCase() ?? null;
  }
  get resendWebhookSecret(): string | null {
    return this.optional('RESEND_WEBHOOK_SECRET');
  }

  /** Resolve the model ID for a tier, with optional per-agent override. */
  resolveModel(tier: 'ROUTINE' | 'ADVANCED', override?: string | null): string | null {
    if (override?.trim()) return override.trim();
    if (tier === 'ADVANCED') {
      return this.optional('OPENAI_MODEL_ADVANCED') ?? this.optional('OPENAI_MODEL');
    }
    return this.optional('OPENAI_MODEL');
  }

  /** ConfigService can hand back raw env strings, so blank values are normalized to null here. */
  private optional(
    key:
      | 'OPENAI_API_KEY'
      | 'OPENAI_MODEL'
      | 'OPENAI_MODEL_ADVANCED'
      | 'REDIS_URL'
      | 'EMAIL_PROVIDER'
      | 'RESEND_API_KEY'
      | 'EMAIL_FROM'
      | 'EMAIL_REPLY_TO'
      | 'RESEND_WEBHOOK_SECRET',
  ): string | null {
    const v = this.config.get(key, { infer: true }) as string | undefined;
    return v && v.trim() ? v.trim() : null;
  }
}
