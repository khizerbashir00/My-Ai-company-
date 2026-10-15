# Phase 1 milestone report

**Scope:** project scaffolding, authentication, database setup, CEO dashboard, departments and agent definitions, task creation and status tracking.
**Result:** complete and verified. Date: 15 Oct 2026.

## Features implemented

- **Monorepo** with npm workspaces: `apps/api` (NestJS 11) and `apps/web` (React 19 + Vite 8 + Tailwind 4).
- **Database**: Prisma 7 schema with all 23 tables from the brief (plus enums, foreign keys, indexes, uniqueness constraints), one initial migration, idempotent seed for departments, the 15 agent roles and the CEO account.
- **Auth & security**: bcrypt passwords, httpOnly `SameSite=Strict` JWT cookie, global auth guard (deny by default), roles CEO/ADMIN/VIEWER, rate limits (120/min; 5/min for login and password change), timing-safe login, strict input validation (unknown fields rejected), safe error responses with request IDs, Helmet headers, configurable proxy trust, append-only audit log with secret redaction, immediate lockout of deactivated users.
- **Agents**: General Manager → Sales Manager (6 workers) and Marketing Manager (6 workers) as configurable definitions. Server-side tool/permission registry with no shell/filesystem/SQL tools; human-only permissions; approval-locked sensitive actions; CEO-only edits with audit trail.
- **Tasks**: explicit state machine (queued, running, awaiting approval, completed, failed, cancelled), retry limits, dependencies, subtasks, cascading cancellation, compare-and-set transitions, idempotency keys, full event history, filters/search/sort/pagination.
- **Dashboard**: every metric counted from the database with a written definition; date range and lead-source filters; "Needs you" row for approvals, waiting and failed work and missing AI configuration.
- **Live updates** over Server-Sent Events.
- **UI**: Overview, Tasks (list + detail + create/edit), Organization chart, Agent configuration, Settings (AI status, sources, password). Responsive to 390px, keyboard focus states, dark mode, reduced-motion respected.

## Commands executed (verification)

```
npm run typecheck                    # API + web: clean
npm test                             # 2 suites, 32 tests passed
npm run test:e2e                     # 5 suites, 36 tests passed (real PostgreSQL)
npm run build                        # API + web production builds
npm run test:ui                      # Playwright: 6 tests passed (Chromium)
npm audit --omit=dev                 # 0 vulnerabilities
docker compose config -q             # compose file valid
```

## Test coverage highlights

- Unit: every state-machine edge and guard; registry safety (no dangerous tools, approval locks, human-only permissions); every seeded agent's tools/permissions are consistent.
- API e2e: 401 on every protected route; generic login errors with masked audit entries; cookie flags; viewer is read-only; deactivated users locked out; unknown fields/IDs rejected without leaking internals; secrets absent from status endpoint; login rate limit returns 429; org chart shape; permission rules enforced (including forced approval and GM unable to gain `permissions.manage`); full task lifecycle, retry limit, dependency blocking, cascading cancel, concurrent transition conflict, idempotent creation; listing filters/sort/pagination; dashboard numbers match inserted records exactly, including date and source filters; SSE delivers events only to authenticated clients.
- Browser: login failure/success/redirect/logout, honest empty dashboard, creating and driving a task through the state machine, filters and search, live update from another tab, org chart and saving an agent role.

## Decisions worth knowing

- **NestJS 11, TypeScript 5.9** instead of the newest majors: Nest 12 is ESM-only, which breaks the Jest + Supertest setup. Both pinned versions are maintained.
- **Prisma 7 + `pg` driver adapter**: the client has no native engine. A small fallback script (`npm run db:offline`) runs Prisma's official WASM schema engine for migrations on networks that block Prisma's binary download — it was needed in this build environment and is optional for you.
- **Sessions are stateless JWTs**: logout clears the cookie, but a copied cookie stays valid until it expires (default 8h). Server-side revocation is listed below.

## Missing credentials / configuration

- `OPENAI_API_KEY`, `OPENAI_MODEL`, optional `OPENAI_MODEL_ADVANCED` — needed for Phase 2.
- No lead-source platform credentials yet — Phase 4.
- No email provider — needed for optional email notifications and sending outreach.

## Known limitations

- No AI execution yet: tasks move only when you change them. Managers and workers start working in Phase 2.
- Leads, outreach, campaigns, approvals, notifications and projects have tables but no screens or endpoints yet (Phases 3–5). Their dashboard numbers are real zeros.
- "Demo requests" and "Interested" are based on each lead's current stage; stage history arrives with lead management in Phase 3.
- Session revocation (e.g. a `session_version` on users) is not implemented.
- Only one user can be created (by the seed); user management UI is not built.
- Docker Compose covers Postgres and Redis for local development. It validated but could not be started in the build environment (no Docker daemon there). Containerized API/web and VPS deployment are Phase 6.
- Dev-only tooling (Jest, Nest CLI) has advisories in transitive packages; production dependencies audit clean.

## Next steps (Phase 2)

1. AI provider interface + OpenAI implementation (official SDK, Responses API, structured outputs validated with zod, retries/backoff, token limits, usage records).
2. Settings: choose routine/advanced models from the UI (key stays in env).
3. General Manager orchestration: goal → plan shown to the CEO → department tasks; managers → worker tasks; result collection, retry within limits, escalation.
4. Tool execution layer that checks the registry and agent permissions on every call, logs `agent_runs` / `tool_calls`, and turns approval-locked calls into approval requests.
5. Worker output schemas and manager review step.
