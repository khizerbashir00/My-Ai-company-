# HQ — AI Automation Company

A control platform where you are the CEO and AI managers run Sales and Marketing for your web development business. You assign goals, AI managers delegate to AI workers, and you review, approve and close deals. Software development after a deal is confirmed stays with you.

**Status:** Feature phases through dashboard/notifications are implemented. **Production deployment** instructions: [`docs/deploy/production.md`](docs/deploy/production.md). Architecture: [`docs/architecture.md`](docs/architecture.md).

## What works today

- Sign in as CEO (httpOnly session cookie, rate-limited login, audit trail)
- Overview dashboard computed only from database records, with date range and lead-source filters
- Organization chart: General Manager → Sales and Marketing managers → 12 workers
- Edit any role's instructions, model tier, token limit, tools and permissions — validated against a server-side registry, with sensitive actions locked behind your approval
- Create tasks, goals and subtasks; track them through an explicit state machine with retries, dependencies, cascading cancellation and full history
- Live updates in the browser via Server-Sent Events

With `OPENAI_API_KEY` and `OPENAI_MODEL` set, use **Run with AI** on a queued goal or department task to plan and delegate. Use **Leads** for manual CRM, CSV import/export, scoring, pipeline, and outreach drafts (sending and live connectors arrive later).

## Stack

| Layer | Choice |
| --- | --- |
| Web | React 19, Vite 8, TypeScript, Tailwind CSS 4, TanStack Query, React Router 7 |
| API | NestJS 11, TypeScript, REST + SSE |
| Data | PostgreSQL 16, Prisma 7 (with `@prisma/adapter-pg`) |
| Jobs | Redis + BullMQ (Phase 4) |
| AI | OpenAI official SDK (Phase 2) |
| Tests | Jest, Supertest, Playwright |

NestJS 11 is used rather than 12 because Nest 12 is ESM-only, which makes the Jest + Supertest stack fragile; 11 is still maintained. TypeScript is pinned to 5.9 for the same reason.

## Run it locally

Requirements: Node.js 20.11+ (22 recommended), PostgreSQL 16 and Redis 7 — either installed locally or via Docker.

```bash
# 1. Install
npm install

# 2. Start Postgres + Redis (skip if you run them yourself)
docker compose up -d

# 3. Configure the API
cp .env.example apps/api/.env
#   Fill in DATABASE_URL, TEST_DATABASE_URL, JWT_SECRET (openssl rand -base64 48),
#   CEO_EMAIL, CEO_NAME, CEO_PASSWORD (12+ characters).
#   With the docker compose defaults the URLs are:
#   postgresql://ai_company:local_dev_only@localhost:5432/ai_company?schema=public
#   postgresql://ai_company:local_dev_only@localhost:5432/ai_company_test?schema=public

# 4. Create tables and the default organization + your CEO account
npm run db:generate -w apps/api
npm run db:deploy -w apps/api
npm run db:seed

# 5. Run (two terminals)
npm run dev:api     # http://localhost:3000/api
npm run dev:web     # http://localhost:5173  ← open this
```

The web app calls `/api` on its own origin; Vite proxies it to the API in development. In production, use `docker-compose.prod.yml` + Caddy (see [`docs/deploy/production.md`](docs/deploy/production.md)).

### If Prisma can't download its engine

`prisma migrate` downloads a native schema engine from `binaries.prisma.sh`. On networks that block it, use the bundled fallback, which runs Prisma's official WASM engine through the same Postgres driver the app uses:

```bash
npm run db:offline -w apps/api -- deploy          # apply migrations
npm run db:offline -w apps/api -- create <name>   # new migration from schema changes
PRISMA_SCHEMA_ENGINE_BINARY=/bin/true npx prisma generate   # (from apps/api) generate without the download
```

Both paths read and write the same `prisma/migrations` folder and `_prisma_migrations` table.

## Tests

```bash
npm run typecheck                 # API + web
npm test                          # API unit tests (no database)
npm run test:e2e                  # API end-to-end tests against TEST_DATABASE_URL (wiped each run)
npx playwright install chromium   # once
npm run test:ui                   # browser tests: boots its own API on :3100 and web on :5174
```

The e2e and browser suites refuse to run unless the test database name contains `test`.

## Configuration reference

All settings live in `apps/api/.env` (template: [`.env.example`](.env.example)). Secrets never reach the browser — the Settings page only shows whether a key exists.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `TEST_DATABASE_URL` | Separate database for automated tests (wiped) |
| `JWT_SECRET` | 32+ random characters for signing sessions |
| `JWT_EXPIRES_IN` | Session lifetime, e.g. `8h` |
| `TRUST_PROXY` | `1` behind Nginx/Caddy, `0` when the API is exposed directly |
| `CORS_ORIGINS` | Allowed browser origins |
| `CEO_EMAIL`, `CEO_NAME`, `CEO_PASSWORD` | Used once by `db:seed` to create your account |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_MODEL_ADVANCED` | AI provider (used from Phase 2). Use model IDs your OpenAI project can access |
| `REDIS_URL` | Background jobs (from Phase 4) |

## Repository layout

```
apps/api      NestJS API, Prisma schema + migrations, seed, e2e tests
apps/web      React dashboard, Playwright tests
docs/         Architecture notes and milestone reports
docker/       Local Postgres init scripts
```
