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

  /** ConfigService can hand back raw env strings, so blank values are normalized to null here. */
  private optional(key: 'OPENAI_API_KEY' | 'OPENAI_MODEL' | 'OPENAI_MODEL_ADVANCED' | 'REDIS_URL'): string | null {
    const v = this.config.get(key, { infer: true }) as string | undefined;
    return v && v.trim() ? v.trim() : null;
  }
}
