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
});

export type Env = z.infer<typeof envSchema>;

/** Used by ConfigModule. Fails fast at boot with readable messages — never echoes secret values. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
