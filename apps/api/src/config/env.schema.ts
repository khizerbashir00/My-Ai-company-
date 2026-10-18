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
  /** Reddit OAuth app (https://www.reddit.com/prefs/apps). Optional until you enable Reddit scans. */
  REDDIT_CLIENT_ID: optionalString,
  REDDIT_CLIENT_SECRET: optionalString,
  /** Optional user refresh token; when unset, client_credentials is used. */
  REDDIT_REFRESH_TOKEN: optionalString,
  /** Optional custom User-Agent (Reddit requires a descriptive UA). */
  REDDIT_USER_AGENT: optionalString,

  // ── Social OAuth connections ──
  /**
   * Public origin the browser uses for this app (e.g. https://hq.example.com). OAuth redirect URIs are
   * built from it: <PUBLIC_APP_URL>/api/social/<platform>/callback. Defaults to the first CORS origin.
   */
  PUBLIC_APP_URL: optionalString.refine((v) => v === undefined || /^https?:\/\/[^/]+$/.test(v), {
    message: 'PUBLIC_APP_URL must be an origin like https://hq.example.com (no path, no trailing slash)',
  }),
  /** 32-byte key, base64 (openssl rand -base64 32). Encrypts OAuth tokens at rest. Required in production. */
  TOKEN_ENCRYPTION_KEY: optionalString.refine((v) => v === undefined || Buffer.from(v, 'base64').length === 32, {
    message: 'TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)',
  }),
  LINKEDIN_CLIENT_ID: optionalString,
  LINKEDIN_CLIENT_SECRET: optionalString,
  /** Space-separated. Default: openid profile email w_member_social */
  LINKEDIN_SCOPES: optionalString,
  FACEBOOK_APP_ID: optionalString,
  FACEBOOK_APP_SECRET: optionalString,
  /** Graph API version, e.g. v26.0 */
  FACEBOOK_GRAPH_VERSION: optionalString.refine((v) => v === undefined || /^v\d+\.\d+$/.test(v), {
    message: 'FACEBOOK_GRAPH_VERSION must look like v26.0',
  }),
  /** Comma-separated. Default: public_profile,pages_show_list,pages_read_engagement,pages_manage_posts */
  FACEBOOK_SCOPES: optionalString,
  /** Space-separated. Default: identity read submit (Reddit app must be type "web app" for this flow) */
  REDDIT_SCOPES: optionalString,
  X_CLIENT_ID: optionalString,
  X_CLIENT_SECRET: optionalString,
  /** Space-separated. Default: tweet.read tweet.write users.read offline.access */
  X_SCOPES: optionalString,
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
    const problems: string[] = [];
    if (parsed.data.JWT_SECRET.length < 32) problems.push('JWT_SECRET: must be at least 32 characters in production');
    if (parsed.data.PUBLIC_APP_URL && !parsed.data.PUBLIC_APP_URL.startsWith('https://')) {
      problems.push('PUBLIC_APP_URL: must use https:// in production (OAuth providers reject http redirect URIs)');
    }
    // A missing TOKEN_ENCRYPTION_KEY is not fatal (existing deployments keep booting); social connect
    // stays disabled and the Control Center says why.
    if (problems.length) throw new Error(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return parsed.data;
}
