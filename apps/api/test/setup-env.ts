// eslint-disable-next-line @typescript-eslint/no-require-imports
const { testDatabaseUrl } = require('./test-env');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl();
process.env.JWT_SECRET = 'e2e-test-secret-that-is-definitely-longer-than-32-chars';
process.env.JWT_EXPIRES_IN = '1h';
process.env.CORS_ORIGINS = 'http://localhost:5173';
// Lets each test login present its own client IP (X-Forwarded-For) so suites don't share one login rate-limit bucket.
process.env.TRUST_PROXY = '1';
process.env.OPENAI_API_KEY = '';
process.env.OPENAI_MODEL = '';
// Keep e2e scans inline — do not depend on a live Redis for connector tests.
process.env.REDIS_URL = '';
