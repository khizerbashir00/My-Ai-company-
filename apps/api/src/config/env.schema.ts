import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /** Number of reverse-proxy hops to trust for client IPs (1 behind Nginx/Caddy). Keep 0 when exposed directly. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required').refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must be a PostgreSQL URL'),
  REDIS_URL: optionalString,
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().regex(/^\d+[smhd]$/, 'JWT_EXPIRES_IN must look like 15m, 8h or 7d').default('8h'),
  OPENAI_API_KEY: optionalString,
  /** OpenAI-compatible API root (e.g. https://openrouter.ai/api/v1). Empty = api.openai.com. */
  OPENAI_BASE_URL: optionalString,
  OPENAI_MODEL: optionalString,
  OPENAI_MODEL_ADVANCED: optionalString,
  /** Email provider key. Currently supported: "resend". Empty = outreach send disabled. */
  EMAIL_PROVIDER: optionalString,
  RESEND_API_KEY: optionalString,
  /** Verified sender address authorized by the CEO (must match Resend domain). */
  EMAIL_FROM: optionalString,
  EMAIL_REPLY_TO: optionalString,
  /** Optional webhook signing secret for Resend inbound events. */
  RESEND_WEBHOOK_SECRET: optionalString,
  /** `text` (Nest default) or `json` for structured logs in production. */
  LOG_FORMAT: z.enum(['text', 'json']).default('text'),
  /** Default maxAttempts for newly created tasks (1–10). */
  TASK_DEFAULT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  /** BullMQ scan job attempts when Redis is configured. */
  SCAN_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(2),
  /** Optional daily estimated AI USD budget; CEO notified when exceeded (ESTIMATE only). */
  AI_DAILY_ESTIMATED_USD_BUDGET: z
    .string()
    .optional()
    .transform((v) => {
      if (!v || !v.trim()) return undefined;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    }),
  THROTTLE_TTL_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  THROTTLE_LIMIT: z.coerce.number().int().min(10).max(10_000).default(120),
  /** Graceful shutdown wait for in-flight work (ms). */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
});

export type Env = z.infer<typeof envSchema>;

/** Used by ConfigModule. Fails fast at boot with readable messages — never echoes secret values. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    if (parsed.data.TRUST_PROXY < 1) {
      // Soft warning via throw only if CORS looks like localhost — actually document in checklist.
    }
    if (parsed.data.JWT_SECRET.length < 32) {
      throw new Error('Invalid environment configuration:\n  - JWT_SECRET: must be at least 32 characters in production');
    }
  }
  return parsed.data;
}
